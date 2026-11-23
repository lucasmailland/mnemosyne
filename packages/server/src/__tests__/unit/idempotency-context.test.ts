import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createIdempotencyMiddleware, type IdempotencyStore, type RecoveryPoint } from "../../idempotency.js";

function recordingStore() {
  const rows = new Map<string, { requestHash: string; recoveryPoint: RecoveryPoint; responseCode?: number; responseBody?: string }>();
  const store: IdempotencyStore = {
    async begin(ws, key, rh) {
      const id = `${ws}:${key}`;
      const e = rows.get(id);
      if (!e) { rows.set(id, { requestHash: rh, recoveryPoint: "started" }); return { state: "new" }; }
      if (e.requestHash !== rh) return { state: "mismatch" };
      if (e.responseCode != null) return { state: "replay", responseCode: e.responseCode, responseBody: e.responseBody! };
      return { state: "in_flight" };
    },
    async complete(ws, key, code, body) { const r = rows.get(`${ws}:${key}`); if (r) { r.responseCode = code; r.responseBody = body; r.recoveryPoint = "completed"; } },
    async recordPhase(ws, key, phase) { const r = rows.get(`${ws}:${key}`); if (r) r.recoveryPoint = phase; },
    async getRecoveryPoint(ws, key) { return rows.get(`${ws}:${key}`)?.recoveryPoint ?? null; },
  };
  return { store, rows };
}

describe("idempotency middleware — context exposure (spec §RDD9 line 3966)", () => {
  it("sets idempotencyKey + idempotencyRecoveryPoint + idempotencyRecordPhase on context for a NEW request", async () => {
    const { store, rows } = recordingStore();
    const app = new Hono();
    app.use("*", async (c, n) => { c.set("workspaceId" as never, "ws1"); await n(); });
    app.use("*", createIdempotencyMiddleware({ store }));
    let seenKey: string | undefined;
    let seenRp: RecoveryPoint | null | undefined;
    app.post("/x", async (c) => {
      seenKey = c.get("idempotencyKey" as never) as string | undefined;
      seenRp = c.get("idempotencyRecoveryPoint" as never) as RecoveryPoint | null | undefined;
      const rec = c.get("idempotencyRecordPhase" as never) as ((p: RecoveryPoint) => Promise<void>) | undefined;
      await rec?.("llm_called");
      return c.json({ ok: true });
    });
    const r = await app.request("/x", { method: "POST", headers: { "Idempotency-Key": "k1" }, body: "{}" });
    expect(r.status).toBe(200);
    expect(seenKey).toBe("k1");
    expect(seenRp).toBe("started"); // fresh claim
    expect(rows.get("ws1:k1")!.recoveryPoint).toBe("completed"); // complete() runs after handler
  });

  it("does not set the context recorder when no Idempotency-Key is present", async () => {
    const { store } = recordingStore();
    const app = new Hono();
    app.use("*", async (c, n) => { c.set("workspaceId" as never, "ws1"); await n(); });
    app.use("*", createIdempotencyMiddleware({ store }));
    let recorderType = "set";
    app.post("/x", (c) => { recorderType = typeof c.get("idempotencyRecordPhase" as never); return c.json({ ok: true }); });
    await app.request("/x", { method: "POST", body: "{}" });
    expect(recorderType).toBe("undefined");
  });
});
