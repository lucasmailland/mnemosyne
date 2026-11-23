/**
 * `mnemo harness …` — operator commands for the local capture queue.
 *
 * Two audiences with opposite needs share this file, and the difference is the
 * whole design:
 *
 *   - An OPERATOR runs `queue`, `retry`, `discard`, `doctor` and `probe` by hand
 *     or from a script. These must fail loudly, with a non-zero exit, whenever
 *     local state is unsafe — a script's only signal is the exit code.
 *   - A HOST runs `hook` on every turn. It must ALWAYS exit zero. A harness that
 *     can break someone's editor session is worse than one that loses an event,
 *     so failure here is recorded locally and never surfaced.
 *
 * No command ever prints captured content. The queue holds conversations, and
 * these outputs land in terminals, CI logs and pasted issues.
 */

import { en } from "./i18n/en.js";
import { t } from "./i18n/index.js";
export interface QueueRecord {
  eventId: string;
  type: string;
  enqueueSequence: number;
  bytes: number;
  occurredAt: string;
}

export interface HarnessDoctorReport {
  ok: boolean;
  queue: { count: number; bytes: number; oldestAgeSeconds: number | null; deadLetters: number };
  delivery: {
    attempt: number;
    nextAttemptAt: string | null;
    blocked: { status: number; at: string } | null;
  };
  binding: { bound: boolean; serverUrl?: string; workspaceId?: string; installationId?: string };
  filesystem: { mode: string; reasons: string[] };
  capture: { fullFidelity: boolean; reason?: string };
  /** One line per host: the mode capture is really at, and what put it there. */
  hosts?: Array<{ host: string; consented: string | null; mode: string; reason: string }>;
  problems: string[];
}

/**
 * Every effect the commands can have, injected.
 *
 * Keeps dispatch, argument handling and the safety rules testable without a real
 * home directory, a real server, or a real queue.
 */
export interface HarnessCommandDeps {
  out(line: string): void;
  err(line: string): void;
  confirm(prompt: string): Promise<boolean>;
  diagnose(): Promise<HarnessDoctorReport>;
  listQueue(): Promise<{
    pending: Array<QueueRecord & Record<string, unknown>>;
    quarantined: Array<{ id: string; bytes: number }>;
  }>;
  releaseRetry(): Promise<{ released: number; bindingChanged: boolean }>;
  discardQueue(input: { reason: string }): Promise<{ discarded: number }>;
  probe(): Promise<{ available: boolean; workspaceId: string; persisted: boolean }>;
  captureHook(argv: string[]): Promise<{ durable: boolean; reason?: string }>;
}

/** The English help text, exported for tests; the CLI prints `t("harness.help")` (localized). */
export const HARNESS_HELP: string = en.harness.help;

/** Read `--flag value`, or undefined. Only documented flags are consulted. */
function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function describeQueue(deps: HarnessCommandDeps, report: HarnessDoctorReport): void {
  deps.out(
    t("harness.queuePendingBytes", { count: report.queue.count, bytes: report.queue.bytes })
  );
  deps.out(t("harness.oldest", { age: report.queue.oldestAgeSeconds ?? "-" }));
  deps.out(t("harness.deadLetters", { deadLetters: report.queue.deadLetters }));
  deps.out(
    t("harness.delivery", {
      attempt: report.delivery.attempt,
      next: report.delivery.nextAttemptAt
        ? t("harness.deliveryNext", { nextAttemptAt: report.delivery.nextAttemptAt })
        : "",
      blocked: report.delivery.blocked
        ? t("harness.deliveryBlocked", { status: report.delivery.blocked.status })
        : "",
    })
  );
  deps.out(
    report.binding.bound
      ? t("harness.binding", {
          serverUrl: String(report.binding.serverUrl),
          workspaceId: String(report.binding.workspaceId),
        })
      : t("harness.bindingNone")
  );
  deps.out(t("harness.filesystem", { mode: report.filesystem.mode }));
  deps.out(
    t("harness.capture", {
      state: report.capture.fullFidelity ? t("harness.fullFidelity") : t("harness.incomplete"),
    })
  );
  for (const host of report.hosts ?? []) {
    deps.out(t("harness.hostCapture", { host: host.host, mode: host.mode, reason: host.reason }));
  }
}

