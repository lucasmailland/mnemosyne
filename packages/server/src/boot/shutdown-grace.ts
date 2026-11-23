// How long a SIGTERM/SIGINT waits for in-flight work before the process
// force-exits. Pure function over an env bag so it is unit-testable.

export const DEFAULT_SHUTDOWN_GRACE_MS = 45_000;
// Node clamps longer timers to 1 ms, which would turn a typo into an instant exit.
const MAX_TIMER_MS = 2_147_483_647;

/** MNEMO_SHUTDOWN_GRACE_MS in milliseconds; throws on anything but a positive integer. */
export function readShutdownGraceMs(env: Record<string, string | undefined>): number {
  const raw = env.MNEMO_SHUTDOWN_GRACE_MS?.trim();
  if (!raw) return DEFAULT_SHUTDOWN_GRACE_MS;
  const ms = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(ms > 0 && ms <= MAX_TIMER_MS)) {
    throw new Error(
      `MNEMO_SHUTDOWN_GRACE_MS must be a whole number of milliseconds between 1 and ${MAX_TIMER_MS}, got "${raw}"`
    );
  }
  return ms;
}
