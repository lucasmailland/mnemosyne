/**
 * PRIM-18 (dedup part) — an exact repeat of an active decision or strategy is
 * the same record, the way an exact repeat of a fact already is.
 *
 * Measured: two identical `remember(kind:"decision")` calls → 2 rows; two
 * identical strategies → 2 rows; two identical facts → 1 (content hash). The
 * repeat now returns the existing id. "Identical" means everything that makes
 * the record what it is — kind, title and body (trigger and action for a
 * strategy), owner, scopeRef and sensitivity — so a copy in another scope or
 * at another tier is still its own record.
 */
import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { AuthContext, RememberRequest } from "@mnemo-ai/types";
import { remember } from "../remember.js";

const WS = "ws-dedup";
const auth: AuthContext = {
  workspaceId: WS,
  actorId: "key:k1",
  actorType: "agent",
  userId: null,
  scopes: ["memory:write"] as never,
};

function makeCtx(storage: InMemoryStorageAdapter) {
  return {
    storage,
    vector: { search: async () => [], upsert: async () => {} },
    embed: { model: "test-embed", embedSingle: async () => new Float32Array([1, 0]) },
    telemetry: { startSpan: () => ({ end: () => {} }) },
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

const decision = (content: string, extra: Partial<RememberRequest> = {}): RememberRequest =>
  ({
    workspaceId: WS,
    kind: "decision",
    subject: "database",
    content,
    ...extra,
  }) as RememberRequest;

const strategy = (content: string, extra: Partial<RememberRequest> = {}): RememberRequest =>
  ({
    workspaceId: WS,
    kind: "strategy",
    subject: "when a migration fails",
    content,
    ...extra,
  }) as RememberRequest;

async function activeDecisions(storage: InMemoryStorageAdapter) {
  return (await storage.queryDecisions({ workspaceId: WS, status: "active" })).items;
}
async function activeStrategies(storage: InMemoryStorageAdapter) {
  return (await storage.queryStrategies({ workspaceId: WS, status: "active" })).items;
}

describe("remember() — exact repeat of a decision", () => {
  it("returns the existing decision instead of a second row", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const first = await remember(ctx, decision("We use PostgreSQL 17 for ledger-api."), auth);
    const again = await remember(ctx, decision("We use PostgreSQL 17 for ledger-api."), auth);

    expect(again.id).toBe(first.id);
    expect(await activeDecisions(storage)).toHaveLength(1);
  });

  it("a different body is a different decision", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const a = await remember(ctx, decision("We use PostgreSQL 17 for ledger-api."), auth);
    const b = await remember(ctx, decision("We use PostgreSQL 16 for ledger-api."), auth);

    expect(b.id).not.toBe(a.id);
    expect(await activeDecisions(storage)).toHaveLength(2);
  });

  it("the same text at another sensitivity tier is not reused", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);
    const restricted = await storage.createDecision({
      workspaceId: WS,
      title: "We use PostgreSQL 17 for ledger-api.",
      body: "We use PostgreSQL 17 for ledger-api.",
      kind: "decision",
      scopeOwner: `workspace:${WS}`,
      sensitivity: "restricted",
      metadata: { subject: "database" },
    });

    const res = await remember(ctx, decision("We use PostgreSQL 17 for ledger-api."), auth);

    expect(res.id).not.toBe(restricted.id);
  });

  it("the same text under another owner is not reused", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);
    const personal = await storage.createDecision({
      workspaceId: WS,
      title: "We use PostgreSQL 17 for ledger-api.",
      body: "We use PostgreSQL 17 for ledger-api.",
      kind: "decision",
      scopeOwner: "user:someone-else",
      metadata: { subject: "database" },
    });

    const res = await remember(ctx, decision("We use PostgreSQL 17 for ledger-api."), auth);

    expect(res.id).not.toBe(personal.id);
  });

  // Integration of WP-5 (AGENTSIM-7) and WP-7 (PRIM-18): the lookup must
  // describe the row the insert writes — title from the statement (or the
  // caller's), scopeRef, sensitivity and metadata.subject — or a repeat is
  // never found, and a different decision could be.
  it("a repeat carrying title, scopeRef and sensitivity is the same decision", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);
    const extra = {
      title: "Ledger database",
      scopeRef: "repo:ledger-api",
      sensitivity: "confidential",
    } as Partial<RememberRequest>;

    const first = await remember(ctx, decision("We use PostgreSQL 17.", extra), auth);
    const again = await remember(ctx, decision("We use PostgreSQL 17.", extra), auth);

    expect(again.id).toBe(first.id);
    expect(await activeDecisions(storage)).toHaveLength(1);
  });

  it("the same text under another scopeRef is not reused", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const a = await remember(ctx, decision("Retry with backoff.", { scopeRef: "repo:a" }), auth);
    const b = await remember(ctx, decision("Retry with backoff.", { scopeRef: "repo:b" }), auth);

    expect(b.id).not.toBe(a.id);
  });

  it("the same text about another subject is not reused", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const a = await remember(
      ctx,
      decision("Retry with backoff.", { subject: "payments-api" }),
      auth
    );
    const b = await remember(ctx, decision("Retry with backoff.", { subject: "ledger-api" }), auth);

    expect(b.id).not.toBe(a.id);
    expect(await activeDecisions(storage)).toHaveLength(2);
  });

  it("an explicit title makes a different decision from the derived one", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const a = await remember(ctx, decision("We use PostgreSQL 17."), auth);
    const b = await remember(ctx, decision("We use PostgreSQL 17.", { title: "Database" }), auth);

    expect(b.id).not.toBe(a.id);
  });

  it("an explicit new topicKey gets its own decision, even with identical content", async () => {
    // WP-7 review — the content lookup returned decision A for a write under a
    // new key "b", and "b" was never stored: the next write under "b" created
    // yet another decision instead of revising the slot the caller named.
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const a = await remember(
      ctx,
      decision("We use PostgreSQL 17 for ledger-api.", { topicKey: "ledger/db-a" }),
      auth
    );
    const b = await remember(
      ctx,
      decision("We use PostgreSQL 17 for ledger-api.", { topicKey: "ledger/db-b" }),
      auth
    );
    await remember(
      ctx,
      decision("We use PostgreSQL 18 for ledger-api.", { topicKey: "ledger/db-b" }),
      auth
    );

    expect(b.id).not.toBe(a.id);
    // The correction under "b" revised the "b" slot instead of adding a third.
    const active = await activeDecisions(storage);
    expect(active.map((d) => d.topicKey).sort()).toEqual(["ledger/db-a", "ledger/db-b"]);
    expect(active.find((d) => d.topicKey === "ledger/db-b")?.body).toBe(
      "We use PostgreSQL 18 for ledger-api."
    );
  });

  it("a superseded decision with the same text is not resurrected", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);
    const first = await remember(ctx, decision("We use PostgreSQL 17 for ledger-api."), auth);
    await storage.archiveDecision(first.id, WS);

    const again = await remember(ctx, decision("We use PostgreSQL 17 for ledger-api."), auth);

    expect(again.id).not.toBe(first.id);
  });
});

