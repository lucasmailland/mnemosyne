// flatten-legacy-dual-core PR9f (design.md D6.5) — proof that
// `InMemoryStorageAdapter.getGraphSnapshot` mirrors the same filters as
// `GraphRepository` (adapter-postgres): canonical entities only,
// non-synthetic episodes, active decisions, dismissed relations excluded,
// and `targetIds` batched filtering on `getRelations` (needed by
// `traverseGraph`/`findGraphPath`'s undirected BFS).
import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

const WS = "ws-graph-snapshot";

async function seed(adapter: InMemoryStorageAdapter) {
  const ada = await adapter.createEntity({ workspaceId: WS, name: "Ada", kind: "person" });
  const dup = await adapter.createEntity({ workspaceId: WS, name: "Ada Dup", kind: "person" });
  await adapter.updateEntity(dup.id, { workspaceId: WS, canonicalId: ada.id });

  const episode = await adapter.createEpisode({
    workspaceId: WS,
    title: "Session",
    narrative: "...",
    occurredAt: new Date("2026-01-01T00:00:00Z"),
  });
  await adapter.createEpisode({
    workspaceId: WS,
    title: "Synthetic",
    narrative: "...",
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    isSynthetic: true,
  });

  const decision = await adapter.createDecision({
    workspaceId: WS,
    kind: "architecture",
    title: "Decide",
    body: "...",
  });

  await adapter.createFact({
    workspaceId: WS,
    scope: "global",
    statement: "fact one",
    subject: "Ada",
    kind: "trait",
    entityId: ada.id,
  });

  const relation = await adapter.createRelation({
    workspaceId: WS,
    sourceId: ada.id,
    sourceType: "entity",
    targetId: episode.id,
    targetType: "episode",
    verb: "related",
  });

  return { ada, dup, episode, decision, relation };
}

describe("InMemoryStorageAdapter.getGraphSnapshot", () => {
  it("filters canonical entities, non-synthetic episodes, active decisions, and assembles edges", async () => {
    const adapter = new InMemoryStorageAdapter();
    const { ada, dup, episode, decision, relation } = await seed(adapter);

    const snapshot = await adapter.getGraphSnapshot({ workspaceId: WS });
    const nodeIds = snapshot.nodes.map((n) => n.id).sort();
    expect(nodeIds).toEqual([ada.id, decision.id, episode.id].sort());
    expect(snapshot.nodes.find((n) => n.id === dup.id)).toBeUndefined();

    const adaNode = snapshot.nodes.find((n) => n.id === ada.id)!;
    expect(adaNode.factCount).toBe(1);
    expect(adaNode.avgMemoryStrength).toBe(1.0);

    expect(snapshot.edges.map((e) => e.id)).toEqual([relation.id]);
    expect(snapshot.meta).toEqual({
      entityCount: 1,
      episodeCount: 1,
      decisionCount: 1,
      relationCount: 1,
    });
  });

  it("focusEntityId restricts to the 1-hop neighbourhood", async () => {
    const adapter = new InMemoryStorageAdapter();
    const { ada, episode } = await seed(adapter);
    const snapshot = await adapter.getGraphSnapshot({ workspaceId: WS, focusEntityId: ada.id });
    expect(snapshot.nodes.map((n) => n.id).sort()).toEqual([ada.id, episode.id].sort());
  });
});

