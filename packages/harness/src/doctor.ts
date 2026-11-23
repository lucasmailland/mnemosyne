import { randomUUID } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CaptureDecision, CaptureHost, CaptureMode } from "./adapters/capabilities.js";
import { readBinding } from "./binding.js";
import { readCaptureConsent } from "./consent.js";
import {
  ensureSecureHarnessPaths,
  inspectFilesystemCapabilities,
  readPrivateFile,
  type FilesystemCapabilities,
} from "./fs-security.js";
import { readDeliveryState } from "./delivery.js";
import { enqueueVisibleMessage, readPendingEvents } from "./outbox.js";
import { acknowledgeEvent } from "./state.js";

/**
 * What the doctor needs to say which capture mode each host is really at. The
 * CLI supplies it: the live gate and the plugin payload's location are its
 * knowledge, not the harness's.
 */
export interface HostCaptureProbe {
  /** The qualification decision for the host as installed now (record, version, platform). */
  qualification(host: CaptureHost): CaptureDecision;
  /** Whether capture can exist on this machine at all (Codex: features.hooks, Windows). */
  liveGate(host: CaptureHost): CaptureDecision;
  /** Digest of the capture artifacts that run now, or null when they cannot be hashed. */
  artifactHash(host: CaptureHost): string | null;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface HostCaptureDiagnosis {
  host: CaptureHost;
  /** The mode the marker records, or null when this host was never consented. */
  consented: CaptureMode | null;
  /** The lowest of consent, the artifacts it was given for, qualification and the live gate. */
  mode: CaptureMode;
  /** Why it is at `mode`: the first thing that lowered it, or what proved it. */
  reason: string;
}

export interface DoctorOptions {
  home?: string;
  /** Run a real enqueue/acknowledge round trip. Off by default: it writes. */
  selfTest?: boolean;
  now?: () => Date;
  /** When given, the report carries one capture line per host. */
  captureHosts?: HostCaptureProbe;
}

export interface DoctorReport {
  ok: boolean;
  queue: {
    count: number;
    bytes: number;
    oldestAgeSeconds: number | null;
    deadLetters: number;
  };
  delivery: {
    attempt: number;
    nextAttemptAt: string | null;
    blocked: { status: number; at: string } | null;
  };
  binding:
    | { bound: false }
    | {
        bound: true;
        serverUrl: string;
        workspaceId: string;
        installationId: string;
        keyFingerprint: string;
      };
  filesystem: FilesystemCapabilities;
  capture: { fullFidelity: boolean; reason?: string };
  /** Present only when `captureHosts` was given. */
  hosts?: HostCaptureDiagnosis[];
  selfTest: { ran: boolean; ok: boolean; reason?: string };
  problems: string[];
}

const CAPTURE_HOSTS: CaptureHost[] = ["opencode", "claude-code", "codex"];
const MODE_RANK: Record<CaptureMode, number> = {
  unavailable: 0,
  "mcp-only": 1,
  "user-only": 2,
  full: 3,
};

/**
 * One host's effective capture mode, computed the way capture itself decides it
 * (host-runtime.ts currentConsentMode, plus the qualification record): every
 * check can only lower the mode, and the reason is the first one that did.
 */
async function diagnoseCaptureHost(
  host: CaptureHost,
  probe: HostCaptureProbe,
  home: string | undefined
): Promise<HostCaptureDiagnosis> {
  const toggle = (probe.env?.MNEMO_HARNESS_V1_ENABLED ?? "").trim().toLowerCase();
  const consent = await readCaptureConsent(host, home === undefined ? {} : { home });
  const consented = consent?.mode ?? null;
  if (toggle === "false" || toggle === "0") {
    return {
      host,
      consented,
      mode: "mcp-only",
      reason: "MNEMO_HARNESS_V1_ENABLED=false turns capture off on this machine",
    };
  }
  if (!consent) {
    return {
      host,
      consented,
      mode: "mcp-only",
      reason: `no capture consent; run \`mnemo install --capture ${host}\` to turn it on`,
    };
  }
  let current: CaptureDecision = {
    mode: consent.mode,
    reason:
      MODE_RANK[consent.mode] <= MODE_RANK["mcp-only"]
        ? `consent was recorded for ${consent.mode}, which captures nothing`
        : `consented to ${consent.mode}`,
  };
  const lower = (candidate: CaptureDecision, prefix: string) => {
    if (MODE_RANK[candidate.mode] < MODE_RANK[current.mode])
      current = { mode: candidate.mode, reason: `${prefix}${candidate.reason}` };
  };
  const hash = probe.artifactHash(host);
  if (consent.packageHash.length === 0 || hash === null || hash !== consent.packageHash) {
    lower(
      {
        mode: "mcp-only",
        reason: `the capture artifacts changed since consent was recorded; re-run \`mnemo install --capture ${host}\``,
      },
      ""
    );
  }
  lower(probe.qualification(host), "qualification: ");
  lower(probe.liveGate(host), "host gate: ");
  return { host, consented, mode: current.mode, reason: current.reason };
}

async function countDirectory(path: string): Promise<number> {
  try {
    return (await readdir(path)).length;
  } catch {
    return 0;
  }
}

async function readFidelity(
  statePath: string
): Promise<{ fullFidelity: boolean; reason?: string }> {
  try {
    const parsed = JSON.parse(await readPrivateFile(join(statePath, "full-fidelity.json"))) as {
      fullFidelity?: boolean;
      reason?: string;
    };
    return parsed.fullFidelity === false
      ? { fullFidelity: false, ...(parsed.reason ? { reason: parsed.reason } : {}) }
      : { fullFidelity: true };
  } catch {
    // No latch means nothing has ever reported a loss.
    return { fullFidelity: true };
  }
}

/**
 * Prove the local queue works, without involving the network.
 *
 * Almost every "capture is broken" report is a local problem — a permission, a
 * full disk, a missing lock primitive — and this separates that from a server
 * problem in one step. It cleans up after itself, because a diagnosis must not
 * grow the queue it just measured.
 */
async function runSelfTest(
  options: DoctorOptions
): Promise<{ ran: true; ok: boolean; reason?: string }> {
  const probeId = `doctor-${randomUUID()}`;
  try {
    const enqueued = await enqueueVisibleMessage(
      {
        host: "codex",
        hostSessionId: probeId,
        clientInstanceId: probeId,
        sourceGeneration: 0,
        hostMessageId: probeId,
        role: "user",
        content: "harness self test",
      },
      options
    );
    if (enqueued.event.type !== "turn.append")
      return { ran: true, ok: false, reason: "unexpected_event" };
    await acknowledgeEvent(
      enqueued.event.host,
      enqueued.event.clientInstanceId,
      enqueued.event.hostSessionId,
      {
        type: "turn.append",
        eventId: enqueued.event.eventId,
        enqueueSequence: enqueued.event.enqueueSequence,
        sourceGeneration: enqueued.event.sourceGeneration,
        hostMessageId: enqueued.event.hostMessageId,
        role: enqueued.event.role,
        contentHash: enqueued.event.contentHash,
      },
      options
    );
    await unlink(enqueued.path).catch(() => undefined);
    return { ran: true, ok: true };
  } catch {
    // The reason is deliberately coarse: this report gets pasted into issues.
    return { ran: true, ok: false, reason: "local_queue_unavailable" };
  }
}

/**
 * One answer to "is capture working, and if not, whose problem is it".
 *
 * Never throws. Diagnosis is exactly the moment when the install may be broken,
 * so a report that cannot be produced is itself the finding.
 *
 * Nothing in the report is secret: no API key, no message content, no host
 * transcript path. Operators paste these into issues, and a diagnostic that leaks
 * a conversation is worse than no diagnostic.
 */
export async function diagnoseHarness(options: DoctorOptions = {}): Promise<DoctorReport> {
  const now = (options.now ?? (() => new Date()))();
  const problems: string[] = [];
  const empty: DoctorReport = {
    ok: false,
    queue: { count: 0, bytes: 0, oldestAgeSeconds: null, deadLetters: 0 },
    delivery: { attempt: 0, nextAttemptAt: null, blocked: null },
    binding: { bound: false },
    filesystem: {
      mode: "unavailable",
      noFollow: false,
      advisoryLock: false,
      lockExclusion: false,
      fileFsync: false,
      directoryFsync: false,
      ownership: false,
      reasons: ["harness_paths_unavailable"],
    },
    capture: { fullFidelity: true },
    selfTest: { ran: false, ok: false },
    problems: ["harness_paths_unavailable"],
  };

  let paths;
  try {
    paths = await ensureSecureHarnessPaths(options);
  } catch {
    return empty;
  }

  const filesystem = await inspectFilesystemCapabilities(options).catch(() => empty.filesystem);
  if (filesystem.mode !== "available") problems.push(`filesystem_${filesystem.mode}`);

  let count = 0;
  let bytes = 0;
  let oldestAgeSeconds: number | null = null;
  try {
    const pending = await readPendingEvents(options);
    count = pending.length;
    for (const entry of pending) {
      bytes += entry.bytes;
      const occurredAt = Date.parse(entry.event.occurredAt);
      if (Number.isFinite(occurredAt)) {
        const age = Math.max(0, Math.floor((now.getTime() - occurredAt) / 1000));
        oldestAgeSeconds = oldestAgeSeconds === null ? age : Math.max(oldestAgeSeconds, age);
      }
    }
  } catch {
    problems.push("queue_unreadable");
  }

  const deadLetters = await countDirectory(paths.quarantine);
  if (deadLetters > 0) problems.push("dead_letters_present");

  const delivery = await readDeliveryState(options);
  if (delivery?.blocked) problems.push("delivery_blocked");

  const binding = await readBinding(options);
  if (!binding) problems.push("not_bound");

  const capture = await readFidelity(paths.state);
  if (!capture.fullFidelity) problems.push("capture_incomplete");

  let hosts: HostCaptureDiagnosis[] | undefined;
  if (options.captureHosts) {
    const probe = options.captureHosts;
    hosts = [];
    for (const host of CAPTURE_HOSTS) {
      const line = await diagnoseCaptureHost(host, probe, options.home).catch(
        (): HostCaptureDiagnosis => ({
          host,
          consented: null,
          mode: "mcp-only",
          reason: "capture state could not be read",
        })
      );
      hosts.push(line);
      // A host the user consented to that now captures less than that is a fault.
      if (line.consented && MODE_RANK[line.mode] < MODE_RANK[line.consented])
        problems.push(`capture_dropped_${host}`);
    }
  }

  const selfTest = options.selfTest
    ? await runSelfTest(options)
    : { ran: false as const, ok: false };
  if (selfTest.ran && !selfTest.ok) problems.push("self_test_failed");

  return {
    ok: problems.length === 0,
    queue: { count, bytes, oldestAgeSeconds, deadLetters },
    delivery: {
      attempt: delivery?.attempt ?? 0,
      nextAttemptAt: delivery?.nextAttemptAt ?? null,
      blocked: delivery?.blocked ?? null,
    },
    binding: binding
      ? {
          bound: true,
          serverUrl: binding.serverUrl,
          workspaceId: binding.workspaceId,
          installationId: binding.installationId,
          // A fingerprint, never the key: this report is meant to be shared.
          keyFingerprint: binding.keyFingerprint,
        }
      : { bound: false },
    filesystem,
    capture,
    ...(hosts ? { hosts } : {}),
    selfTest,
    problems,
  };
}
