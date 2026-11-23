import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createIdempotencyMiddleware, type IdempotencyStore } from "../../idempotency.js";
import { toErrorBody } from "../../errors.js";

function fakeStore(): IdempotencyStore & { rows: Map<string, { requestHash: string; responseCode?: number; responseBody?: string; recoveryPoint: string }> } {
  const rows = new Map<string, { requestHash: string; responseCode?: number; responseBody?: string; recoveryPoint: string }>();
  return {
    rows,
    async begin(workspaceId, key, requestHash) {
      const id = `${workspaceId}:${key}`;
      const existing = rows.get(id);
      if (!existing) {
        rows.set(id, { requestHash, recoveryPoint: "started" });
        return { state: "new" };
      }
      if (existing.requestHash !== requestHash) return { state: "mismatch" };
      if (existing.responseCode != null) {
        return { state: "replay", responseCode: existing.responseCode, responseBody: existing.responseBody! };
      }
      return { state: "in_flight" };
    },
    async complete(workspaceId, key, code, body) {
      const row = rows.get(`${workspaceId}:${key}`);
      if (row) { row.responseCode = code; row.responseBody = body; row.recoveryPoint = "completed"; }
    },
    async recordPhase(workspaceId, key, phase) {
      const row = rows.get(`${workspaceId}:${key}`);
      if (row) row.recoveryPoint = phase;
    },
    async getRecoveryPoint(workspaceId, key) {
      return (rows.get(`${workspaceId}:${key}`)?.recoveryPoint as never) ?? null;
    },
  };
}

function appWith(store: IdempotencyStore, hashRequest?: () => string) {
  const app = new Hono();
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  app.use("*", async (c, next) => { c.set("workspaceId" as never, "ws1"); await next(); });
  app.use("*", createIdempotencyMiddleware(hashRequest ? { store, hashRequest } : { store }));
  app.post("/x", (c) => c.json({ ok: true, n: Math.random() })); // determinism-ok: value is never compared against a hardcoded expectation; idempotency test verifies replay
  return app;
}

describe("idempotency middleware (spec §35 lines 3941–3970)", () => {
  it("passes through when no Idempotency-Key header", async () => {
    const res = await appWith(fakeStore()).request("/x", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
  });

  it("replays the stored response on duplicate key (no re-execution)", async () => {
    const app = appWith(fakeStore());
    const r1 = await app.request("/x", { method: "POST", headers: { "Idempotency-Key": "k1" }, body: "{}" });
    const b1 = await r1.json();
    const r2 = await app.request("/x", { method: "POST", headers: { "Idempotency-Key": "k1" }, body: "{}" });
    const b2 = await r2.json();
    expect(b2).toEqual(b1); // identical body — handler did NOT run twice
  });

  it("returns 409 when a concurrent request holds the key in-flight", async () => {
    const store = fakeStore();
    store.rows.set("ws1:k2", { requestHash: "anything", recoveryPoint: "started" }); // in-flight, no response yet
    const res = await appWith(store, () => "anything").request("/x", {
      method: "POST", headers: { "Idempotency-Key": "k2" }, body: "{}",
    });
    expect(res.status).toBe(409);
  });

  it("returns 422 when the same key is reused with a different request body", async () => {
    const store = fakeStore();
    let n = 0;
    const app = new Hono();
    app.onError((err, c) => {
      const { status, body } = toErrorBody(err);
      return c.json(body, status as Parameters<typeof c.json>[1]);
    });
    app.use("*", async (c, next) => { c.set("workspaceId" as never, "ws1"); await next(); });
    app.use("*", createIdempotencyMiddleware({ store, hashRequest: () => `h${n++}` }));
    app.post("/x", (c) => c.json({ ok: true }));
    await app.request("/x", { method: "POST", headers: { "Idempotency-Key": "k3" }, body: "{}" });
    const res = await app.request("/x", { method: "POST", headers: { "Idempotency-Key": "k3" }, body: '{"other":1}' });
    expect(res.status).toBe(422);
  });
});
