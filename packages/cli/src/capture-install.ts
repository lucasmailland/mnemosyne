/**
 * Installing capture, as a phase of its own.
 *
 * Three passes over the requested hosts, in this order and never interleaved:
 *
 *   1. RESOLVE — what each host can honestly do. No writes, no questions.
 *   2. CONSENT — ask about anything degraded. Still no writes.
 *   3. APPLY   — bind once, then write artifacts and consent markers.
 *
 * The ordering is the point. One pass doing resolve-ask-write per host means a
 * Ctrl-C halfway leaves host A configured against no binding while host B was
 * never asked, and the operator answers questions interleaved with writes to
 * their config files. Three passes make "nothing is written before every
 * question is answered" structural instead of remembered.
 *
 * Nothing here throws and nothing here calls `process.exit`. Every host has its
 * own boundary in every pass: one host's failure is that host's outcome, and the
 * rest of the run continues. The caller turns the outcomes into a summary and an
 * exit code — deciding that here would make this untestable and the summary a
 * side effect.
 */

import { t } from "./i18n/index.js";
import type { CaptureHost } from "./install-args.js";
import type { InstallResult } from "./harness-install.js";

export type CaptureMode = "full" | "user-only" | "mcp-only" | "unavailable";

/** How the user's agreement was obtained, or why it was not. */
export type Consent = "not-required" | "pre-consented" | "accepted" | "declined" | "unobtainable";

export type ArtifactState = "installed" | "already-installed" | "skipped" | "failed";

export type GateOffer = "accepted" | "declined" | "skipped-non-interactive" | "not-applicable";

export interface CaptureOutcome {
  host: CaptureHost;
  /** Effective mode, after the live host gate — not merely the record's claim. */
  mode: CaptureMode;
  /** Why that mode, in the qualifier's own words where it has them. */
  reason: string;
  consent: Consent;
  artifact: ArtifactState;
  gateOffer?: GateOffer;
  /** The one concrete thing the operator can do next, if there is one. */
  nextStep?: string;
  /** Present exactly when this outcome counts against the exit code. */
  failure?: string;
}

export interface CaptureRequest {
  hosts: readonly CaptureHost[];
  acceptDegraded: boolean;
  serverUrl: string;
  apiKey: string;
  /** From GET /me. `null` means the server could not be reached. */
  workspaceId: string | null;
}

/** A three-valued answer: "nobody could be asked" is not "no". */
export type Answer = "yes" | "no" | "unavailable";

export interface CaptureEffects {
  readHostVersion(host: CaptureHost): { version: string } | { error: string };
  resolveMode(input: { host: CaptureHost; hostVersion: string }): {
    mode: CaptureMode;
    reason: string;
  };
  /** The live host gate, which answers a different question than the record. */
  liveGate(host: CaptureHost): { mode: CaptureMode; reason: string };
  confirm(question: string): Promise<Answer>;
  bind(input: {
    serverUrl: string;
    workspaceId: string;
    apiKey: string;
  }): Promise<{ rebound: boolean }>;
  installArtifacts(host: CaptureHost, mode: CaptureMode): Promise<InstallResult>;
  writeConsent(input: { host: CaptureHost; mode: CaptureMode; hostVersion: string }): Promise<void>;
  /** Offer to flip a host's own feature gate. Only Codex has one today. */
  enableHostGate?(host: CaptureHost): Promise<InstallResult>;
}

const MODE_RANK: Record<CaptureMode, number> = {
  unavailable: 0,
  "mcp-only": 1,
  "user-only": 2,
  full: 3,
};

/** The lower of two answers. Capture never rounds up. */
function lower(a: CaptureMode, b: CaptureMode): CaptureMode {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}

interface Resolved {
  host: CaptureHost;
  hostVersion: string;
  mode: CaptureMode;
  reason: string;
  gateReason?: string;
  failure?: string;
}

