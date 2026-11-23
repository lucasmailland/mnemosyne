/**
 * Rolling capture back out, in the only order that is safe.
 *
 *   disable  -> stop the host writing into the queue, locally
 *   drain    -> deliver what is already queued, to zero
 *   quiesce  -> fence the server so nothing new is claimed, and wait for zero
 *   uninstall-> remove Mnemosyne's own artifacts, and only those
 *
 * The order is not a suggestion, and each step guards the next. Removing the
 * artifacts while capture is still activated leaves a host writing into a queue
 * nothing will ever deliver. Draining before disabling races the host, which is
 * still adding to it. And uninstalling before quiescing leaves the server holding
 * leases for a client that no longer exists.
 *
 * So `uninstall` refuses unless the earlier steps are done, and when an operator
 * overrides that it has to say what happens to the queued conversations — never
 * by default, and never silently.
 */

import { t } from "./i18n/index.js";
export interface LifecycleDeps {
  out(line: string): void;
  err(line: string): void;
  confirm(prompt: string): Promise<boolean>;
  disableHost(input: { host: string }): Promise<{
    disabled: boolean;
    ingestionStillAvailable: boolean;
  }>;
  drainQueue(): Promise<{ remaining: number; delivered: number }>;
  quiesceWorkspace(): Promise<{ quiesced: boolean; liveLeases: number; inFlight: number }>;
  removeArtifacts(input: { host: string }): Promise<{ removed: string[]; preserved: string[] }>;
  readState(input: { host: string }): Promise<{
    activated: boolean;
    queued: number;
    quiesced: boolean;
  }>;
  discardQueue?(input: { reason: string; host?: string }): Promise<{ discarded: number }>;
}

async function commandDisable(argv: string[], deps: LifecycleDeps): Promise<number> {
  const host = argv[0];
  if (!host) {
    // Disabling the wrong host is silent: capture simply stops somewhere else.
    deps.err(t("harness.disableRequiresAHost"));
    return 2;
  }
  const result = await deps.disableHost({ host });
  if (!result.disabled) {
    deps.err(t("harness.couldNotDisableCapture", { host }));
    return 1;
  }
  deps.out(t("harness.captureDisabledFor", { host }));
  if (result.ingestionStillAvailable) {
    // Said explicitly, because the next step depends on it: the queue can still
    // be delivered, and nothing has been lost yet.
    deps.out(t("harness.serverIngestionIsStill"));
  }
  return 0;
}

async function commandDrain(deps: LifecycleDeps): Promise<number> {
  const { remaining, delivered } = await deps.drainQueue();
  deps.out(t("harness.deliveredQueuedRecordS", { delivered }));
  if (remaining > 0) {
    // A partial drain reported as done is how queued conversations get thrown away.
    deps.err(t("harness.drainIncompleteRecordS", { remaining }));
    return 1;
  }
  deps.out(t("harness.queueDrainedRemaining"));
  return 0;
}

async function commandQuiesce(deps: LifecycleDeps): Promise<number> {
  const { quiesced, liveLeases, inFlight } = await deps.quiesceWorkspace();
  if (!quiesced) {
    deps.err(t("harness.notQuiescedLiveLease", { liveLeases, inFlight }));
    return 1;
  }
  deps.out(t("harness.workspaceQuiescedLeasesWrites"));
  return 0;
}

async function commandUninstall(argv: string[], deps: LifecycleDeps): Promise<number> {
  const host = argv[0];
  if (!host) {
    deps.err(t("harness.uninstallRequiresAHost"));
    return 2;
  }
  const state = await deps.readState({ host });

  if (state.activated) {
    deps.err(t("harness.isStillCapturingRun", { host }));
    return 1;
  }

  if (state.queued > 0) {
    if (!argv.includes("--discard-queued")) {
      deps.err(t("harness.stillQueued", { queued: state.queued }));
      return 1;
    }
    const proceed = await deps.confirm(
      t("harness.permanentlyDiscardQueuedRecord", { queued: state.queued, host })
    );
    if (!proceed) {
      deps.err(t("harness.uninstallCancelled"));
      return 1;
    }
    // Said in full: this is the only record the operator will have of it.
    deps.out(t("harness.discardingQueuedRecordS", { queued: state.queued }));
    await deps.discardQueue?.({ host, reason: `uninstall ${host} --discard-queued` });
  }

  const { removed, preserved } = await deps.removeArtifacts({ host });
  for (const artifact of removed) deps.out(t("harness.removed", { artifact }));
  if (preserved.length > 0) {
    // Naming what survived is what makes "we only touch our own things" checkable
    // rather than a promise.
    deps.out(t("harness.preserved", { artifacts: preserved.join(", ") }));
  }

  if (!state.quiesced) {
    // Uninstalling locally does not fence the server. Saying nothing would leave
    // an operator believing the rollback is complete when it is not.
    deps.out(t("harness.quiescenceNeeded"));
  }
  return 0;
}

export async function runHarnessLifecycle(argv: string[], deps: LifecycleDeps): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined || subcommand === "help" || subcommand === "--help") {
    deps.out(t("harness.lifecycleHelp"));
    return 0;
  }
  switch (subcommand) {
    case "disable":
      return commandDisable(rest, deps);
    case "drain":
      return commandDrain(deps);
    case "quiesce":
      return commandQuiesce(deps);
    case "uninstall":
      return commandUninstall(rest, deps);
    default:
      deps.err(t("harness.unknownHarnessCommand", { subcommand }));
      deps.err(t("harness.lifecycleHelp"));
      return 2;
  }
}
