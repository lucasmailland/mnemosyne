/**
 * flatten-legacy-dual-core PR9f (design.md D6.5 "Graph — assembly-in-adapter,
 * traversal-in-core") — real-Postgres proof for:
 *
 *   (a) `DrizzleStorageAdapter.getGraphSnapshot` — mirrors legacy
 *       `buildGraphQuery`'s filters exactly: canonical entities only
 *       (`canonicalId IS NULL`), non-synthetic episodes, active decisions,
 *       fact stats (`factCount`/`avgMemoryStrength`) grouped by `entityId`,
 *       edges excluding dismissed judgments, and the `focusEntityId`
 *       1-hop-neighbourhood projection.
 *   (b) `traverseGraph`/`findGraphPath` (`@mnemo-ai/core/cognitive`) driven
 *       by the REAL adapter's `getRelations` — proves the undirected,
 *       batched `sourceIds`/`targetIds` per-hop BFS works end-to-end against
 *       physical Postgres, not just the pure-function fake in
 *       `packages/core/src/cognitive/__tests__/graph-traverse.test.ts`.
 *
 * Prerequisites: Docker daemon running.
 * Run with: pnpm --filter @mnemo-ai/adapter-postgres test:integration
 * (Node 22 required — testcontainers/undici; see CLAUDE.md.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";
import { traverseGraph, findGraphPath } from "@mnemo-ai/core/cognitive";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let databaseUrl: string;

function v3Adapter() {
  const { db, pgClient } = createDrizzleClient(databaseUrl);
  return { adapter: new DrizzleStorageAdapter(db, pgClient), pgClient };
}

let wsCounter = 0;
function freshWorkspaceId(): string {
  wsCounter++;
  return `00000000-0000-0000-0000-${String(wsCounter).padStart(12, "0")}`;
}

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  await migrate({ databaseUrl, log: () => void 0 });
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

describe("getGraphSnapshot — assembly mirrors legacy buildGraphQuery's filters", () => {
  it("returns canonical entities, non-synthetic episodes, active decisions, fact stats, and non-dismissed edges", async () => {
    const { adapter, pgClient } = v3Adapter();
    const ws = freshWorkspaceId();

    const ada = await adapter.createEntity({
      workspaceId: ws,
      name: "Ada",
      kind: "person",
      description: "Countess",
    });
    // Duplicate merged into `ada` — must be excluded from the snapshot.
    const dup = await adapter.createEntity({ workspaceId: ws, name: "Ada Dup", kind: "person" });
    await adapter.updateEntity(dup.id, { workspaceId: ws, canonicalId: ada.id });

    const episode = await adapter.createEpisode({
      workspaceId: ws,
      title: "First session",
      narrative: "...",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    });
    await adapter.createEpisode({
      workspaceId: ws,
      title: "Synthetic replay",
      narrative: "...",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      isSynthetic: true,
    });

    const decision = await adapter.createDecision({
      workspaceId: ws,
      kind: "architecture",
      title: "Use Postgres",
      body: "...",
    });

    await adapter.createFact({
      workspaceId: ws,
      scope: "global",
      statement: "Ada worked on the Analytical Engine",
      subject: "Ada",
      kind: "trait",
      entityId: ada.id,
    });
    await adapter.createFact({
      workspaceId: ws,
      scope: "global",
      statement: "Ada corresponded with Babbage",
      subject: "Ada",
      kind: "trait",
      entityId: ada.id,
    });

    const relation = await adapter.createRelation({
      workspaceId: ws,
      sourceId: ada.id,
      sourceType: "entity",
      targetId: episode.id,
      targetType: "episode",
      verb: "related",
    });
    const dismissed = await adapter.createRelation({
      workspaceId: ws,
      sourceId: ada.id,
      sourceType: "entity",
      targetId: decision.id,
      targetType: "decision",
      verb: "related",
    });
    // No port method sets judgmentStatus="dismissed" (applyRelationJudgment
    // always sets "judged") — set it directly, same pattern as
    // relation-judgment-widening.integration.test.ts's raw-column reads.
    await pgClient.unsafe(
      `UPDATE mnemosyne.mnemo_relation SET judgment_status = 'dismissed' WHERE id = $1`,
      [dismissed.id]
    );

    const snapshot = await adapter.getGraphSnapshot({ workspaceId: ws });

    const nodeIds = snapshot.nodes.map((n) => n.id).sort();
    expect(nodeIds).toEqual([ada.id, decision.id, episode.id].sort());
    expect(snapshot.nodes.find((n) => n.id === dup.id)).toBeUndefined();

    const adaNode = snapshot.nodes.find((n) => n.id === ada.id)!;
    expect(adaNode.kind).toBe("entity");
    expect(adaNode.entityKind).toBe("person");
    expect(adaNode.factCount).toBe(2);
    expect(adaNode.avgMemoryStrength).toBe(1.0);

    const episodeNode = snapshot.nodes.find((n) => n.id === episode.id)!;
    expect(episodeNode.kind).toBe("episode");
    expect(episodeNode.label).toBe("First session");

    const decisionNode = snapshot.nodes.find((n) => n.id === decision.id)!;
    expect(decisionNode.kind).toBe("decision");
    expect(decisionNode.label).toBe("Use Postgres");

    // Only the non-dismissed relation survives.
    expect(snapshot.meta).toEqual({
      entityCount: 1,
      episodeCount: 1,
      decisionCount: 1,
      relationCount: 1,
    });
    expect(snapshot.edges.map((e) => e.id)).toEqual([relation.id]);
  });

  it("maxSensitivity omits nodes above the ceiling, their edges, and hidden facts from factCount", async () => {
    const { adapter, pgClient } = v3Adapter();
    const ws = freshWorkspaceId();

    const open = await adapter.createEntity({ workspaceId: ws, name: "Open", kind: "concept" });
    const secret = await adapter.createEntity({
      workspaceId: ws,
      name: "Secret",
      kind: "concept",
      sensitivity: "restricted",
    });
    const visibleFact = await adapter.createFact({
      workspaceId: ws,
      scope: "global",
      statement: "visible",
      subject: "Open",
      kind: "trait",
      entityId: open.id,
    });
    const hiddenFact = await adapter.createFact({
      workspaceId: ws,
      scope: "global",
      statement: "hidden",
      subject: "Open",
      kind: "trait",
      entityId: open.id,
    });
    // Raised in SQL: storing a confidential/restricted fact needs an actor DEK.
    await pgClient.unsafe(
      `UPDATE mnemosyne.mnemo_fact SET sensitivity = 'restricted' WHERE id = $1`,
      [hiddenFact.id]
    );
    const episode = await adapter.createEpisode({
      workspaceId: ws,
      title: "Open session",
      narrative: "...",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      linkedFactIds: [visibleFact.id, hiddenFact.id],
    });
    await adapter.createEpisode({
      workspaceId: ws,
      title: "Secret session",
      narrative: "...",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      sensitivity: "restricted",
    });
    const conf = await adapter.createDecision({
      workspaceId: ws,
      kind: "architecture",
      title: "Confidential decision",
      body: "...",
      sensitivity: "confidential",
    });
    for (const [targetId, targetType] of [
      [secret.id, "entity"],
      [conf.id, "decision"],
      [episode.id, "episode"],
    ] as const) {
      await adapter.createRelation({
        workspaceId: ws,
        sourceId: open.id,
        sourceType: "entity",
        targetId,
        targetType,
        verb: "related",
      });
    }

    const capped = await adapter.getGraphSnapshot({ workspaceId: ws, maxSensitivity: "internal" });
    expect(capped.nodes.map((n) => n.id).sort()).toEqual([open.id, episode.id].sort());
    expect(capped.edges.map((e) => e.target)).toEqual([episode.id]);
    expect(capped.nodes.find((n) => n.id === open.id)!.factCount).toBe(1);
    expect(capped.nodes.find((n) => n.id === episode.id)!.factCount).toBe(1);

    const focusOnHidden = await adapter.getGraphSnapshot({
      workspaceId: ws,
      focusEntityId: secret.id,
      maxSensitivity: "internal",
    });
    expect(focusOnHidden.nodes).toEqual([]);

    const admin = await adapter.getGraphSnapshot({ workspaceId: ws, maxSensitivity: "restricted" });
    expect(admin.meta).toEqual({
      entityCount: 2,
      episodeCount: 2,
      decisionCount: 1,
      relationCount: 3,
    });
    expect(admin.nodes.find((n) => n.id === open.id)!.factCount).toBe(2);
    expect(admin.nodes.find((n) => n.id === episode.id)!.factCount).toBe(2);
  });

  it("entity mentionCount counts only the facts and episodes the caller may see", async () => {
    const { adapter, pgClient } = v3Adapter();
    const ws = freshWorkspaceId();
    const open = await adapter.createEntity({ workspaceId: ws, name: "Open", kind: "concept" });
    for (const statement of ["visible", "hidden"]) {
      const fact = await adapter.createFact({
        workspaceId: ws,
        scope: "global",
        statement,
        subject: "Open",
        kind: "trait",
        entityId: open.id,
      });
      if (statement === "hidden") {
        // Raised in SQL: storing a restricted fact needs an actor DEK.
        await pgClient.unsafe(
          `UPDATE mnemosyne.mnemo_fact SET sensitivity = 'restricted' WHERE id = $1`,
          [fact.id]
        );
      }
    }
    for (const sensitivity of ["internal", "restricted"] as const) {
      const episode = await adapter.createEpisode({
        workspaceId: ws,
        title: `${sensitivity} session`,
        narrative: "...",
        occurredAt: new Date("2026-01-01T00:00:00Z"),
        sensitivity,
      });
      await adapter.createRelation({
        workspaceId: ws,
        sourceId: episode.id,
        sourceType: "episode",
        targetId: open.id,
        targetType: "entity",
        verb: "related",
      });
    }
    const mentions = async (filter: object) =>
      (await adapter.getGraphSnapshot({ workspaceId: ws, ...filter })).nodes.find(
        (n) => n.id === open.id
      )!.mentionCount;

    // One visible fact + one visible episode; the restricted fact and episode are not counted.
    expect(await mentions({ maxSensitivity: "internal" })).toBe(2);
    // A focus narrows the nodes shown, not the count.
    expect(await mentions({ maxSensitivity: "internal", focusEntityId: open.id })).toBe(2);
    expect(await mentions({ maxSensitivity: "restricted" })).toBe(4);

    // GET /entities answers the same number through countEntityMentions.
    for (const maxSensitivity of ["internal", "restricted"] as const) {
      const counts = await adapter.countEntityMentions({
        workspaceId: ws,
        entityIds: [open.id],
        maxSensitivity,
      });
      expect(counts[open.id]).toBe(await mentions({ maxSensitivity }));
    }
    // queryFacts' ceiling (GET /entities/:id linkedFactCount) leaves the restricted fact out.
    const linked = (maxSensitivity: "internal" | "restricted") =>
      adapter.queryFacts({
        workspaceId: ws,
        entityId: open.id,
        status: "active",
        maxSensitivity,
        limit: 1,
      });
    expect((await linked("internal")).total).toBe(1);
    expect((await linked("restricted")).total).toBe(2);
  });

  it("includeMentions links an episode to the entities of the facts the caller may read", async () => {
    const { adapter, pgClient } = v3Adapter();
    const ws = freshWorkspaceId();
    const pay = await adapter.createEntity({ workspaceId: ws, name: "Payments", kind: "concept" });
    const vault = await adapter.createEntity({ workspaceId: ws, name: "Vault", kind: "concept" });
    const fact = (entityId: string, n: number) =>
      adapter.createFact({
        workspaceId: ws,
        scope: "global",
        statement: `fact ${n} about ${entityId}`,
        subject: "x",
        kind: "trait",
        entityId,
      });
    const a = await fact(pay.id, 1);
    const b = await fact(pay.id, 2);
    const hidden = await fact(vault.id, 3);
    // Raised in SQL: storing a restricted fact needs an actor DEK.
    await pgClient.unsafe(
      `UPDATE mnemosyne.mnemo_fact SET sensitivity = 'restricted' WHERE id = $1`,
      [hidden.id]
    );
    const episode = await adapter.createEpisode({
      workspaceId: ws,
      title: "Session",
      narrative: "...",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      linkedFactIds: [a.id, b.id, hidden.id],
    });

    expect((await adapter.getGraphSnapshot({ workspaceId: ws })).edges).toEqual([]);
    const snap = await adapter.getGraphSnapshot({
      workspaceId: ws,
      maxSensitivity: "internal",
      includeMentions: true,
    });
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
    expect(snap.nodes.find((n) => n.id === pay.id)!.mentionCount).toBe(2);
    const all = await adapter.getGraphSnapshot({
      workspaceId: ws,
      maxSensitivity: "restricted",
      includeMentions: true,
    });
    expect(all.edges.map((e) => e.target).sort()).toEqual([pay.id, vault.id].sort());
  });

  it("maxSensitivity keeps episode factCount one statement past the bind-parameter limit", async () => {
    // postgres-js caps a statement near 65k bind parameters. 70k linked ids
    // would overflow a query that binds each id; the count must stay in SQL.
    const { adapter, pgClient } = v3Adapter();
    const ws = freshWorkspaceId();
    const visibleFact = await adapter.createFact({
      workspaceId: ws,
      scope: "global",
      statement: "visible",
      subject: "s",
      kind: "trait",
    });
    const hiddenFact = await adapter.createFact({
      workspaceId: ws,
      scope: "global",
      statement: "hidden",
      subject: "s",
      kind: "trait",
    });
    await pgClient.unsafe(
      `UPDATE mnemosyne.mnemo_fact SET sensitivity = 'restricted' WHERE id = $1`,
      [hiddenFact.id]
    );
    const episode = await adapter.createEpisode({
      workspaceId: ws,
      title: "Long session",
      narrative: "...",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      linkedFactIds: [visibleFact.id, hiddenFact.id],
    });
    await pgClient.unsafe(
      `UPDATE mnemosyne.mnemo_episode
         SET linked_fact_ids = linked_fact_ids || ARRAY(SELECT 'missing_' || g FROM generate_series(1, 70000) g)
       WHERE id = $1`,
      [episode.id]
    );

    const capped = await adapter.getGraphSnapshot({ workspaceId: ws, maxSensitivity: "internal" });
    // Ids that resolve to no fact still count; only the restricted one is left out.
    expect(capped.nodes.find((n) => n.id === episode.id)!.factCount).toBe(70_001);

    const admin = await adapter.getGraphSnapshot({ workspaceId: ws, maxSensitivity: "restricted" });
    expect(admin.nodes.find((n) => n.id === episode.id)!.factCount).toBe(70_002);
  });

  it("focusEntityId restricts the snapshot to the entity + its 1-hop neighbourhood", async () => {
    const { adapter } = v3Adapter();
    const ws = freshWorkspaceId();

    const hub = await adapter.createEntity({ workspaceId: ws, name: "Hub", kind: "concept" });
    const neighbor = await adapter.createEntity({
      workspaceId: ws,
      name: "Neighbor",
      kind: "concept",
    });
    const stranger = await adapter.createEntity({
      workspaceId: ws,
      name: "Stranger",
      kind: "concept",
    });

    await adapter.createRelation({
      workspaceId: ws,
      sourceId: hub.id,
      sourceType: "entity",
      targetId: neighbor.id,
      targetType: "entity",
      verb: "related",
    });

    const snapshot = await adapter.getGraphSnapshot({ workspaceId: ws, focusEntityId: hub.id });
    const nodeIds = snapshot.nodes.map((n) => n.id).sort();
    expect(nodeIds).toEqual([hub.id, neighbor.id].sort());
    expect(nodeIds).not.toContain(stranger.id);
    expect(snapshot.meta.relationCount).toBe(1);
  });
});

describe("traverseGraph/findGraphPath — real DrizzleStorageAdapter.getRelations, undirected", () => {
  it("traverses an undirected multi-hop chain built from alternating source/target direction", async () => {
    const { adapter } = v3Adapter();
    const ws = freshWorkspaceId();

    const a = await adapter.createEntity({ workspaceId: ws, name: "A", kind: "concept" });
    const b = await adapter.createEntity({ workspaceId: ws, name: "B", kind: "concept" });
    const c = await adapter.createEntity({ workspaceId: ws, name: "C", kind: "concept" });

    // A -> B (A is source), C -> B (C is source, so the B-C edge is
    // "reversed" relative to a naive sourceIds-only walk from A through B).
    await adapter.createRelation({
      workspaceId: ws,
      sourceId: a.id,
      sourceType: "entity",
      targetId: b.id,
      targetType: "entity",
      verb: "related",
    });
    await adapter.createRelation({
      workspaceId: ws,
      sourceId: c.id,
      sourceType: "entity",
      targetId: b.id,
      targetType: "entity",
      verb: "related",
    });

    const hits = await traverseGraph({ storage: adapter }, ws, a.id, { maxHops: 2 });
    expect(hits).toEqual([
      { id: b.id, hop: 1, relevance: 0.6 },
      { id: c.id, hop: 2, relevance: 0.36 },
    ]);
  });

  it("finds the shortest undirected path through the same chain", async () => {
    const { adapter } = v3Adapter();
    const ws = freshWorkspaceId();

    const a = await adapter.createEntity({ workspaceId: ws, name: "A", kind: "concept" });
    const b = await adapter.createEntity({ workspaceId: ws, name: "B", kind: "concept" });
    const c = await adapter.createEntity({ workspaceId: ws, name: "C", kind: "concept" });

    await adapter.createRelation({
      workspaceId: ws,
      sourceId: a.id,
      sourceType: "entity",
      targetId: b.id,
      targetType: "entity",
      verb: "related",
    });
    await adapter.createRelation({
      workspaceId: ws,
      sourceId: c.id,
      sourceType: "entity",
      targetId: b.id,
      targetType: "entity",
      verb: "related",
    });

    const result = await findGraphPath({ storage: adapter }, ws, a.id, c.id, { maxHops: 4 });
    expect(result.path).toEqual([a.id, b.id, c.id]);
    expect(result.edges).toEqual([
      { source: a.id, target: b.id, relation: "related" },
      { source: c.id, target: b.id, relation: "related" },
    ]);
  });

  it("maxSensitivity stops traversal and paths at a node above the ceiling", async () => {
    const { adapter } = v3Adapter();
    const ws = freshWorkspaceId();
    const a = await adapter.createEntity({ workspaceId: ws, name: "A", kind: "concept" });
    const b = await adapter.createEntity({ workspaceId: ws, name: "B", kind: "concept" });
    const c = await adapter.createEntity({ workspaceId: ws, name: "C", kind: "concept" });
    const secret = await adapter.createEntity({
      workspaceId: ws,
      name: "Secret",
      kind: "concept",
      sensitivity: "restricted",
    });
    // A - B, and A - Secret - C: C is reachable only through the hidden node.
    for (const [sourceId, targetId] of [
      [a.id, b.id],
      [a.id, secret.id],
      [c.id, secret.id],
    ] as const) {
      await adapter.createRelation({
        workspaceId: ws,
        sourceId,
        sourceType: "entity",
        targetId,
        targetType: "entity",
        verb: "related",
      });
    }
    const deps = { storage: adapter };
    const capped = { maxSensitivity: "internal" as const };

    expect(await traverseGraph(deps, ws, a.id, { maxHops: 3, ...capped })).toEqual([
      { id: b.id, hop: 1, relevance: 0.6 },
    ]);
    expect(await traverseGraph(deps, ws, secret.id, { maxHops: 3, ...capped })).toEqual([]);
    expect(await findGraphPath(deps, ws, a.id, c.id, { maxHops: 4, ...capped })).toEqual({
      path: [],
      edges: [],
    });

    const open = { maxSensitivity: "restricted" as const };
    const all = await traverseGraph(deps, ws, a.id, { maxHops: 3, ...open });
    expect(all.map((h) => h.id).sort()).toEqual([b.id, secret.id, c.id].sort());
    expect((await findGraphPath(deps, ws, a.id, c.id, { maxHops: 4, ...open })).path).toEqual([
      a.id,
      secret.id,
      c.id,
    ]);
  });

  it("does not cross workspace boundaries (RLS)", async () => {
    const { adapter } = v3Adapter();
    const wsA = freshWorkspaceId();
    const wsB = freshWorkspaceId();

    const a = await adapter.createEntity({ workspaceId: wsA, name: "A", kind: "concept" });
    const b = await adapter.createEntity({ workspaceId: wsA, name: "B", kind: "concept" });
    await adapter.createRelation({
      workspaceId: wsA,
      sourceId: a.id,
      sourceType: "entity",
      targetId: b.id,
      targetType: "entity",
      verb: "related",
    });

    const hitsFromOtherWorkspace = await traverseGraph({ storage: adapter }, wsB, a.id, {
      maxHops: 2,
    });
    expect(hitsFromOtherWorkspace).toEqual([]);
  });
});