async function commandQueue(argv: string[], deps: HarnessCommandDeps): Promise<number> {
  if (argv[0] !== undefined && argv[0] !== "list") {
    deps.err(t("harness.unknownQueueSubcommand", { sub: argv[0] }));
    return 2;
  }
  const { pending, quarantined } = await deps.listQueue();
  if (pending.length === 0 && quarantined.length === 0) {
    deps.out(t("harness.queueIsEmptyPending"));
    return 0;
  }
  deps.out(t("harness.queueCounts", { pending: pending.length, quarantined: quarantined.length }));
  for (const record of pending) {
    // Metadata only. `content` is deliberately not read off the record here even
    // though the caller may have it — printing a conversation is the one thing
    // this command must never do.
    deps.out(
      t("harness.pendingSeqB", {
        eventId: record.eventId,
        enqueueSequence: record.enqueueSequence,
        type: record.type,
        bytes: record.bytes,
        occurredAt: record.occurredAt,
      })
    );
  }
  for (const record of quarantined) {
    deps.out(t("harness.deadB", { id: record.id, bytes: record.bytes }));
  }
  return 0;
}

async function commandRetry(deps: HarnessCommandDeps): Promise<number> {
  const { released, bindingChanged } = await deps.releaseRetry();
  if (bindingChanged) {
    // Releasing a queue whose binding moved would deliver one workspace's
    // conversations to another. Refuse and make the operator decide.
    deps.err(t("harness.refusingToRetryThe"));
    return 1;
  }
  deps.out(t("harness.releasedQueuedRecordS", { released }));
  return 0;
}

async function commandDiscard(argv: string[], deps: HarnessCommandDeps): Promise<number> {
  const reason = flag(argv, "reason");
  if (!reason) {
    // The audit entry is the only trace left afterwards; an unexplained discard
    // is indistinguishable from data loss.
    deps.err(t("harness.discardRequiresReasonWhy"));
    return 2;
  }
  if (!argv.includes("--yes")) {
    const proceed = await deps.confirm(t("harness.permanentlyDiscardTheQueued"));
    if (!proceed) {
      deps.err(t("harness.discardCancelled"));
      return 1;
    }
  }
  const { discarded } = await deps.discardQueue({ reason });
  deps.out(t("harness.discardedRecordS", { discarded }));
  return 0;
}

async function commandDoctor(deps: HarnessCommandDeps): Promise<number> {
  const report = await deps.diagnose();
  describeQueue(deps, report);
  if (report.ok) {
    deps.out(t("harness.harnessOk"));
    return 0;
  }
  for (const problem of report.problems) deps.err(t("harness.problem", { problem }));
  return 1;
}

async function commandProbe(deps: HarnessCommandDeps): Promise<number> {
  const result = await deps.probe();
  if (result.persisted) {
    // A probe is a read. If one ever wrote, that is a contract break worth
    // failing on rather than a detail worth hiding.
    deps.err(t("harness.probePersistedStateThis"));
    return 1;
  }
  if (!result.available) {
    deps.err(t("harness.serverIsNotAccepting", { workspaceId: result.workspaceId }));
    return 1;
  }
  deps.out(t("harness.serverAvailableForWorkspace", { workspaceId: result.workspaceId }));
  return 0;
}

/**
 * Host capture. Always exits zero, whatever happened.
 *
 * A non-zero exit here can abort a turn in the host, so every failure — delivery,
 * capacity, unsafe ownership, missing advisory locking, binding mismatch,
 * unwritable audit — is swallowed. The compensating rule is that it also emits no
 * success claim unless the enqueue was durable, so silence never reads as capture.
 */
async function commandHook(argv: string[], deps: HarnessCommandDeps): Promise<number> {
  try {
    const result = await deps.captureHook(argv);
    if (result.durable) deps.out(t("harness.captured"));
  } catch {
    // Deliberately nothing on stdout: the reason belongs in the local audit, not
    // in the host's output where it could carry message text.
  }
  return 0;
}

export async function runHarnessCommand(argv: string[], deps: HarnessCommandDeps): Promise<number> {
  const [subcommand, ...rest] = argv;

  if (subcommand === undefined || subcommand === "help" || subcommand === "--help") {
    deps.out(t("harness.help"));
    return 0;
  }

  switch (subcommand) {
    case "queue":
      return commandQueue(rest, deps);
    case "retry":
      return commandRetry(deps);
    case "discard":
      return commandDiscard(rest, deps);
    case "doctor":
      return commandDoctor(deps);
    case "probe":
      return commandProbe(deps);
    case "hook":
      return commandHook(rest, deps);
    default:
      // Only documented subcommands are parsed: guessing at an operator's intent
      // on a destructive surface is not a kindness.
      deps.err(t("harness.unknownHarnessCommand", { subcommand }));
      deps.err(t("harness.help"));
      return 2;
  }
}