export async function installCaptureHosts(
  input: CaptureRequest,
  fx: CaptureEffects
): Promise<CaptureOutcome[]> {
  // ── Pass 1: resolve ───────────────────────────────────────────────────────
  const resolved: Resolved[] = [];
  for (const host of input.hosts) {
    try {
      const version = fx.readHostVersion(host);
      if ("error" in version) {
        // Without a version there is no record to match, and matching on an
        // empty string would silently pin the host to mcp-only forever.
        resolved.push({
          host,
          hostVersion: "",
          mode: "unavailable",
          reason: version.error,
          failure: t("capture.couldNotDetect", { host, error: version.error }),
        });
        continue;
      }
      const record = fx.resolveMode({ host, hostVersion: version.version });
      const live = fx.liveGate(host);
      // The record answers "is this build proven". The live gate answers "can
      // capture exist on this machine at all". Different questions; the mode is
      // the lower of the two answers, never the more optimistic one.
      const mode = lower(record.mode, live.mode);
      resolved.push({
        host,
        hostVersion: version.version,
        mode,
        reason: mode === live.mode && live.mode !== record.mode ? live.reason : record.reason,
        gateReason: live.mode !== "full" ? live.reason : undefined,
      });
    } catch (error) {
      resolved.push({
        host,
        hostVersion: "",
        mode: "unavailable",
        reason: describe(error),
        failure: t("capture.couldNotResolve", { host, message: describe(error) }),
      });
    }
  }

  // ── Pass 2: consent ───────────────────────────────────────────────────────
  const decided: Array<Resolved & { consent: Consent }> = [];
  for (const entry of resolved) {
    if (entry.failure) {
      decided.push({ ...entry, consent: "unobtainable" });
      continue;
    }
    // An honest, useful mode needs no second question: `--capture <host>` was
    // the consent. Only a DEGRADED result asks, because that is where the user
    // would otherwise be agreeing to something other than what they asked for.
    if (entry.mode === "full" || entry.mode === "user-only") {
      decided.push({ ...entry, consent: "not-required" });
      continue;
    }
    if (input.acceptDegraded) {
      decided.push({ ...entry, consent: "pre-consented" });
      continue;
    }
    try {
      const answer = await fx.confirm(
        t("capture.captureWouldBeLimited", {
          host: entry.host,
          mode: entry.mode,
          reason: entry.reason,
        })
      );
      decided.push({
        ...entry,
        consent: answer === "yes" ? "accepted" : answer === "no" ? "declined" : "unobtainable",
      });
    } catch (error) {
      decided.push({ ...entry, consent: "unobtainable", failure: describe(error) });
    }
  }

  const proceeding = decided.filter(
    (entry) => entry.consent !== "declined" && entry.consent !== "unobtainable"
  );

  // ── Pass 3: apply ─────────────────────────────────────────────────────────
  const outcomes: CaptureOutcome[] = [];

  // Bind BEFORE any artifact is written, and only once. An artifact written
  // first can be picked up by a host that is already running, which would queue
  // a conversation with no recorded destination — the single thing the binding
  // exists to prevent. It runs whenever any host survived consent, including a
  // host that will only ever be mcp-only: an inert manifest becomes live the
  // moment its gate flips, possibly weeks later, with no install in between.
  let bindFailure: string | null = null;
  let rebound = false;
  if (proceeding.length > 0) {
    if (input.workspaceId === null) {
      bindFailure = t("capture.noWorkspaceToBind");
    } else {
      try {
        const result = await fx.bind({
          serverUrl: input.serverUrl,
          workspaceId: input.workspaceId,
          apiKey: input.apiKey,
        });
        rebound = result.rebound;
      } catch (error) {
        bindFailure = t("capture.couldNotBind", { message: describe(error) });
      }
    }
  }

  for (const entry of decided) {
    const base: CaptureOutcome = {
      host: entry.host,
      mode: entry.mode,
      reason: entry.reason,
      consent: entry.consent,
      artifact: "skipped",
    };

    if (entry.failure) {
      outcomes.push({ ...base, artifact: "failed", failure: entry.failure });
      continue;
    }
    if (entry.consent === "declined") {
      // A human was asked and said no. That is the system working, not failing.
      outcomes.push({
        ...base,
        nextStep: t("capture.runMnemoInstallCapture", { host: entry.host }),
      });
      continue;
    }
    if (entry.consent === "unobtainable") {
      // Nobody could be asked, so nobody consented. Silence is not agreement.
      outcomes.push({
        ...base,
        failure: t("capture.noWayToAsk", { host: entry.host }),
      });
      continue;
    }
    if (bindFailure) {
      outcomes.push({ ...base, failure: `${entry.host}: ${bindFailure}` });
      continue;
    }
    if (entry.mode === "unavailable") {
      // Nothing to write, and nothing that writing would make work.
      outcomes.push({ ...base, nextStep: entry.reason });
      continue;
    }

    let outcome: CaptureOutcome = { ...base };
    try {
      const result = await fx.installArtifacts(entry.host, entry.mode);
      if (result.status === "failed") {
        outcomes.push({
          ...outcome,
          artifact: "failed",
          failure: `${entry.host}: ${result.reason}`,
        });
        continue;
      }
      outcome = {
        ...outcome,
        artifact: result.status === "installed" ? "installed" : "already-installed",
      };
      // The marker last, and only after the artifacts exist: it is what turns
      // capture on, so writing it first would enable a host we then failed to
      // configure.
      await fx.writeConsent({ host: entry.host, mode: entry.mode, hostVersion: entry.hostVersion });
    } catch (error) {
      outcomes.push({
        ...outcome,
        artifact: "failed",
        failure: `${entry.host}: ${describe(error)}`,
      });
      continue;
    }

    outcome = await offerHostGate(outcome, entry, input, fx);
    if (rebound) {
      outcome = {
        ...outcome,
        nextStep: outcome.nextStep ?? t("capture.destinationChanged"),
      };
    }
    outcomes.push(outcome);
  }

  return outcomes;
}

