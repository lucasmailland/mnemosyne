import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { remember } from "../remember.js";
import type { AuthContext } from "@mnemo-ai/types";

// P85.3 / P109 — content-hash idempotency, connected at last.
//
// `upsertFactHash` ran on every fact write from the start and `lookupFactHash`,
// implemented on all three adapters, had no production caller: the hashes were
// all there and nothing read them. memory_remember's description meanwhile
// promised "Idempotente vía content-hash: re-enviar el mismo statement no
// duplica" — untrue. The only write-time dedup the system had was the surprise
// gate, which deduplicated by throwing the content away (P74).
//
// The forgotten-fact case is the one that needed care: archiveFact does not
// delete the hash row, so a hash can point at a fact recall can no longer see.
// Returning that id would be a fresh instance of the exact shape this codebase
// keeps getting bitten by, so it gets its own guard.

const auth: AuthContext = {
  workspaceId: "ws-dedup",
  actorId: "agent-dedup",
  actorType: "agent",
  scopes: ["memory:write"] as never,
};

function makeCtx(storage: InMemoryStorageAdapter) {
  return {
    storage,
    vector: { search: async () => [], upsert: async () => {} },
    embed: {
      model: "test-embed-model",
      embedSingle: async () => new Float32Array([0.1, 0.2, 0.3]),
    },
    telemetry: {
      startSpan: () => ({ end: () => {}, setAttribute: () => {}, setStatus: () => {} }),
    },
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    config: {
      surpriseThreshold: 0,
      maxHotTierSize: 1000,
      worthDecayLambda: 0.1,
      hotTierTtlSeconds: 3600,
      injectionScoreThreshold: 0.85,
      anomalyScoreThreshold: 0.8,
    },
  } as never;
}

const write = (ctx: never, content: string, extra: Record<string, unknown> = {}) =>
  remember(ctx, { workspaceId: "ws-dedup", kind: "fact", content, ...extra } as never, auth);

describe("remember(): content-hash idempotency (P85.3)", () => {
  it("returns the SAME id when the same statement is written twice", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const first = await write(ctx, "we deploy on Fridays");
    const second = await write(ctx, "we deploy on Fridays");

    expect(second.id).toBe(first.id);
  });

  it("normalises case and surrounding whitespace, matching the stored hash", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const first = await write(ctx, "We Deploy On Fridays");
    const second = await write(ctx, "  we deploy on fridays  ");

    expect(second.id).toBe(first.id);
  });

  it("treats a different subject as a different fact", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const a = await write(ctx, "prefers dark mode", { subject: "pablo" });
    const b = await write(ctx, "prefers dark mode", { subject: "someone-else" });

    expect(b.id).not.toBe(a.id);
  });

  it("does NOT hand back the id of a forgotten fact — it creates a new one", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const first = await write(ctx, "we deploy on Fridays");
    await storage.archiveFact(first.id, "ws-dedup");

    const reasserted = await write(ctx, "we deploy on Fridays");

    // archiveFact leaves the hash row pointing at the archived fact. Returning
    // that id would give the caller an id recall can no longer see.
    expect(reasserted.id).not.toBe(first.id);
    const fresh = await storage.getFact(reasserted.id, "ws-dedup");
    expect(fresh?.status).toBe("active");
    expect(fresh?.validTo).toBeUndefined();
  });

  it("leaves the explicit topicKey path in charge when one is supplied", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    // Same topicKey, different statement: topicKey is the explicit idempotency
    // key and updates in place, so the content hash must not get a vote.
    const first = await write(ctx, "we use Postgres", { topicKey: "infra/db" });
    const second = await write(ctx, "we use SQLite", { topicKey: "infra/db" });

    expect(second.id).toBe(first.id);
  });
});

// APP-009 (audit 2026-11-22). The hash is sha256(statement|subject|"fact"):
// nothing about WHERE the fact lives or WHO may read it. Measured live: the
// same sentence written with scopeRef "projA" and then "projB" answered 201
// with projA's id the second time and stored nothing for projB, so projB's
// scoped recall never found it; and a writer repeating the text of a fact above
// its own ceiling was handed that fact's id.
describe("remember(): the content hash does not fold facts with a different identity (APP-009)", () => {
  const rows = async (storage: InMemoryStorageAdapter, statement: string) =>
    [...(storage as unknown as { state: { facts: Map<string, { statement: string; status: string }> } }).state.facts.values()].filter(
      (f) => f.statement === statement && f.status === "active"
    );

  it("stores the same statement once per scopeRef", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);
    const s = "the build cache lives on the NVMe volume";

    const a = await write(ctx, s, { scope: "conversation", scopeRef: "projA" });
    const b = await write(ctx, s, { scope: "conversation", scopeRef: "projB" });

    expect(b.id).not.toBe(a.id);
    expect((await storage.getFact(b.id, "ws-dedup"))?.scopeRef).toBe("projB");
    expect(await rows(storage, s)).toHaveLength(2);
  });

  it("still deduplicates within each scopeRef once both exist", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);
    const s = "the build cache lives on the NVMe volume";

    const a = await write(ctx, s, { scope: "conversation", scopeRef: "projA" });
    const b = await write(ctx, s, { scope: "conversation", scopeRef: "projB" });
    const a2 = await write(ctx, s, { scope: "conversation", scopeRef: "projA" });
    const b2 = await write(ctx, s, { scope: "conversation", scopeRef: "projB" });

    expect(a2.id).toBe(a.id);
    expect(b2.id).toBe(b.id);
    expect(await rows(storage, s)).toHaveLength(2);
  });

  it("does not hand a global write the id of a scoped fact, nor the other way round", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);
    const s = "retries use exponential backoff";

    const scoped = await write(ctx, s, { scope: "conversation", scopeRef: "projA" });
    const global = await write(ctx, s);

    expect(global.id).not.toBe(scoped.id);
    expect((await storage.getFact(global.id, "ws-dedup"))?.scope).toBe("global");
  });

  it("does not fold a write into a fact of another sensitivity tier", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);
    const s = "the office wifi is on channel 36";

    const internal = await write(ctx, s, { sensitivity: "internal" });
    const pub = await write(ctx, s, { sensitivity: "public" });

    expect(pub.id).not.toBe(internal.id);
    expect((await storage.getFact(pub.id, "ws-dedup"))?.sensitivity).toBe("public");
  });

  it("does not fold a write into a fact owned by someone else", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);
    const s = "prefers tabs over spaces";

    const u1 = await write(ctx, s, { scopeOwner: "user:u1" });
    const u2 = await write(ctx, s, { scopeOwner: "user:u2" });

    expect(u2.id).not.toBe(u1.id);
  });
});
