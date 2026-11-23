import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { vi } from "vitest";
import {
  createRateLimitMiddleware,
  operationClass,
  type RateLimitBackend,
  PLAN_LIMITS,
} from "../../ratelimit.js";
import { toErrorBody } from "../../errors.js";

function fakeBackend(over: Partial<RateLimitBackend> = {}): RateLimitBackend {
  return {
    async consumeToken() {
      return { allowed: true, remaining: 99, resetSeconds: 60 };
    },
    async acquireSlot() {
      return { acquired: true, inFlight: 1 };
    },
    async releaseSlot() {},
    healthy: true,
    ...over,
  };
}

function appWith(
  backend: RateLimitBackend,
  plan = "free",
  fleetUtil?: Parameters<typeof createRateLimitMiddleware>[0]["fleetUtil"]
) {
  const app = new Hono();
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  app.use("*", async (c, next) => {
    c.set("workspaceId" as never, "ws1");
    c.set("plan" as never, plan);
    await next();
  });
  app.use("*", createRateLimitMiddleware({ backend, ...(fleetUtil ? { fleetUtil } : {}) }));
  app.get("/recall", (c) => c.json({ ok: true }));
  app.post("/export", (c) => c.json({ ok: true }));
  return app;
}

describe("rate-limit layers (spec §35 lines 3972–4014)", () => {
  it("sets X-RateLimit-* headers on an allowed request", async () => {
    const res = await appWith(fakeBackend()).request("/recall");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(PLAN_LIMITS.free.rps));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("99");
    expect(res.headers.get("X-RateLimit-Reset")).toBe("60");
  });

  it("returns 429 with Retry-After + reason header when the token bucket is empty (Layer 1)", async () => {
    const backend = fakeBackend({
      async consumeToken() {
        return { allowed: false, remaining: 0, resetSeconds: 7 };
      },
    });
    const res = await appWith(backend).request("/recall");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
    expect(res.headers.get("Mnemosyne-Rate-Limited-Reason")).toBe("request_rate");
  });

  it("returns 429 with concurrency reason when a slot cannot be acquired (Layer 2)", async () => {
    const backend = fakeBackend({
      async acquireSlot() {
        return { acquired: false, inFlight: 5 };
      },
    });
    const res = await appWith(backend).request("/recall");
    expect(res.status).toBe(429);
    expect(res.headers.get("Mnemosyne-Rate-Limited-Reason")).toBe("concurrency");
  });

  it("enterprise plan gets a higher limit than free (plan tiers)", async () => {
    const res = await appWith(fakeBackend(), "enterprise").request("/recall");
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(PLAN_LIMITS.enterprise.rps));
  });

  it("FAILS OPEN: when the backend is unhealthy, the request is allowed", async () => {
    const backend = fakeBackend({
      healthy: false,
      async consumeToken() {
        throw new Error("redis down");
      },
      async acquireSlot() {
        throw new Error("redis down");
      },
    });
    const res = await appWith(backend).request("/recall");
    expect(res.status).toBe(200);
  });

  it("fleet shedder sheds 'normal' class (/export) under high fleet load from the injected signal", async () => {
    const res = await appWith(fakeBackend(), "free", () => 0.75).request("/export", {
      method: "POST",
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Mnemosyne-Rate-Limited-Reason")).toBe("fleet_shed");
  });

  it("an admin route with 'recall' in a parameter, plain or encoded, is still shed", async () => {
    const app = appWith(fakeBackend(), "free", () => 0.75);
    for (const path of [
      "/admin/keys/recall",
      "/admin/keys/x/recall",
      "/admin/keys/%2Frecall",
      "/admin/keys/x/collapse",
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(503);
      expect(res.headers.get("Mnemosyne-Rate-Limited-Reason")).toBe("fleet_shed");
    }
    expect(operationClass("/admin/keys/recall", "GET")).toBe("admin");
    expect(operationClass("/memory/federation/peers/recall", "GET")).toBe("federation");
    expect(operationClass("/admin/x/session/a/turn", "POST")).toBe("admin");
    expect(operationClass("/recall/explain", "POST")).toBe("recall");
    expect(operationClass("/admin/export", "POST")).toBe("export");
  });

  // V-2: the client-supplied x-mnemo-fleet-util header used to be the default
  // fleet signal, so any caller could shed its own requests (or probe the
  // thresholds). Only an injected, server-side source may feed the shedder.
  it("ignores a client-supplied x-mnemo-fleet-util header", async () => {
    const res = await appWith(fakeBackend()).request("/export", {
      method: "POST",
      headers: { "x-mnemo-fleet-util": "0.99" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Mnemosyne-Rate-Limited-Reason")).toBeNull();
  });
});

// ─── CHAOS-13: concurrency rejections must not spend rate tokens ─────────────

function slotApp(backend: RateLimitBackend, handler?: () => Response | Promise<Response>) {
  const app = new Hono();
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  app.use("*", async (c, next) => {
    c.set("workspaceId" as never, "ws1");
    c.set("actorId" as never, "key-1");
    await next();
  });
  app.use("*", createRateLimitMiddleware({ backend, fleetUtil: () => 0 }));
  app.post("/remember", () => (handler ? handler() : new Response(null, { status: 201 })));
  return app;
}

describe("admission order (CHAOS-13)", () => {
  it("a concurrency rejection does not spend a rate token", async () => {
    const consumeToken = vi.fn(async () => ({ allowed: true, remaining: 1, resetSeconds: 1 }));
    const backend = fakeBackend({
      consumeToken,
      async acquireSlot() {
        return { acquired: false, inFlight: 10 };
      },
    });
    const res = await slotApp(backend).request("/remember", { method: "POST" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Mnemosyne-Rate-Limited-Reason")).toBe("concurrency");
    expect(consumeToken).not.toHaveBeenCalled();
  });

  it("a rate rejection releases the slot it took", async () => {
    const releaseSlot = vi.fn(async () => undefined);
    const backend = fakeBackend({
      releaseSlot,
      async consumeToken() {
        return { allowed: false, remaining: 0, resetSeconds: 1 };
      },
    });
    const res = await slotApp(backend).request("/remember", { method: "POST" });
    expect(res.status).toBe(429);
    expect(releaseSlot).toHaveBeenCalledTimes(1);
  });

  it("a token-bucket error fails open and still releases the slot", async () => {
    const releaseSlot = vi.fn(async () => undefined);
    const backend = fakeBackend({
      releaseSlot,
      async consumeToken() {
        throw new Error("redis timeout");
      },
    });
    const res = await slotApp(backend).request("/remember", { method: "POST" });
    expect(res.status).toBe(201);
    expect(releaseSlot).toHaveBeenCalledTimes(1);
  });

  it("a failing handler releases the slot exactly once", async () => {
    const releaseSlot = vi.fn(async () => undefined);
    const res = await slotApp(fakeBackend({ releaseSlot }), () => {
      throw new Error("boom");
    }).request("/remember", { method: "POST" });
    expect(res.status).toBe(500);
    expect(releaseSlot).toHaveBeenCalledTimes(1);
  });
});

// ─── LIFECYCLE-16: session turns get their own bucket ─────────────────────────

/** In-memory token bucket with the Lua script's semantics and a fake clock. */
function bucketBackend(clock: { ms: number }): RateLimitBackend {
  const buckets = new Map<string, { tokens: number; ts: number }>();
  return {
    healthy: true,
    async consumeToken(key, rps, burst) {
      const b = buckets.get(key) ?? { tokens: burst, ts: clock.ms };
      b.tokens = Math.min(burst, b.tokens + ((clock.ms - b.ts) * rps) / 1000);
      b.ts = clock.ms;
      const allowed = b.tokens >= 1;
      if (allowed) b.tokens -= 1;
      buckets.set(key, b);
      return {
        allowed,
        remaining: Math.floor(b.tokens),
        resetSeconds: Math.max(1, Math.ceil((1 - Math.min(b.tokens, 1)) / rps)),
      };
    },
    async acquireSlot() {
      return { acquired: true, inFlight: 1 };
    },
    async releaseSlot() {},
  };
}

function turnApp(backend: RateLimitBackend) {
  const app = new Hono();
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  app.use("*", async (c, next) => {
    c.set("workspaceId" as never, "ws1");
    c.set("actorId" as never, "key-1");
    await next();
  });
  app.use("*", createRateLimitMiddleware({ backend, fleetUtil: () => 0 }));
  app.post("/session/:id/turn", (c) => c.body(null, 204));
  app.post("/remember", (c) => c.body(null, 201));
  return app;
}

describe("session turn bucket (LIFECYCLE-16)", () => {
  it("classifies only the turn append as 'turn'", () => {
    expect(operationClass("/session/abc/turn", "POST")).toBe("turn");
    expect(operationClass("/session/start", "POST")).toBe("write");
    expect(operationClass("/session/abc/discard", "POST")).toBe("write");
    expect(operationClass("/session/abc/collapse", "POST")).toBe("recall");
    expect(operationClass("/remember", "POST")).toBe("write");
  });

  it("a 55-turn flush fits, and does not spend the write budget", async () => {
    const app = turnApp(bucketBackend({ ms: 0 }));
    const turns = [];
    for (let i = 0; i < 55; i++) {
      turns.push((await app.request("/session/s1/turn", { method: "POST" })).status);
    }
    expect(turns.filter((s) => s === 429)).toHaveLength(0);
    const res = await app.request("/remember", { method: "POST" });
    expect(res.status).toBe(201);
    expect(res.headers.get("Mnemosyne-Rate-Limit-Operation")).toBe("write");
  });

  it("the turn bucket is still bounded", async () => {
    const app = turnApp(bucketBackend({ ms: 0 }));
    let limited = 0;
    for (let i = 0; i < 150; i++) {
      if ((await app.request("/session/s1/turn", { method: "POST" })).status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

// ─── CLIENTS-7: the limiter states the real wait ─────────────────────────────

describe("Retry-After from the limiter (CLIENTS-7)", () => {
  it("a token-bucket 429 carries the bucket's wait in the header and in error.details", async () => {
    const backend = fakeBackend({
      async consumeToken() {
        return { allowed: false, remaining: 0, resetSeconds: 1 };
      },
    });
    const res = await slotApp(backend).request("/remember", { method: "POST" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1");
    const body = (await res.json()) as { error: { details?: Record<string, unknown> } };
    expect(body.error.details).toMatchObject({ retryAfterSeconds: 1, reason: "request_rate" });
  });

  it("a concurrency 429 carries a 1 s wait", async () => {
    const backend = fakeBackend({
      async acquireSlot() {
        return { acquired: false, inFlight: 10 };
      },
    });
    const res = await slotApp(backend).request("/remember", { method: "POST" });
    const body = (await res.json()) as { error: { details?: Record<string, unknown> } };
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(body.error.details).toMatchObject({ retryAfterSeconds: 1, reason: "concurrency" });
  });
});
