import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

// P85.2 — restore is the system's only reversal operation, and it appeared to
// work while not working.
//
// `POST /facts/:id/restore` called `updateFact(id, ws, { status: "active" })`
// and nothing else. Every recall path filters on `validTo IS NULL`, and forget()
// closes the interval rather than deleting the row, so the fact came back 200
// with `status: "active"` and stayed permanently unrecallable. `UpdateFactInput`
// could not express the fix either: `validTo?: Date` had no way to say "reopen".
//
// These guards pin the three distinct cases the field now carries, and the
// null/undefined normalisation — the same split that made GET /conflicts always
// return empty (P75).

const WS = "11111111-1111-4111-8111-111111111111";

async function seedForgotten(adapter: InMemoryStorageAdapter) {
  const fact = await adapter.createFact({
    workspaceId: WS,
    statement: "we deploy on Fridays",
    subject: "workspace",
    kind: "other",
    scope: "global",
  } as never);
  await adapter.archiveFact(fact.id, WS);
  return fact;
}

describe("updateFact validTo semantics (P85.2)", () => {
  it("forget closes the interval — the precondition restore has to undo", async () => {
    const adapter = new InMemoryStorageAdapter();
    const fact = await seedForgotten(adapter);

    const closed = await adapter.getFact(fact.id, WS);
    expect(closed?.validTo).toBeInstanceOf(Date);
    expect(closed?.status).toBe("forgotten");
  });

  it("status alone does NOT reopen it — the exact shape of the old bug", async () => {
    const adapter = new InMemoryStorageAdapter();
    const fact = await seedForgotten(adapter);

    await adapter.updateFact(fact.id, WS, { status: "active" });

    const after = await adapter.getFact(fact.id, WS);
    expect(after?.status).toBe("active");
    // Reports active, still closed, therefore still invisible to recall.
    expect(after?.validTo).toBeInstanceOf(Date);
  });

  it("status + validTo:null reopens the interval, which is what restore now sends", async () => {
    const adapter = new InMemoryStorageAdapter();
    const fact = await seedForgotten(adapter);

    await adapter.updateFact(fact.id, WS, { status: "active", validTo: null });

    const after = await adapter.getFact(fact.id, WS);
    expect(after?.status).toBe("active");
    expect(after?.validTo).toBeUndefined();
  });

  it("omitting validTo leaves it untouched — absent is not the same as null", async () => {
    const adapter = new InMemoryStorageAdapter();
    const fact = await seedForgotten(adapter);
    const closedAt = (await adapter.getFact(fact.id, WS))!.validTo;

    await adapter.updateFact(fact.id, WS, { confidence: 0.9 });

    expect((await adapter.getFact(fact.id, WS))?.validTo).toEqual(closedAt);
  });

  it("a Date still closes the interval", async () => {
    const adapter = new InMemoryStorageAdapter();
    const fact = await adapter.createFact({
      workspaceId: WS,
      statement: "an open fact",
      subject: "workspace",
      kind: "other",
      scope: "global",
    } as never);

    // After the row's own start: a close is never stamped before valid_from.
    const at = new Date(fact.validFrom.getTime() + 60_000);
    await adapter.updateFact(fact.id, WS, { validTo: at });

    expect((await adapter.getFact(fact.id, WS))?.validTo).toEqual(at);
  });
});
