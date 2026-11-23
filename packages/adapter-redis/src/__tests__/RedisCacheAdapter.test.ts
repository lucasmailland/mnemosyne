import { describe, it, expect, vi, beforeEach } from "vitest";
import { RedisCacheAdapter } from "../RedisCacheAdapter.js";

// ─── ioredis mock ─────────────────────────────────────────────────────────────
//
// We mock the ioredis class so no real TCP connection is ever attempted.
// duplicate() returns a fresh mock instance (for the subscriber path).

const makeMockRedis = () => ({
  get: vi.fn(),
  eval: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  scan: vi.fn(),
  zadd: vi.fn(),
  zrangebyscore: vi.fn(),
  zincrby: vi.fn(),
  publish: vi.fn(),
  subscribe: vi.fn(),
  ping: vi.fn(),
  on: vi.fn(),
  duplicate: vi.fn(),
  disconnect: vi.fn(),
});

const mockRedisInstance = makeMockRedis();
const mockSubscriberInstance = makeMockRedis();
mockRedisInstance.duplicate.mockReturnValue(mockSubscriberInstance);

vi.mock("ioredis", () => {
  // vi.fn() creates a constructable spy. When called with `new`, if the
  // implementation returns a plain object the new-expression returns that object,
  // giving us a stable instance to assert against.
  const Ctor = vi.fn().mockImplementation(function () {
    return mockRedisInstance;
  });
  return { default: Ctor };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAdapter(overrides: { maxTtlSeconds?: number; keyPrefix?: string } = {}) {
  return new RedisCacheAdapter({
    host: "localhost",
    port: 6379,
    ...overrides,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("RedisCacheAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisInstance.duplicate.mockReturnValue(mockSubscriberInstance);
  });

  // ── Constructor / metadata ───────────────────────────────────────────────────

  it("exposes correct id and capabilities", () => {
    const adapter = makeAdapter();
    expect(adapter.id).toBe("redis");
    expect(adapter.capabilities.sortedSets).toBe(true);
    expect(adapter.capabilities.pubSub).toBe(true);
    expect(adapter.capabilities.patterns).toBe(true);
    expect(adapter.capabilities.atomic).toBe(true);
  });

  // ── ADP-1: error listeners ───────────────────────────────────────────────────
  // Without an 'error' listener, ioredis's async connection errors (reset,
  // refused, auth-fail after boot) become uncaught exceptions that crash the
  // whole process — defeating the "optional hot tier degrades to cold" contract.

  it("ADP-1: attaches an 'error' listener on the primary client at construction", () => {
    makeAdapter();
    expect(mockRedisInstance.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("ADP-1: attaches an 'error' listener on the subscriber when it's created", async () => {
    mockSubscriberInstance.subscribe.mockResolvedValueOnce(undefined);
    await makeAdapter().subscribe?.("chan", vi.fn());
    expect(mockSubscriberInstance.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("ADP-1: primary client's error listener does not throw when invoked", () => {
    makeAdapter();
    const errorCall = mockRedisInstance.on.mock.calls.find(([event]) => event === "error");
    expect(errorCall).toBeDefined();
    const [, errorHandler] = errorCall as [string, (err: Error) => void];
    expect(() => errorHandler(new Error("ECONNRESET"))).not.toThrow();
  });

  // ── get() ────────────────────────────────────────────────────────────────────

  it("get: returns null for missing key", async () => {
    mockRedisInstance.get.mockResolvedValueOnce(null);
    const result = await makeAdapter().get("missing");
    expect(result).toBeNull();
  });

  it("get: returns parsed JSON for existing key", async () => {
    mockRedisInstance.get.mockResolvedValueOnce(JSON.stringify({ foo: "bar" }));
    const result = await makeAdapter().get<{ foo: string }>("key");
    expect(result).toEqual({ foo: "bar" });
  });

  // ── set() — ARCH-01: TTL required, no PERSIST ────────────────────────────────

  it("set: throws when ttlMs is not provided (ARCH-01)", async () => {
    await expect(makeAdapter().set("key", "value")).rejects.toThrow("ttlMs");
  });

  it("set: throws when ttlMs is zero (ARCH-01)", async () => {
    await expect(makeAdapter().set("key", "value", { ttlMs: 0 })).rejects.toThrow("ttlMs");
  });

  it("set: calls redis.set with correct EX seconds", async () => {
    mockRedisInstance.set.mockResolvedValueOnce("OK");
    await makeAdapter().set("key", { x: 1 }, { ttlMs: 60_000 });
    expect(mockRedisInstance.set).toHaveBeenCalledWith("key", JSON.stringify({ x: 1 }), "EX", 60);
  });

  it("set: caps TTL at maxTtlSeconds (default 72h)", async () => {
    mockRedisInstance.set.mockResolvedValueOnce("OK");
    const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    await makeAdapter().set("key", "value", { ttlMs: ONE_WEEK_MS });
    const callArgs = mockRedisInstance.set.mock.calls[0] as unknown[];
    const ttl = callArgs[3] as number;
    expect(ttl).toBeLessThanOrEqual(259200); // 72h
  });

  it("set: respects custom maxTtlSeconds cap", async () => {
    mockRedisInstance.set.mockResolvedValueOnce("OK");
    await makeAdapter({ maxTtlSeconds: 300 }).set("key", "value", { ttlMs: 600_000 });
    const callArgs = mockRedisInstance.set.mock.calls[0] as unknown[];
    expect(callArgs[3]).toBe(300);
  });

  it("set: uses NX flag when ifNotExists is true", async () => {
    mockRedisInstance.set.mockResolvedValueOnce(null); // null = key already existed
    await makeAdapter().set("key", "value", { ttlMs: 5000, ifNotExists: true });
    expect(mockRedisInstance.set).toHaveBeenCalledWith(
      "key",
      JSON.stringify("value"),
      "EX",
      5,
      "NX"
    );
  });

  // ── delete() ─────────────────────────────────────────────────────────────────

  it("delete: calls redis.del with the key", async () => {
    mockRedisInstance.del.mockResolvedValueOnce(1);
    await makeAdapter().delete("key");
    expect(mockRedisInstance.del).toHaveBeenCalledWith("key");
  });

  // ── deletePattern() ───────────────────────────────────────────────────────────

  it("deletePattern: uses SCAN (not KEYS) and returns count", async () => {
    // First SCAN page: 3 keys; second page: done (cursor = "0")
    mockRedisInstance.scan
      .mockResolvedValueOnce(["42", ["k1", "k2", "k3"]])
      .mockResolvedValueOnce(["0", []]);
    mockRedisInstance.del.mockResolvedValue(3);

    const count = await makeAdapter().deletePattern("mnemo:ws1:*");
    expect(count).toBe(3);
    expect(mockRedisInstance.scan).toHaveBeenCalledTimes(2);
    // KEYS must never be called
    expect(mockRedisInstance).not.toHaveProperty("keys");
  });

  it("deletePattern: returns 0 when no keys match", async () => {
    mockRedisInstance.scan.mockResolvedValueOnce(["0", []]);
    const count = await makeAdapter().deletePattern("mnemo:ws999:*");
    expect(count).toBe(0);
    expect(mockRedisInstance.del).not.toHaveBeenCalled();
  });

  // ── sorted sets ──────────────────────────────────────────────────────────────

  it("zadd: delegates to redis.zadd", async () => {
    mockRedisInstance.zadd.mockResolvedValueOnce(1);
    await makeAdapter().zadd?.("zkey", 3.14, "member");
    expect(mockRedisInstance.zadd).toHaveBeenCalledWith("zkey", 3.14, "member");
  });

  it("zrangeByScore: maps ±Infinity to ±inf strings", async () => {
    mockRedisInstance.zrangebyscore.mockResolvedValueOnce(["a", "b"]);
    const result = await makeAdapter().zrangeByScore?.("zkey", -Infinity, Infinity);
    expect(mockRedisInstance.zrangebyscore).toHaveBeenCalledWith("zkey", "-inf", "+inf");
    expect(result).toEqual(["a", "b"]);
  });

  it("zrangeByScore: passes LIMIT when provided", async () => {
    mockRedisInstance.zrangebyscore.mockResolvedValueOnce(["a"]);
    await makeAdapter().zrangeByScore?.("zkey", 0, 10, 5);
    expect(mockRedisInstance.zrangebyscore).toHaveBeenCalledWith("zkey", "0", "10", "LIMIT", 0, 5);
  });

  it("zincrby: returns parsed float", async () => {
    mockRedisInstance.zincrby.mockResolvedValueOnce("3.14");
    const result = await makeAdapter().zincrby?.("zkey", 1.5, "member");
    expect(result).toBeCloseTo(3.14);
  });

  // ── pub/sub ──────────────────────────────────────────────────────────────────

  it("publish: delegates to redis.publish", async () => {
    mockRedisInstance.publish.mockResolvedValueOnce(1);
    await makeAdapter().publish?.("chan", "msg");
    expect(mockRedisInstance.publish).toHaveBeenCalledWith("chan", "msg");
  });

  it("subscribe: creates a subscriber duplicate and subscribes", async () => {
    mockSubscriberInstance.subscribe.mockResolvedValueOnce(undefined);
    mockSubscriberInstance.on.mockReturnValueOnce(mockSubscriberInstance);

    const handler = vi.fn();
    await makeAdapter().subscribe?.("chan", handler);

    expect(mockRedisInstance.duplicate).toHaveBeenCalledOnce();
    expect(mockSubscriberInstance.subscribe).toHaveBeenCalledWith("chan");
  });

  it("subscribe: reuses existing subscriber on second call", async () => {
    mockSubscriberInstance.subscribe.mockResolvedValue(undefined);
    mockSubscriberInstance.on.mockReturnValue(mockSubscriberInstance);

    const adapter = makeAdapter();
    await adapter.subscribe?.("chan1", vi.fn());
    await adapter.subscribe?.("chan2", vi.fn());

    // duplicate() should only be called once — second subscribe reuses it
    expect(mockRedisInstance.duplicate).toHaveBeenCalledOnce();
  });

  // ── healthCheck() ────────────────────────────────────────────────────────────

  it("healthCheck: returns ok on PONG", async () => {
    mockRedisInstance.ping.mockResolvedValueOnce("PONG");
    const result = await makeAdapter().healthCheck();
    expect(result.status).toBe("ok");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("healthCheck: returns degraded on unexpected PING response", async () => {
    mockRedisInstance.ping.mockResolvedValueOnce("UNEXPECTED");
    const result = await makeAdapter().healthCheck();
    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("Unexpected PING response");
  });

  it("healthCheck: returns down on connection error", async () => {
    mockRedisInstance.ping.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await makeAdapter().healthCheck();
    expect(result.status).toBe("down");
    expect(result.detail).toContain("ECONNREFUSED");
  });

  // ── close() ──────────────────────────────────────────────────────────────────

  it("close: disconnects main redis connection", async () => {
    await makeAdapter().close();
    expect(mockRedisInstance.disconnect).toHaveBeenCalledOnce();
  });

  it("close: disconnects subscriber when it was created", async () => {
    mockSubscriberInstance.subscribe.mockResolvedValueOnce(undefined);
    mockSubscriberInstance.on.mockReturnValueOnce(mockSubscriberInstance);

    const adapter = makeAdapter();
    await adapter.subscribe?.("chan", vi.fn());
    await adapter.close();

    expect(mockSubscriberInstance.disconnect).toHaveBeenCalledOnce();
    expect(mockRedisInstance.disconnect).toHaveBeenCalledOnce();
  });
});

describe("managed hot promotion", () => {
  it("uses one atomic script for the operation marker and score increment", async () => {
    const adapter = makeAdapter();
    await adapter.applyManagedHotPromotion({
      workspaceId: "ws",
      factId: "fact",
      effectId: "effect-1",
      maxSize: 1000,
    });
    expect(mockRedisInstance.eval).toHaveBeenCalledWith(
      expect.stringContaining("SADD"),
      2,
      "mnemo:ws:managed:hot:applied",
      "mnemo:ws:hot:facts",
      "effect-1",
      "fact",
      1000
    );
    expect(mockRedisInstance.zincrby).not.toHaveBeenCalled();
  });
  it("rejects invalid bounds before touching Redis", async () => {
    mockRedisInstance.eval.mockClear();
    await expect(
      makeAdapter().applyManagedHotPromotion({
        workspaceId: "ws",
        factId: "fact",
        effectId: "effect",
        maxSize: 0,
      })
    ).rejects.toThrow();
    expect(mockRedisInstance.eval).not.toHaveBeenCalled();
  });
});