/**
 * Offer to flip the host's own feature gate, where one is what limits capture.
 *
 * Deliberately a SECOND question, never implied by `--accept-degraded`: the two
 * consents differ in blast radius. One adds our entry to a config; the other
 * changes a global host setting that every other plugin observes.
 */
async function offerHostGate(
  outcome: CaptureOutcome,
  entry: Resolved & { consent: Consent },
  input: CaptureRequest,
  fx: CaptureEffects
): Promise<CaptureOutcome> {
  if (!fx.enableHostGate || entry.gateReason === undefined || entry.mode !== "mcp-only") {
    return outcome;
  }
  if (input.acceptDegraded) {
    return { ...outcome, gateOffer: "not-applicable", nextStep: entry.gateReason };
  }

  let answer: Answer;
  try {
    answer = await fx.confirm(
      t("capture.enableItNow", { host: entry.host, gateReason: entry.gateReason })
    );
  } catch {
    return { ...outcome, gateOffer: "skipped-non-interactive", nextStep: entry.gateReason };
  }
  if (answer === "unavailable") {
    // Never auto-answered in either direction when nobody is there.
    return { ...outcome, gateOffer: "skipped-non-interactive", nextStep: entry.gateReason };
  }
  if (answer === "no") {
    return { ...outcome, gateOffer: "declined", nextStep: entry.gateReason };
  }

  try {
    const result = await fx.enableHostGate(entry.host);
    if (result.status === "failed") {
      return {
        ...outcome,
        gateOffer: "accepted",
        nextStep: entry.gateReason,
        failure: t("capture.gateEnableFailed", { host: entry.host, reason: result.reason }),
      };
    }
    return {
      ...outcome,
      gateOffer: "accepted",
      nextStep: t("capture.restartForCaptureTo", { host: entry.host }),
    };
  } catch (error) {
    return {
      ...outcome,
      gateOffer: "accepted",
      nextStep: entry.gateReason,
      failure: t("capture.gateEnableFailed", { host: entry.host, reason: describe(error) }),
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether this run should exit non-zero. Declining is not a failure. */
export function captureFailed(outcomes: readonly CaptureOutcome[]): boolean {
  return outcomes.some((outcome) => outcome.failure !== undefined);
}

/** The capture phase's own block of the install summary. */
export function renderCaptureSummary(outcomes: readonly CaptureOutcome[]): string[] {
  if (outcomes.length === 0) return [];
  const lines = ["", t("capture.summaryHeading")];
  for (const outcome of outcomes) {
    const state =
      outcome.artifact === "failed"
        ? t("capture.stateFailed")
        : outcome.artifact === "skipped"
          ? t("capture.stateSkipped")
          : outcome.artifact === "already-installed"
            ? t("capture.stateAlready")
            : t("capture.stateConfigured");
    lines.push(t("capture.hostLine", { host: outcome.host, state, mode: outcome.mode }));
    lines.push(t("capture.why", { reason: outcome.reason }));
    if (outcome.consent === "declined") lines.push(t("capture.youDeclinedThis"));
    if (outcome.gateOffer === "declined") lines.push(t("capture.youDeclinedGate"));
    if (outcome.gateOffer === "skipped-non-interactive") {
      lines.push(t("capture.gateNotOffered"));
    }
    if (outcome.failure) lines.push(t("capture.failed", { failure: outcome.failure }));
    if (outcome.nextStep) lines.push(t("capture.next", { nextStep: outcome.nextStep }));
  }
  return lines;
}
