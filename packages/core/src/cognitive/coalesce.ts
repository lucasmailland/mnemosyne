/**
 * AB7.2 — Request coalescer (spec §35 line 4434).
 *
 * Identical concurrent requests (same key) share one in-flight promise.
 * When the promise settles, it is removed from the map so the next call
 * re-invokes the function (no permanent caching).
 *
 * Pure module — no I/O.
 */

export class Coalescer {
  private readonly inflight = new Map<string, Promise<unknown>>();

  /**
   * If a call with `key` is already in-flight, return its promise.
   * Otherwise invoke `fn()`, store the promise, and delete it on settle.
   */
  coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.inflight.has(key)) {
      return this.inflight.get(key) as Promise<T>;
    }

    const promise = fn().finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, promise);
    return promise;
  }

  /** Returns true if a call with the given key is currently in-flight. */
  isInflight(key: string): boolean {
    return this.inflight.has(key);
  }
}
