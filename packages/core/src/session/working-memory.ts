import type { CacheAdapter, Logger } from "@mnemo-ai/types";

/**
 * Metrics callbacks injected at construction time. This keeps @mnemo-ai/core
 * free of any dependency on @mnemo-ai/server (hexagonal rule: core must not
 * import infrastructure packages).
 */
export interface WorkingMemoryMetrics {
  incOp(backend: "redis" | "fallback", op: string, result: "hit" | "miss" | "ok" | "error"): void;
  setFallbackBytes(bytes: number): void;
  incEviction(): void;
  incRedisFallback(op: string): void;
}

const TTL_FLOOR_S = 60; // spec §"Working Memory": L0 TTL is 1–60min → 60s is the 1-minute floor (compliant)
const TTL_CEIL_S = 3600;
const BLOOM_BITS = 8192;
const BLOOM_HASHES = 4;
const FALLBACK_MAX_BYTES = 10 * 1024 * 1024;
const BLOOM_TTL_S = 3600;

function clampTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds)) return TTL_FLOOR_S;
  return Math.min(Math.max(Math.ceil(ttlSeconds), TTL_FLOOR_S), TTL_CEIL_S);
}

export function workKey(ws: string, agent: string, key: string): string {
  return `mnemo:${ws}:work:${agent}:${key}`;
}

function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function bloomIndices(item: string): number[] {
  const h1 = fnv1a(item, 0x811c9dc5);
  const h2 = fnv1a(item, 0x01000193) | 1;
  const out: number[] = [];
  for (let i = 0; i < BLOOM_HASHES; i++) {
    out.push((h1 + Math.imul(i, h2)) % BLOOM_BITS);
  }
  return out;
}

function emptyBitfield(): number[] {
  return new Array(BLOOM_BITS >> 3).fill(0);
}

function bloomSet(bits: number[], idx: number): void {
  const slot = idx >> 3;
  bits[slot] = (bits[slot] ?? 0) | (1 << (idx & 7));
}
function bloomGet(bits: number[], idx: number): boolean {
  return ((bits[idx >> 3] ?? 0) & (1 << (idx & 7))) !== 0;
}

interface MapEntry { value: unknown; expiresAt: number; bytes: number }

class WorkingMemoryMap {
  private store = new Map<string, MapEntry>();
  private counters = new Map<string, { n: number; expiresAt: number }>();
  private _totalBytes = 0;
  private now: () => number = () => Date.now();
  private logger: Logger | undefined;
  private onEviction: (() => void) | undefined;

  setClock(fn: () => number): void { this.now = fn; }
  setLogger(logger: Logger | undefined): void { this.logger = logger; }
  setEvictionCallback(cb: () => void): void { this.onEviction = cb; }

  get totalBytes(): number { return this._totalBytes; }

  private approxBytes(value: unknown): number {
    try { return JSON.stringify(value).length * 2; } catch { return 64; }
  }

  get(key: string): unknown {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt < this.now()) { this.evict(key); return null; }
    this.store.delete(key); this.store.set(key, e);
    return e.value;
  }

  set(key: string, value: unknown, ttlSeconds: number): void {
    this.evict(key);
    const bytes = this.approxBytes(value) + key.length * 2;
    this.store.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000, bytes });
    this._totalBytes += bytes;
    while (this._totalBytes > FALLBACK_MAX_BYTES && this.store.size > 0) {
      const oldest = this.store.keys().next().value as string;
      if (oldest === key) break;
      // Capacity-driven FIFO drop on the in-process (Redis-down) path = silent
      // data loss. Surface it so operators can see the cache is over its bound.
      this.logger?.warn("working-memory: in-process fallback over capacity — evicting oldest entry", {
        operation: "working_memory.fallback_evict",
        evictedKey: oldest,
        totalBytes: this._totalBytes,
        maxBytes: FALLBACK_MAX_BYTES,
        entryCount: this.store.size,
      });
      this.onEviction?.();
      this.evict(oldest);
    }
  }

  private evict(key: string): void {
    const e = this.store.get(key);
    if (e) { this._totalBytes -= e.bytes; this.store.delete(key); }
  }

  delete(key: string): void { this.evict(key); this.counters.delete(key); }

  incrWithTtl(key: string, ttlSeconds: number): number {
    const e = this.counters.get(key);
    const now = this.now();
    if (!e || e.expiresAt < now) {
      this.counters.set(key, { n: 1, expiresAt: now + ttlSeconds * 1000 });
      return 1;
    }
    e.n += 1;
    return e.n;
  }
}

export class WorkingMemory {
  private fallback = new WorkingMemoryMap();