describe("InMemoryStorageAdapter.getGraphSnapshot — maxSensitivity ceiling", () => {
  async function seedMixed(adapter: InMemoryStorageAdapter) {
    const open = await adapter.createEntity({ workspaceId: WS, name: "Open", kind: "concept" });
    const secret = await adapter.createEntity({
      workspaceId: WS,
      name: "Secret",
      kind: "concept",
      sensitivity: "restricted",
    });
    const conf = await adapter.createEntity({
      workspaceId: WS,
      name: "Conf",
      kind: "concept",
      sensitivity: "confidential",
    });
    const fact = (statement: string, sensitivity: "internal" | "restricted") =>
      adapter.createFact({
        workspaceId: WS,
        scope: "global",
        statement,
        subject: "Open",
        kind: "trait",
        entityId: open.id,
        sensitivity,
      });
    const visibleFact = await fact("visible", "internal");
    const hiddenFact = await fact("hidden", "restricted");
    const episode = await adapter.createEpisode({
      workspaceId: WS,
      title: "Open session",
      narrative: "...",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      linkedFactIds: [visibleFact.id, hiddenFact.id],
    });
    const secretEpisode = await adapter.createEpisode({
      workspaceId: WS,
      title: "Secret session",
      narrative: "...",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      sensitivity: "restricted",
    });
    const secretDecision = await adapter.createDecision({
      workspaceId: WS,
      kind: "architecture",
      title: "Secret decision",
      body: "...",
      sensitivity: "confidential",
    });
    for (const target of [secret, conf]) {
      await adapter.createRelation({
        workspaceId: WS,
        sourceId: open.id,
        sourceType: "entity",
        targetId: target.id,
        targetType: "entity",
        verb: "related",
      });
    }
    await adapter.createRelation({
      workspaceId: WS,
      sourceId: open.id,
      sourceType: "entity",
      targetId: episode.id,
      targetType: "episode",
      verb: "related",
    });
    return { open, secret, conf, episode, secretEpisode, secretDecision };
  }

  it("omits nodes above the ceiling, the edges touching them, and hidden facts from factCount", async () => {
    const adapter = new InMemoryStorageAdapter();
    const { open, episode } = await seedMixed(adapter);

    const snapshot = await adapter.getGraphSnapshot({
      workspaceId: WS,
      maxSensitivity: "internal",
    });

    expect(snapshot.nodes.map((n) => n.id).sort()).toEqual([open.id, episode.id].sort());
    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.edges[0]).toMatchObject({ source: open.id, target: episode.id });
    expect(snapshot.nodes.find((n) => n.id === open.id)!.factCount).toBe(1);
    expect(snapshot.nodes.find((n) => n.id === episode.id)!.factCount).toBe(1);
    expect(snapshot.meta).toEqual({
      entityCount: 1,
      episodeCount: 1,
      decisionCount: 0,
      relationCount: 1,
    });
  });

  it("entity mentionCount counts only the facts and episodes the caller may see", async () => {
    const adapter = new InMemoryStorageAdapter();
    const { open, secretEpisode } = await seedMixed(adapter);
    await adapter.createRelation({
      workspaceId: WS,
      sourceId: secretEpisode.id,
      sourceType: "episode",
      targetId: open.id,
      targetType: "entity",
      verb: "related",
    });
    const mentions = async (filter: object) =>
      (await adapter.getGraphSnapshot({ workspaceId: WS, ...filter })).nodes.find(
        (n) => n.id === open.id
      )!.mentionCount;

    // One visible fact + one visible episode; the restricted fact and episode are not counted.
    expect(await mentions({ maxSensitivity: "internal" })).toBe(2);
    // A focus narrows the nodes shown, not the count.
    expect(await mentions({ maxSensitivity: "internal", focusEntityId: open.id })).toBe(2);
    expect(await mentions({ maxSensitivity: "restricted" })).toBe(4);
    expect(await mentions({})).toBe(4);

    // GET /entities answers the same number through countEntityMentions.
    for (const maxSensitivity of ["internal", "restricted"] as const) {
      const counts = await adapter.countEntityMentions({
        workspaceId: WS,
        entityIds: [open.id],
        maxSensitivity,
      });
      expect(counts[open.id]).toBe(await mentions({ maxSensitivity }));
    }
    // queryFacts' ceiling (GET /entities/:id linkedFactCount) leaves the restricted fact out.
    const linked = (maxSensitivity: "internal" | "restricted") =>
      adapter.queryFacts({
        workspaceId: WS,
        entityId: open.id,
        status: "active",
        maxSensitivity,
        limit: 1,
      });
    expect((await linked("internal")).total).toBe(1);
    expect((await linked("restricted")).total).toBe(2);
  });

  it("a focus on a hidden entity returns nothing", async () => {
    const adapter = new InMemoryStorageAdapter();
    const { secret } = await seedMixed(adapter);
    const snapshot = await adapter.getGraphSnapshot({
      workspaceId: WS,
      focusEntityId: secret.id,
      maxSensitivity: "internal",
    });
    expect(snapshot.nodes).toEqual([]);
    expect(snapshot.edges).toEqual([]);
  });

  it("a restricted ceiling (or none) sees everything", async () => {
    const adapter = new InMemoryStorageAdapter();
    await seedMixed(adapter);
    for (const filter of [{ maxSensitivity: "restricted" as const }, {}]) {
      const snapshot = await adapter.getGraphSnapshot({ workspaceId: WS, ...filter });
      expect(snapshot.meta).toEqual({
        entityCount: 3,
        episodeCount: 2,
        decisionCount: 1,
        relationCount: 3,
      });
      expect(snapshot.nodes.find((n) => n.label === "Open")!.factCount).toBe(2);
      expect(snapshot.nodes.find((n) => n.label === "Open session")!.factCount).toBe(2);
    }
  });

  it("semantic edges drawn only from hidden facts are omitted", async () => {
    const adapter = new InMemoryStorageAdapter();
    const a = await adapter.createEntity({ workspaceId: WS, name: "A", kind: "concept" });
    const b = await adapter.createEntity({ workspaceId: WS, name: "B", kind: "concept" });
    const fa = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "a",
      subject: "s",
      kind: "trait",
      entityId: a.id,
    });
    const fb = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "b",
      subject: "s",
      kind: "trait",
      entityId: b.id,
      sensitivity: "restricted",
    });
    adapter.setFactEmbedding(fa.id, [1, 0, 0, 0]);
    adapter.setFactEmbedding(fb.id, [0.99, 0.14, 0, 0]);
    await adapter.backfillSemanticNeighbors({ workspaceId: WS });

    const all = await adapter.getGraphSnapshot({ workspaceId: WS, includeSemantic: true });
    expect(all.edges.map((e) => e.relation)).toEqual(["semantically_related"]);

    const capped = await adapter.getGraphSnapshot({
      workspaceId: WS,
      includeSemantic: true,
      maxSensitivity: "internal",
    });
    expect(capped.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(capped.edges).toEqual([]);
  });
});

