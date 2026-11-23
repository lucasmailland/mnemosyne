/**
 * Recall observations are written DETACHED from the response, so a session's
 * recall history can still be in flight when the client acts on it (e.g. an
 * immediate POST /session/:id/feedback). Session-dependent operations await the
 * pending writes for that session first, bounded so a stalled pool never hangs
 * them. State is keyed by the owning storage object: separate apps (and tests)
 * never share it.
 */
const registries = new WeakMap<object, Map<string, Set<Promise<unknown>>>>();

const keyOf = (workspaceId: string, sessionId: string) => `${workspaceId}\u0000${sessionId}`;

export function trackPendingObservation(
  owner: object,
  workspaceId: string,
  sessionId: string,
  write: Promise<unknown>
): void {
  let byKey = registries.get(owner);
  if (!byKey) registries.set(owner, (byKey = new Map()));
  const key = keyOf(workspaceId, sessionId);
  const pending = byKey.get(key) ?? new Set<Promise<unknown>>();
  byKey.set(key, pending);
  const settled = write.then(
    () => undefined,
    () => undefined
  );
  pending.add(settled);
  void settled.then(() => {
    pending.delete(settled);
    if (pending.size === 0 && byKey!.get(key) === pending) byKey!.delete(key);
  });
}

/** Resolves once this session's pending observation writes settle, or after `timeoutMs`. */
export async function awaitPendingObservations(
  owner: object,
  workspaceId: string,
  sessionId: string,
  timeoutMs = 5_000
): Promise<void> {
  const pending = registries.get(owner)?.get(keyOf(workspaceId, sessionId));
  if (!pending || pending.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    await Promise.race([Promise.all([...pending]), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
