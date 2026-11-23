import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

const WS = "11111111-1111-1111-1111-111111111111";
const OTHER_WS = "22222222-2222-2222-2222-222222222222";

function statementHash(statement: string, subject: string): string {
  return createHash("sha256")
    .update(`${statement.trim().toLowerCase()}|${subject}|fact`)
    .digest("hex");
}

async function createSource(adapter: InMemoryStorageAdapter) {
  return adapter.createFact({
    workspaceId: WS,
    agentId: "source-agent",
    actorId: "owner-1",
    scope: "conversation",
    scopeRef: "conversation-1",
    scopeOwner: "user:owner-1",
    statement: "Deploy target is us-east-1",
    subject: "deployment",
    kind: "preference",
    confidence: 0.91,
    relevance: 0.83,
    attribution: "user_stated",
    sourceMessageIds: ["message-1"],
    sessionId: "session-1",
    extractionSource: "manual",
    topicKey: "deploy-target",
    entityId: "entity-1",
    episodeId: "episode-1",
    sensitivity: "confidential",
    metadata: { source: "test", nested: { preserved: true } },
  });
}

describe("InMemoryStorageAdapter.replaceFact", () => {
  it("closes the source and creates an inherited successor at one temporal boundary", async () => {
    const adapter = new InMemoryStorageAdapter();
    const source = await createSource(adapter);
    const newStatement = "Deploy target is eu-west-1";
    const hash = statementHash(newStatement, source.subject);
    await adapter.upsertFactHash({ workspaceId: WS, statementHash: hash, factId: source.id });

    const result = await adapter.replaceFact({
      id: source.id,
      workspaceId: WS,
      statement: newStatement,
      requestedBy: "user-1",
      agentId: "editor-agent",
      actorIsolationId: "owner-1",
    });

    expect(result).not.toBeNull();
    const { previous, replacement } = result!;
    expect(replacement.id).not.toBe(source.id);
    expect(previous).toMatchObject({ id: source.id, status: "forgotten" });
    expect(previous.validTo).toBeInstanceOf(Date);
    expect(replacement).toMatchObject({
      workspaceId: source.workspaceId,
      agentId: "editor-agent",
      actorId: source.actorId,
      scope: source.scope,
      scopeRef: source.scopeRef,
      scopeOwner: source.scopeOwner,
      statement: newStatement,
      subject: source.subject,
      kind: source.kind,
      confidence: source.confidence,
      relevance: source.relevance,
      attribution: source.attribution,
      sourceMessageIds: source.sourceMessageIds,
      sessionId: source.sessionId,
      extractionSource: source.extractionSource,
      topicKey: source.topicKey,
      entityId: source.entityId,
      episodeId: source.episodeId,
      sensitivity: source.sensitivity,
      metadata: source.metadata,
      revisionCount: source.revisionCount + 1,
      status: "active",
      validTo: undefined,
      embedding: undefined,
      embeddingModel: undefined,
      embeddingStale: true,
    });
    expect(replacement.validFrom.getTime()).toBe(previous.validTo?.getTime());
    expect(replacement.createdAt.getTime()).toBe(previous.validTo?.getTime());
    expect(replacement.updatedAt.getTime()).toBe(previous.validTo?.getTime());

    const lineage = await adapter.getRelations({
      workspaceId: WS,
      sourceId: replacement.id,
      targetId: source.id,
      verb: "supersedes",
    });
    expect(lineage).toHaveLength(1);
    expect(lineage[0]).toMatchObject({ sourceType: "fact", targetType: "fact" });
    expect(await adapter.lookupFactHash(WS, hash)).toMatchObject({ factId: replacement.id });
  });

  it("returns null without mutation for foreign, closed, or non-active sources", async () => {
    const adapter = new InMemoryStorageAdapter();
    const source = await createSource(adapter);

    await expect(
      adapter.replaceFact({
        id: source.id,
        workspaceId: OTHER_WS,
        statement: "foreign",
        requestedBy: "user-1",
      })
    ).resolves.toBeNull();

    await adapter.updateFact(source.id, WS, { validTo: new Date("2026-07-14T12:00:00.000Z") });
    await expect(
      adapter.replaceFact({
        id: source.id,
        workspaceId: WS,
        statement: "closed",
        requestedBy: "user-1",
      })
    ).resolves.toBeNull();

    const inactive = await createSource(adapter);
    await adapter.updateFact(inactive.id, WS, { status: "merged" });
    await expect(
      adapter.replaceFact({
        id: inactive.id,
        workspaceId: WS,
        statement: "inactive",
        requestedBy: "user-1",
      })
    ).resolves.toBeNull();

    expect((await adapter.getFact(source.id, WS))?.statement).toBe(source.statement);
    expect((await adapter.getFact(inactive.id, WS))?.statement).toBe(inactive.statement);
  });

  it("enforces actor isolation without mutating another actor's fact", async () => {
    const adapter = new InMemoryStorageAdapter();
    const source = await createSource(adapter);

    await expect(
      adapter.replaceFact({
        id: source.id,
        workspaceId: WS,
        statement: "must not apply",
        requestedBy: "owner-2",
        actorIsolationId: "owner-2",
      })
    ).resolves.toBeNull();
    expect(await adapter.getFact(source.id, WS)).toMatchObject({
      statement: source.statement,
      status: "active",
    });
  });

  it("enforces user isolation without mutating another user's fact", async () => {
    const adapter = new InMemoryStorageAdapter();
    const source = await adapter.createFact({
      workspaceId: WS,
      userId: "user-owner-1",
      scope: "global",
      statement: "user-owned source",
      subject: "ownership",
      kind: "other",
      sensitivity: "internal",
    });

    await expect(
      adapter.replaceFact({
        id: source.id,
        workspaceId: WS,
        statement: "must not apply",
        requestedBy: "user-owner-2",
        userIsolationId: "user-owner-2",
      })
    ).resolves.toBeNull();
    expect(await adapter.getFact(source.id, WS)).toMatchObject({
      statement: "user-owned source",
      status: "active",
    });
  });

  it("allows replacement when userIsolationId matches the source's userId", async () => {
    const adapter = new InMemoryStorageAdapter();
    const source = await adapter.createFact({
      workspaceId: WS,
      userId: "user-owner-1",
      scope: "global",
      statement: "user-owned source",
      subject: "ownership",
      kind: "other",
      sensitivity: "internal",
    });

    const result = await adapter.replaceFact({
      id: source.id,
      workspaceId: WS,
      statement: "replaced by owner",
      requestedBy: "user-owner-1",
      userIsolationId: "user-owner-1",
    });

    expect(result).not.toBeNull();
    expect(result?.replacement).toMatchObject({
      statement: "replaced by owner",
      userId: "user-owner-1",
      status: "active",
    });
  });

  it("does not replace a source whose validity has not started", async () => {
    const adapter = new InMemoryStorageAdapter();
    const future = new Date(Date.now() + 60_000); // determinism-ok: test date
    const source = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "scheduled source",
      subject: "future",
      kind: "other",
      validFrom: future,
    });

    await expect(
      adapter.replaceFact({
        id: source.id,
        workspaceId: WS,
        statement: "must not apply",
        requestedBy: "user-1",
      })
    ).resolves.toBeNull();
    expect(await adapter.getFact(source.id, WS)).toMatchObject({
      statement: "scheduled source",
      status: "active",
      validTo: undefined,
    });
  });

  it("invalidates modeled LSH/query cache state and enqueues derived-data work", async () => {
    const adapter = new InMemoryStorageAdapter();
    const source = await adapter.createFact({
      workspaceId: WS,
      actorId: "owner-1",
      scope: "global",
      statement: "Deploy target is us-east-1",
      subject: "deployment",
      kind: "other",
      sensitivity: "internal",
    });
    const bands = [{ bandIdx: 0, bandHash: 42n }];
    const embedding = new Float32Array([1, 0]);
    await adapter.upsertFactLsh({
      workspaceId: WS,
      factId: source.id,
      revision: source.revisionCount,
      bands,
    });
    await adapter.insertQueryCache({
      workspaceId: WS,
      embedding,
      resultIds: [source.id],
      resultKinds: ["fact"],
      topK: 10,
    });

    const result = await adapter.replaceFact({
      id: source.id,
      workspaceId: WS,
      statement: "Deploy target is eu-west-1",
      requestedBy: "owner-1",
      actorIsolationId: "owner-1",
    });

    expect(result).not.toBeNull();
    expect(
      await adapter.pointerCandidates({ workspaceId: WS, terms: [], bands, limit: 10 })
    ).toEqual([]);
    expect(
      await adapter.lookupQueryCache({
        workspaceId: WS,
        embedding,
        threshold: 0.99,
        topK: 10,
        maxAgeMs: 300_000,
      })
    ).toBeNull();
    expect(await adapter.claimOutbox(20)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "vector_delete",
          payload: expect.objectContaining({ id: source.id }),
        }),
        expect.objectContaining({ eventType: "cache_bust" }),
        expect.objectContaining({
          eventType: "vector_upsert",
          payload: expect.objectContaining({
            id: result!.replacement.id,
            text: "Deploy target is eu-west-1",
          }),
        }),
      ])
    );
  });

  it("refuses to replace a source carrying a pending consolidation marker", async () => {
    const adapter = new InMemoryStorageAdapter();
    const survivor = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "survivor",
      subject: "s",
      kind: "other",
    });
    const absorbed = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "absorbed",
      subject: "s",
      kind: "other",
    });
    await (
      adapter as unknown as {
        applyConsolidationMerge(input: {
          operationId: string;
          workspaceId: string;
          survivorId: string;
          absorbedFactIds: string[];
          leaseExpiresAt: Date;
        }): Promise<unknown>;
      }
    ).applyConsolidationMerge({
      operationId: "op-replace-guard",
      workspaceId: WS,
      survivorId: survivor.id,
      absorbedFactIds: [absorbed.id],
      leaseExpiresAt: new Date("2026-07-17T12:15:00.000Z"),
    });

    await expect(
      adapter.replaceFact({
        id: survivor.id,
        workspaceId: WS,
        statement: "usurped",
        requestedBy: "user-1",
      })
    ).resolves.toBeNull();
    const after = await adapter.getFact(survivor.id, WS);
    expect(after?.status).toBe("active");
    expect(after?.statement).toBe("survivor");
  });

  it("allows only one successor across concurrent replacement attempts", async () => {
    const adapter = new InMemoryStorageAdapter();
    const source = await createSource(adapter);

    const results = await Promise.all([
      adapter.replaceFact({
        id: source.id,
        workspaceId: WS,
        statement: "first",
        requestedBy: "user-1",
      }),
      adapter.replaceFact({
        id: source.id,
        workspaceId: WS,
        statement: "second",
        requestedBy: "user-1",
      }),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    const facts = await adapter.queryFacts({ workspaceId: WS });
    expect(facts.items.filter((fact) => fact.status === "active")).toHaveLength(1);
    expect(facts.items.filter((fact) => fact.status === "forgotten")).toHaveLength(1);
  });
});