describe("InMemoryStorageAdapter.getGraphSnapshot — includeMentions", () => {
  it("links an episode to the entities of the linked facts the caller may read, once each", async () => {
    const adapter = new InMemoryStorageAdapter();
    const ws = "ws-mentions";
    const pay = await adapter.createEntity({ workspaceId: ws, name: "Payments", kind: "concept" });
    const vault = await adapter.createEntity({ workspaceId: ws, name: "Vault", kind: "concept" });
    const fact = (entityId: string, sensitivity: "internal" | "restricted") =>
      adapter.createFact({
        workspaceId: ws,
        scope: "global",
        statement: `about ${entityId}`,
        subject: "x",
        kind: "trait",
        entityId,
        sensitivity,
      });
    const a = await fact(pay.id, "internal");
    const b = await fact(pay.id, "internal");
    const hidden = await fact(vault.id, "restricted");
    const episode = await adapter.createEpisode({
      workspaceId: ws,
      title: "Session",
      narrative: "...",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      linkedFactIds: [a.id, b.id, hidden.id],
    });

    const plain = await adapter.getGraphSnapshot({ workspaceId: ws, maxSensitivity: "internal" });
    expect(plain.edges).toEqual([]);

    const snap = await adapter.getGraphSnapshot({
      workspaceId: ws,
      maxSensitivity: "internal",
      includeMentions: true,
    });
    // Two facts about Payments draw one edge; Vault's only fact is above the ceiling.
    expect(snap.edges).toEqual([
      {
        id: `men:${episode.id}:${pay.id}`,
        source: episode.id,
        target: pay.id,
        relation: "mentions",
        confidence: 1,
        provenance: "episode_facts",
      },
    ]);
    // The derived edge restates the two facts already counted: the mention count stays 2.
    expect(snap.nodes.find((n) => n.id === pay.id)!.mentionCount).toBe(2);

    const all = await adapter.getGraphSnapshot({ workspaceId: ws, includeMentions: true });
    expect(all.edges.map((e) => e.target).sort()).toEqual([pay.id, vault.id].sort());
  });
});

describe("InMemoryStorageAdapter.getRelations — targetIds batched filter", () => {
  it("matches relations where the frontier node is the target column", async () => {
    const adapter = new InMemoryStorageAdapter();
    const a = await adapter.createEntity({ workspaceId: WS, name: "A", kind: "concept" });
    const b = await adapter.createEntity({ workspaceId: WS, name: "B", kind: "concept" });
    const rel = await adapter.createRelation({
      workspaceId: WS,
      sourceId: b.id,
      sourceType: "entity",
      targetId: a.id,
      targetType: "entity",
      verb: "related",
    });

    const bySource = await adapter.getRelations({ workspaceId: WS, sourceIds: [a.id] });
    expect(bySource).toEqual([]);

    const byTarget = await adapter.getRelations({ workspaceId: WS, targetIds: [a.id] });
    expect(byTarget.map((r) => r.id)).toEqual([rel.id]);
  });
});
