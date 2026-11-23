/**
 * Every other read of relations, hyperedges and entity counts honours the
 * caller's sensitivity ceiling, like GET /graph and the traversals: a capped
 * caller never sees a relation or hyperedge that touches a node above it, can't
 * change one by id, and gets counts built from visible rows only. The real
 * in-memory adapter sits behind the routes.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { GraphSnapshot } from "@mnemo-ai/types";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { mountGraph } from "../routes/graph.js";
import { mountRelations } from "../routes/relations.js";
import { mountHyperedges } from "../routes/hyperedges.js";
import { mountEntities } from "../routes/entities.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_graphreadsceiling0000001";
const WS_ID = "00000000-0000-0000-0000-000000000904";

async function makeApp() {
  const storage = new InMemoryStorageAdapter();
  const entity = (name: string, sensitivity?: "restricted") =>
    storage.createEntity({
      workspaceId: WS_ID,
      name,
      kind: "concept",
      ...(sensitivity ? { sensitivity } : {}),
    });
  const a = await entity("A");
  const b = await entity("B");
  const c = await entity("C");
  const secret = await entity("Secret", "restricted");
  const relate = (
    sourceId: string,
    targetId: string,
    sourceType = "entity",
    targetType = "entity"
  ) =>
    storage.createRelation({
      workspaceId: WS_ID,
      sourceId,
      sourceType: sourceType as "entity",
      targetId,
      targetType: targetType as "entity",
      verb: "related",
    });
  const shownRel = await relate(a.id, b.id);
  const hiddenRel = await relate(a.id, secret.id);
  await relate(secret.id, c.id);
  for (const sensitivity of ["internal", "restricted"] as const) {
    await storage.createFact({
      workspaceId: WS_ID,
      scope: "global",
      statement: `A fact (${sensitivity})`,
      subject: "A",
      kind: "trait",
      entityId: a.id,
      sensitivity,
    });
    const episode = await storage.createEpisode({
      workspaceId: WS_ID,
      title: `A session (${sensitivity})`,
      narrative: "...",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      sensitivity,
    });
    await relate(episode.id, a.id, "episode", "entity");
  }
  const shownHyper = await storage.createHyperedge({
    workspaceId: WS_ID,
    memberIds: [a.id, b.id, c.id],
  });
  const hiddenHyper = await storage.createHyperedge({
    workspaceId: WS_ID,
    memberIds: [a.id, b.id, secret.id],
  });

  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [
      {
        id: "key001",
        keyHash,
        workspaceId: WS_ID,
        scopes: ["memory:read", "memory:write"],
        plan: "free",
      },
    ],
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const app = buildMountHarness({ apiKeys, storage } as unknown as ServerDeps, [
    mountGraph,
    mountRelations,
    mountHyperedges,
    mountEntities,
  ]);
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await app.request(path, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json" },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, json: (text ? JSON.parse(text) : null) as never };
  };
  return { storage, call, a, b, c, secret, shownRel, hiddenRel, shownHyper, hiddenHyper };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("relations — default ceiling (internal)", () => {
  it("GET /relations lists no relation that touches a hidden node", async () => {
    const { call, a, c, secret, shownRel } = await makeApp();
    const all = await call("/relations");
    expect(all.status).toBe(200);
    expect(all.text).not.toContain(secret.id);
    const fromA = await call(`/relations?sourceId=${a.id}`);
    expect((fromA.json as { items: Array<{ id: string }> }).items.map((r) => r.id)).toEqual([
      shownRel.id,
    ]);
    expect((await call(`/relations?targetId=${c.id}`)).json).toEqual({ items: [] });
  });

  it("PATCH and DELETE /relations/:id answer 404 for a hidden relation and leave it as it was", async () => {
    const { storage, call, a, hiddenRel } = await makeApp();
    const patch = await call(`/relations/${hiddenRel.id}`, {
      method: "PATCH",
      body: { relation: "part_of", markedByKind: "user" },
    });
    expect(patch.status).toBe(404);
    expect(patch.text).not.toContain(hiddenRel.targetId);
    expect((await call(`/relations/${hiddenRel.id}`, { method: "DELETE" })).status).toBe(404);
    const [stored] = (await storage.getRelations({ workspaceId: WS_ID, sourceId: a.id })).filter(
      (r) => r.id === hiddenRel.id
    );
    expect(stored).toMatchObject({ verb: "related", validTo: null });
  });
});

describe("hyperedges — default ceiling (internal)", () => {
  it("GET /hyperedges hides a hyperedge with a hidden member, from items and total", async () => {
    const { call, secret, shownHyper } = await makeApp();
    const res = await call("/hyperedges");
    const body = res.json as { items: Array<{ id: string }>; total: number };
    expect(body.items.map((h) => h.id)).toEqual([shownHyper.id]);
    expect(body.total).toBe(1);
    expect(res.text).not.toContain(secret.id);
  });

  it("GET, PATCH and DELETE /hyperedges/:id answer 404 for it and leave it as it was", async () => {
    const { storage, call, hiddenHyper } = await makeApp();
    expect((await call(`/hyperedges/${hiddenHyper.id}`)).status).toBe(404);
    expect(
      (await call(`/hyperedges/${hiddenHyper.id}`, { method: "PATCH", body: { label: "x" } }))
        .status
    ).toBe(404);
    expect((await call(`/hyperedges/${hiddenHyper.id}`, { method: "DELETE" })).status).toBe(404);
    const stored = await storage.getHyperedge(hiddenHyper.id, WS_ID);
    expect(stored!.label ?? null).toBe(hiddenHyper.label ?? null); // the PATCH set none of it
    expect(stored!.validTo ?? null).toBeNull();
  });
});

describe("entity counts — default ceiling (internal)", () => {
  it("GET /entities and GET /entities/:id count only visible mentions and facts, as GET /graph does", async () => {
    const { call, a } = await makeApp();
    const graph = (await call("/graph")).json as GraphSnapshot;
    const graphMentions = graph.nodes.find((n) => n.id === a.id)!.mentionCount;
    // One visible fact + one visible episode.
    expect(graphMentions).toBe(2);

    const list = (await call("/entities")).json as {
      items: Array<{ id: string; mentionCount: number }>;
    };
    expect(list.items.find((e) => e.id === a.id)!.mentionCount).toBe(graphMentions);

    const detail = (await call(`/entities/${a.id}`)).json as {
      entity: { mentionCount: number };
      linkedFactCount: number;
    };
    expect(detail.entity.mentionCount).toBe(graphMentions);
    expect(detail.linkedFactCount).toBe(1);
  });
});

describe("entity writes — default ceiling (internal)", () => {
  it("PATCH /entities/:id answers 404 for a hidden entity and leaves it as it was", async () => {
    const { storage, call, secret } = await makeApp();
    const res = await call(`/entities/${secret.id}`, {
      method: "PATCH",
      body: { name: "Renamed" },
    });
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("Secret");
    expect((await storage.getEntity(secret.id, WS_ID))!.name).toBe("Secret");
  });

  it("a hidden canonicalId target answers exactly like one that does not exist", async () => {
    const { storage, call, a, secret } = await makeApp();
    const hidden = await call(`/entities/${a.id}`, {
      method: "PATCH",
      body: { canonicalId: secret.id },
    });
    const missing = await call(`/entities/${a.id}`, {
      method: "PATCH",
      body: { canonicalId: "ment_doesnotexist000000000000" },
    });
    expect(hidden.status).toBe(400);
    expect(hidden.status).toBe(missing.status);
    expect((await storage.getEntity(a.id, WS_ID))!.canonicalId).toBeUndefined();
    expect((hidden.json as { error: unknown }).error).toEqual(
      (missing.json as { error: unknown }).error
    );
  });
});

describe("ceiling raised to restricted", () => {
  it("sees every relation, hyperedge and mention", async () => {
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted");
    const { call, a, hiddenHyper } = await makeApp();
    expect((await call(`/relations?sourceId=${a.id}`)).json).toMatchObject({
      items: expect.arrayContaining([expect.anything(), expect.anything()]),
    });
    expect(((await call("/hyperedges")).json as { total: number }).total).toBe(2);
    expect((await call(`/hyperedges/${hiddenHyper.id}`)).status).toBe(200);
    const detail = (await call(`/entities/${a.id}`)).json as {
      entity: { mentionCount: number };
      linkedFactCount: number;
    };
    expect(detail.entity.mentionCount).toBe(4);
    expect(detail.linkedFactCount).toBe(2);
  });
});
