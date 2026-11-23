/**
 * Unit tests for InMemoryStorageAdapter.purgeFacts()
 * Covers SOC2 CF3 retention purge spec scenarios.
 */
import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "../testing/InMemoryStorageAdapter.js";

const WS = "ws-purge-test";
const BASE_ID_COUNTER = { n: 0 };

function makeFactId() {
  return `fact-${++BASE_ID_COUNTER.n}`;
}

/**
 * Create a minimal fact in the adapter at a given age.
 */
async function seedFact(
  adapter: InMemoryStorageAdapter,
  opts: {
    sensitivity: "public" | "internal" | "confidential" | "restricted";
    daysOld: number;
    actorId?: string;
  },
) {
  const id = makeFactId();
  const createdAt = new Date(Date.now() - opts.daysOld * 24 * 60 * 60 * 1000); // determinism-ok: relative age anchored to test-run clock; no assertions on absolute timestamps
  // Insert via createFact to go through the normal path, then patch createdAt.
  const fact = await adapter.createFact({
    workspaceId: WS,
    statement: `fact ${id}`,
    subject: "test-subject",
    scope: "global",
    kind: "preference",
    sensitivity: opts.sensitivity,
    attribution: "user_stated",
    actorId: opts.actorId,
  });
  // Patch createdAt directly since the port does not expose it as input.
  (adapter as unknown as { facts: Map<string, { createdAt: Date }> }).facts.set(
    fact.id,
    {
      ...(adapter as unknown as { facts: Map<string, object> }).facts.get(fact.id)!,
      createdAt,
    } as { createdAt: Date },
  );
  return fact.id;
}