describe("remember() — exact repeat of a strategy", () => {
  it("returns the existing strategy instead of a second row", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const first = await remember(ctx, strategy("Roll back, then rerun with --dry-run."), auth);
    const again = await remember(ctx, strategy("Roll back, then rerun with --dry-run."), auth);

    expect(again.id).toBe(first.id);
    expect(await activeStrategies(storage)).toHaveLength(1);
  });

  it("a different action is a different strategy", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const a = await remember(ctx, strategy("Roll back, then rerun with --dry-run."), auth);
    const b = await remember(ctx, strategy("Page the on-call DBA."), auth);

    expect(b.id).not.toBe(a.id);
    expect(await activeStrategies(storage)).toHaveLength(2);
  });
});

describe("remember() — an adapter without the lookup still writes", () => {
  it("inserts as before when createDecisionUnlessDuplicate is not implemented", async () => {
    const storage = new InMemoryStorageAdapter();
    (storage as { createDecisionUnlessDuplicate?: unknown }).createDecisionUnlessDuplicate =
      undefined;
    const ctx = makeCtx(storage);

    const a = await remember(ctx, decision("We use PostgreSQL 17 for ledger-api."), auth);
    const b = await remember(ctx, decision("We use PostgreSQL 17 for ledger-api."), auth);

    expect(b.id).not.toBe(a.id);
  });
});