  /**
   * @param cache   durable cache adapter (Redis); null → in-process fallback only.
   * @param logger  optional logger; when provided, capacity-driven evictions on the
   *                in-process fallback (silent data loss) are surfaced via warn.
   * @param metrics optional metrics callbacks; injected by the server layer so
   *                core does not import infrastructure packages (hexagonal rule).
   */
  constructor(
    private readonly cache: CacheAdapter | null,
    logger?: Logger,
    private readonly metrics?: WorkingMemoryMetrics,
  ) {
    this.fallback.setLogger(logger);
    if (metrics) {
      this.fallback.setEvictionCallback(() => {
        metrics.incEviction();
        metrics.setFallbackBytes(this.fallback.totalBytes);
      });
    }
  }

  _setClock(fn: () => number): void { this.fallback.setClock(fn); }

  async workGet<T>(ws: string, agent: string, key: string): Promise<T | null> {
    const k = workKey(ws, agent, key);
    if (this.cache) {
      try {
        const val = await this.cache.get<T>(k);
        this.metrics?.incOp("redis", "get", val !== null ? "hit" : "miss");
        return val;
      } catch {
        this.metrics?.incRedisFallback("get");
        /* fall through */
      }
    }
    const val = this.fallback.get(k) as T | null;
    this.metrics?.incOp("fallback", "get", val !== null ? "hit" : "miss");
    return val;
  }

  async workSet<T>(ws: string, agent: string, key: string, value: T, ttlSeconds: number): Promise<void> {
    const k = workKey(ws, agent, key);
    const ttl = clampTtl(ttlSeconds);
    if (this.cache) {
      try {
        await this.cache.set(k, value, { ttlMs: ttl * 1000 });
        this.metrics?.incOp("redis", "set", "ok");
        return;
      } catch {
        this.metrics?.incRedisFallback("set");
        /* fall through */
      }
    }
    this.fallback.set(k, value, ttl);
    this.metrics?.incOp("fallback", "set", "ok");
    this.metrics?.setFallbackBytes(this.fallback.totalBytes);
  }

  async workCheckpoint<T>(ws: string, agent: string, name: string, snapshot: T): Promise<void> {
    await this.workSet(ws, agent, `ckpt:${name}`, snapshot, TTL_CEIL_S);
  }

  async bloomAdd(ws: string, agent: string, filter: string, item: string): Promise<void> {
    const k = workKey(ws, agent, `bloom:${filter}`);
    const bits = (await this.readBloom(k)) ?? emptyBitfield();
    for (const idx of bloomIndices(item)) bloomSet(bits, idx);
    await this.writeBloom(k, bits);
  }

  async bloomCheck(ws: string, agent: string, filter: string, item: string): Promise<boolean> {
    const k = workKey(ws, agent, `bloom:${filter}`);
    const bits = await this.readBloom(k);
    if (!bits) return false;
    return bloomIndices(item).every((idx) => bloomGet(bits, idx));
  }

  private async readBloom(k: string): Promise<number[] | null> {
    if (this.cache) {
      try {
        const val = await this.cache.get<number[]>(k);
        this.metrics?.incOp("redis", "bloom", val !== null ? "hit" : "miss");
        return val;
      } catch {
        this.metrics?.incRedisFallback("bloom");
        /* fall through */
      }
    }
    const val = (this.fallback.get(k) as number[] | null) ?? null;
    this.metrics?.incOp("fallback", "bloom", val !== null ? "hit" : "miss");
    return val;
  }

  private async writeBloom(k: string, bits: number[]): Promise<void> {
    if (this.cache) {
      try {
        await this.cache.set(k, bits, { ttlMs: BLOOM_TTL_S * 1000 });
        this.metrics?.incOp("redis", "bloom", "ok");
        return;
      } catch {
        this.metrics?.incRedisFallback("bloom");
        /* fall through */
      }
    }
    this.fallback.set(k, bits, BLOOM_TTL_S);
    this.metrics?.incOp("fallback", "bloom", "ok");
    this.metrics?.setFallbackBytes(this.fallback.totalBytes);
  }

  async rateLimitIncr(ws: string, agent: string, op: string, windowSeconds: number): Promise<number> {
    const k = workKey(ws, agent, `rl:${op}`);
    if (this.cache?.incrWithTtl) {
      try {
        const val = await this.cache.incrWithTtl(k, windowSeconds);
        this.metrics?.incOp("redis", "ratelimit", "ok");
        return val;
      } catch {
        this.metrics?.incRedisFallback("ratelimit");
        /* fall through */
      }
    }
    const val = this.fallback.incrWithTtl(k, windowSeconds);
    this.metrics?.incOp("fallback", "ratelimit", "ok");
    return val;
  }
}