describe("InMemoryStorageAdapter.purgeFacts — SOC2 CF3", () => {
  it("soft-closes 2 expired internal facts and leaves 1 in-range fact unchanged", async () => {
    const adapter = new InMemoryStorageAdapter();

    const expiredId1 = await seedFact(adapter, { sensitivity: "internal", daysOld: 800 });
    const expiredId2 = await seedFact(adapter, { sensitivity: "internal", daysOld: 750 });
    const freshId = await seedFact(adapter, { sensitivity: "internal", daysOld: 100 });

    const result = await adapter.purgeFacts({
      workspaceId: WS,
      sensitivity: "internal",
      olderThanDays: 730,
      dryRun: false,
    });

    expect(result.softClosed).toBe(2);

    const facts = (adapter as unknown as { facts: Map<string, { id: string; validTo: Date | null; status: string }> }).facts;
    expect(facts.get(expiredId1)!.validTo).not.toBeNull();
    expect(facts.get(expiredId1)!.status).toBe("forgotten");
    expect(facts.get(expiredId2)!.validTo).not.toBeNull();
    expect(facts.get(expiredId2)!.status).toBe("forgotten");

    // In-range fact must be untouched (validTo is undefined or null — both mean open).
    expect(facts.get(freshId)!.validTo == null).toBe(true);
    expect(facts.get(freshId)!.status).toBe("active");
  });

  it("public facts are never purged (softClosed=0)", async () => {
    const adapter = new InMemoryStorageAdapter();

    await seedFact(adapter, { sensitivity: "public", daysOld: 9999 });
    await seedFact(adapter, { sensitivity: "public", daysOld: 1000 });

    // purgeFacts must NOT be called with 'public' in production, but InMemory
    // should handle it defensively and return 0 closed.
    const result = await adapter.purgeFacts({
      workspaceId: WS,
      sensitivity: "public",
      olderThanDays: 1,
      dryRun: false,
    });

    // InMemoryStorageAdapter guards the public tier: softClosed MUST be 0.
    expect(result.softClosed).toBe(0);
    expect(result.eraseCandidateActorIds).toEqual([]);
  });

  it("internal tier always returns eraseCandidateActorIds=[] (no DEK for plaintext)", async () => {
    const adapter = new InMemoryStorageAdapter();

    await seedFact(adapter, { sensitivity: "internal", daysOld: 800, actorId: "actor-plain" });

    const result = await adapter.purgeFacts({
      workspaceId: WS,
      sensitivity: "internal",
      olderThanDays: 730,
      dryRun: false,
    });

    expect(result.softClosed).toBeGreaterThan(0);
    expect(result.eraseCandidateActorIds).toEqual([]);
  });

  it("dry-run returns counts without mutating any facts", async () => {
    const adapter = new InMemoryStorageAdapter();

    const factId = await seedFact(adapter, { sensitivity: "internal", daysOld: 800 });

    const result = await adapter.purgeFacts({
      workspaceId: WS,
      sensitivity: "internal",
      olderThanDays: 730,
      dryRun: true,
    });

    expect(result.softClosed).toBe(1);

    // Must not have mutated the fact (validTo is undefined or null — both mean open).
    const facts = (adapter as unknown as { facts: Map<string, { validTo: Date | undefined | null; status: string }> }).facts;
    expect(facts.get(factId)!.validTo == null).toBe(true);
    expect(facts.get(factId)!.status).toBe("active");
  });

  it("confidential: actor with only expired facts returns in eraseCandidateActorIds", async () => {
    const adapter = new InMemoryStorageAdapter();

    await seedFact(adapter, {
      sensitivity: "confidential",
      daysOld: 400,
      actorId: "actor-fully-expired",
    });

    const result = await adapter.purgeFacts({
      workspaceId: WS,
      sensitivity: "confidential",
      olderThanDays: 365,
      dryRun: false,
    });

    expect(result.softClosed).toBe(1);
    expect(result.eraseCandidateActorIds).toContain("actor-fully-expired");
  });

  it("excludes facts carrying a pending consolidation marker from purge", async () => {
    const adapter = new InMemoryStorageAdapter();
    const survivor = await adapter.createFact({
      workspaceId: WS, statement: "survivor", subject: "s", scope: "global", kind: "preference",
      sensitivity: "internal", attribution: "user_stated",
    });
    const absorbed = await adapter.createFact({
      workspaceId: WS, statement: "absorbed", subject: "s", scope: "global", kind: "preference",
      sensitivity: "internal", attribution: "user_stated",
    });
    await (adapter as unknown as {
      applyConsolidationMerge(input: {
        operationId: string; workspaceId: string; survivorId: string;
        absorbedFactIds: string[]; leaseExpiresAt: Date;
      }): Promise<unknown>;
    }).applyConsolidationMerge({
      operationId: "op-purge-guard",
      workspaceId: WS,
      survivorId: survivor.id,
      absorbedFactIds: [absorbed.id],
      leaseExpiresAt: new Date("2026-07-17T12:15:00.000Z"),
    });
    // Age the pending survivor past retention cutoff.
    const facts = (adapter as unknown as { facts: Map<string, { createdAt: Date }> }).facts;
    facts.set(survivor.id, {
      ...(facts.get(survivor.id)!),
      createdAt: new Date(Date.now() - 800 * 24 * 60 * 60 * 1000), // determinism-ok: test date
    } as { createdAt: Date });

    const result = await adapter.purgeFacts({
      workspaceId: WS, sensitivity: "internal", olderThanDays: 730, dryRun: false,
    });
    expect(result.softClosed).toBe(0);
    const still = (facts as unknown as Map<string, { status: string }>).get(survivor.id);
    expect(still?.status).toBe("active");
  });

  it("confidential: actor with one expired + one active fact is NOT in eraseCandidateActorIds", async () => {
    const adapter = new InMemoryStorageAdapter();
    const ACTOR = "actor-partial";

    await seedFact(adapter, { sensitivity: "confidential", daysOld: 400, actorId: ACTOR });
    await seedFact(adapter, { sensitivity: "confidential", daysOld: 100, actorId: ACTOR });

    const result = await adapter.purgeFacts({
      workspaceId: WS,
      sensitivity: "confidential",
      olderThanDays: 365,
      dryRun: false,
    });

    expect(result.softClosed).toBe(1);
    expect(result.eraseCandidateActorIds).not.toContain(ACTOR);
  });
});
