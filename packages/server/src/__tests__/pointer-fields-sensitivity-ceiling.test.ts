/**
 * A response never names a row above the caller's ceiling by id: a fact's
 * linkedMemoryIds and mergedIntoId, an episode's linkedFactIds (and its
 * linkedFacts), an entity's canonicalId and a decision's supersededById drop a
 * hidden target — a list leaves it out, a single field reads null, as a
 * missing target does. A caller whose ceiling admits every tier sees them all.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { MnemoFact } from "@mnemo-ai/types";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { mountFacts } from "../routes/facts.js";
import { mountEntities } from "../routes/entities.js";
import { mountEpisodes } from "../routes/episodes.js";
import { mountDecisions } from "../routes/decisions.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_pointerceiling000000001";
const WS = "00000000-0000-0000-0000-000000000905";

async function makeApp() {
  const storage = new InMemoryStorageAdapter();
  const facts = (storage as unknown as { state: { facts: Map<string, MnemoFact> } }).state.facts;
  const fact = (statement: string, sensitivity: "internal" | "restricted", entityId?: string) =>
    storage.createFact({
      workspaceId: WS,
      scope: "global",
      statement,
      subject: "s",
      kind: "trait",
      sensitivity,
      ...(entityId ? { entityId } : {}),
    });
  const entity = (name: string, sensitivity: "internal" | "restricted") =>
    storage.createEntity({ workspaceId: WS, name, kind: "concept", sensitivity });
  const decision = (title: string, sensitivity: "internal" | "restricted") =>
    storage.createDecision({ workspaceId: WS, title, body: "...", kind: "decision", sensitivity });

  const holder = await entity("Holder", "internal");
  const secretEntity = await entity("Secret", "restricted");
  const duplicate = await entity("Duplicate", "internal");
  await storage.updateEntity(duplicate.id, { workspaceId: WS, canonicalId: secretEntity.id });

  const shown = await fact("A visible fact", "internal");
  const secret = await fact("A restricted fact", "restricted");
  const linker = await fact("A fact that links both", "internal", holder.id);
  facts.get(linker.id)!.linkedMemoryIds = [shown.id, secret.id, secretEntity.id];
  const merged = await fact("A fact merged into a hidden one", "internal");
  Object.assign(facts.get(merged.id)!, { status: "merged", mergedIntoId: secret.id });

  const created = await storage.createEpisode({
    workspaceId: WS,
    title: "A session",
    narrative: "...",
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    linkedFactIds: [shown.id, secret.id],
  });
  // GET /episodes/:id takes the pipeline's mepi_ ids only; the fake mints uuids.
  const episodes = (storage as unknown as { state: { episodes: Map<string, typeof created> } })
    .state.episodes;
  const episode = { ...created, id: "mepi_pointer_ceiling" };
  episodes.delete(created.id);
  episodes.set(episode.id, episode);

  const old = await decision("Old way", "internal");
  const hiddenSuccessor = await decision("Secret way", "restricted");
  await storage.updateDecision(old.id, {
    workspaceId: WS,
    status: "superseded",
    supersededById: hiddenSuccessor.id,
  });

  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [
      {
        id: "key001",
        keyHash,
        workspaceId: WS,
        scopes: ["memory:read", "memory:write", "memory:admin"],
        plan: "free",
      },
    ],
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const app = buildMountHarness({ apiKeys, storage } as unknown as ServerDeps, [
    mountFacts,
    mountEntities,
    mountEpisodes,
    mountDecisions,
  ]);
  const get = async (path: string) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${PLAINTEXT_KEY}` } });
    expect(res.status).toBe(200);
    return (await res.json()) as never;
  };
  return {
    storage,
    get,
    shown,
    secret,
    secretEntity,
    linker,
    merged,
    holder,
    duplicate,
    episode,
    old,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

type Fact = { id: string; linkedMemoryIds: string[]; mergedIntoId: string | null };

describe("id pointers — default ceiling (internal)", () => {
  it("GET /facts drops hidden linkedMemoryIds and a hidden mergedIntoId", async () => {
    const { get, shown, linker, merged } = await makeApp();
    const { items } = (await get("/facts?status=all&limit=50")) as { items: Fact[] };
    expect(items.find((f) => f.id === linker.id)!.linkedMemoryIds).toEqual([shown.id]);
    expect(items.find((f) => f.id === merged.id)!.mergedIntoId).toBeNull();
  });

  it("GET /entities/:id/facts drops hidden linkedMemoryIds", async () => {
    const { get, shown, holder, linker } = await makeApp();
    const { facts } = (await get(`/entities/${holder.id}/facts`)) as { facts: Fact[] };
    expect(facts.find((f) => f.id === linker.id)!.linkedMemoryIds).toEqual([shown.id]);
  });

  it("GET /episodes and GET /episodes/:id name no hidden linked fact", async () => {
    const { get, shown, secret, episode } = await makeApp();
    const list = (await get("/episodes?includeSynthetic=true")) as {
      items: Array<{ id: string; linkedFactIds: string[] }>;
    };
    expect(list.items.find((e) => e.id === episode.id)!.linkedFactIds).toEqual([shown.id]);
    const detail = (await get(`/episodes/${episode.id}`)) as {
      episode: { linkedFactIds: string[] };
      linkedFacts: Fact[];
    };
    expect(detail.episode.linkedFactIds).toEqual([shown.id]);
    expect(detail.linkedFacts.map((f) => f.id)).toEqual([shown.id]);
    expect(JSON.stringify(detail)).not.toContain(secret.id);
  });

  it("GET /episodes/:id/timeline has no fact_linked event for a hidden fact", async () => {
    const { get, shown, secret, episode } = await makeApp();
    const body = (await get(`/episodes/${episode.id}/timeline`)) as {
      events: Array<{ kind: string; detail: { factId?: string } }>;
    };
    const linked = body.events.filter((e) => e.kind === "fact_linked").map((e) => e.detail.factId);
    expect(linked).toEqual([shown.id]);
    expect(JSON.stringify(body)).not.toContain(secret.id);
  });

  it("an entity merged into a hidden canonical reads canonicalId null", async () => {
    const { get, duplicate, secretEntity } = await makeApp();
    const one = (await get(`/entities/${duplicate.id}`)) as {
      entity: { canonicalId: string | null };
    };
    expect(one.entity.canonicalId).toBeNull();
    const list = (await get("/entities?limit=50")) as {
      items: Array<{ id: string; canonicalId: string | null }>;
    };
    expect(JSON.stringify(list)).not.toContain(secretEntity.id);
  });

  it("a decision superseded by a hidden one reads supersededById null", async () => {
    const { get, old } = await makeApp();
    expect(
      ((await get(`/decisions/${old.id}`)) as { supersededById: string | null }).supersededById
    ).toBeNull();
    const list = (await get("/decisions?includeClosed=true")) as {
      items: Array<{ id: string; supersededById: string | null }>;
    };
    expect(list.items.find((d) => d.id === old.id)!.supersededById).toBeNull();
  });
});

describe("id pointers — ceiling restricted", () => {
  it("every pointer is served as stored", async () => {
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted");
    const { get, shown, secret, secretEntity, linker, merged, duplicate, episode, old } =
      await makeApp();
    const { items } = (await get("/facts?status=all&limit=50")) as { items: Fact[] };
    expect(items.find((f) => f.id === linker.id)!.linkedMemoryIds).toEqual([
      shown.id,
      secret.id,
      secretEntity.id,
    ]);
    expect(items.find((f) => f.id === merged.id)!.mergedIntoId).toBe(secret.id);
    const detail = (await get(`/episodes/${episode.id}`)) as {
      episode: { linkedFactIds: string[] };
    };
    expect(detail.episode.linkedFactIds).toEqual([shown.id, secret.id]);
    const ent = (await get(`/entities/${duplicate.id}`)) as { entity: { canonicalId: string } };
    expect(ent.entity.canonicalId).toBe(secretEntity.id);
    const dec = (await get(`/decisions/${old.id}`)) as { supersededById: string };
    expect(dec.supersededById).not.toBeNull();
  });
});
