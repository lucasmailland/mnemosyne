import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { buildMountHarness } from "./_mountHarness.js";
import { mountFacts } from "../routes/facts.js";

const KEY = "mns_live_factprovenancetest0001";
const WS = "00000000-0000-0000-0000-000000001102";
const T0 = new Date("2026-06-20T00:00:00.000Z"); // determinism-ok: fixed fixture
const T1 = new Date("2026-06-21T00:00:00.000Z"); // determinism-ok: fixed fixture
const T2 = new Date("2026-06-22T00:00:00.000Z"); // determinism-ok: fixed fixture

async function keys(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "prov-key", keyHash, workspaceId: WS, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function fact(id: string, o: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WS,
    scope: "global",
    statement: `stmt ${id}`,
    subject: "user",
    kind: "preference",
    confidence: 1,
    revisionCount: 1,
    status: "active",
    pinned: false,
    sensitivity: "internal",
    validFrom: T0,
    createdAt: T0,
    updatedAt: T0,
    metadata: {},
    ...o,
  };
}

const closed = (id: string, o: Record<string, unknown> = {}) =>
  fact(id, { status: "forgotten", validTo: T1, ...o });

function rel(sourceId: string, targetId: string, createdAt: Date) {
  return {
    id: `r-${sourceId}-${targetId}`,
    workspaceId: WS,
    sourceId,
    targetId,
    verb: "supersedes",
    createdAt,
  };
}

async function build(
  facts: Record<string, unknown>,
  relations: unknown[] = [],
  episodes: Record<string, unknown> = {}
) {
  const getFact = vi.fn(async (id: string) => facts[id] ?? null);
  const getRelations = vi.fn(async (f: { sourceId?: string; targetId?: string }) =>
    (relations as Array<{ sourceId: string; targetId: string }>).filter(
      (r) =>
        (f.targetId ? r.targetId === f.targetId : true) &&
        (f.sourceId ? r.sourceId === f.sourceId : true)
    )
  );
  const getEpisode = vi.fn(async (id: string) => episodes[id] ?? null);
  // Default ceiling (internal): a restricted episode or fact is hidden.
  const findHiddenIds = vi.fn(async ({ ids }: { ids: string[] }) =>
    ids.filter((id) => {
      const row = (episodes[id] ?? facts[id]) as { sensitivity?: string } | undefined;
      return row?.sensitivity === "restricted";
    })
  );
  const deps = {
    storage: { getFact, getRelations, getEpisode, findHiddenIds },
    apiKeys: await keys(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountFacts]);
  const get = (id: string, qs = "") =>
    app.request(`/facts/${id}${qs}`, { headers: { authorization: `Bearer ${KEY}` } });
  return { get, getFact, getRelations, getEpisode };
}

const Q = "?includeClosed=true&provenance=true";

describe("GET /facts/:id closed + provenance", () => {
  it("active fact without flags: unchanged body, no extra lookups", async () => {
    const { get, getRelations, getEpisode } = await build({ a: fact("a", { episodeId: "e1" }) });
    const res = await get("a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("sessionId");
    expect(body).not.toHaveProperty("supersededById");
    expect(body).not.toHaveProperty("supersedesIds");
    expect(getRelations).not.toHaveBeenCalled();
    expect(getEpisode).not.toHaveBeenCalled();
  });

  it("closed fact: 404 without includeClosed, 200 with it (no provenance lookups)", async () => {
    const { get, getRelations, getEpisode } = await build({ c: closed("c") });
    expect((await get("c")).status).toBe(404);
    expect((await get("c", "?includeClosed=true")).status).toBe(200);
    expect(getRelations).not.toHaveBeenCalled();
    expect(getEpisode).not.toHaveBeenCalled();
  });

  it("closed fact above the ceiling still 404s with includeClosed", async () => {
    const { get } = await build({ c: closed("c", { sensitivity: "restricted" }) });
    expect((await get("c", Q)).status).toBe(404);
  });

  it("supersede chain: newest successor id and its createdAt", async () => {
    const { get, getRelations } = await build(
      { old: closed("old"), s1: fact("s1", { createdAt: T1 }), s2: fact("s2", { createdAt: T2 }) },
      [rel("s1", "old", T1), rel("s2", "old", T2)]
    );
    const body = (await (await get("old", Q)).json()) as Record<string, unknown>;
    expect(body.supersededById).toBe("s2");
    expect(body.supersededAt).toBe(T2.toISOString());
    expect(getRelations).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        targetId: "old",
        verb: "supersedes",
        openOnly: false,
      })
    );
  });

  it("merged fact: supersededById is mergedIntoId", async () => {
    const { get } = await build({
      m: closed("m", { status: "merged", mergedIntoId: "t" }),
      t: fact("t", { createdAt: T2 }),
    });
    const body = (await (await get("m", Q)).json()) as Record<string, unknown>;
    expect(body.supersededById).toBe("t");
    expect(body.supersededAt).toBe(T2.toISOString());
  });

  it("closed fact with no successor: supersededById null, supersededAt omitted", async () => {
    const { get } = await build({ c: closed("c") });
    const body = (await (await get("c", Q)).json()) as Record<string, unknown>;
    expect(body.supersededById).toBeNull();
    expect(body).not.toHaveProperty("supersededAt");
  });

  it("active fact: supersededById omitted", async () => {
    const { get } = await build({ a: fact("a") });
    const body = (await (await get("a", Q)).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("supersededById");
  });

  it("successor above the ceiling reads like no successor, main fact still 200", async () => {
    const { get } = await build(
      { old: closed("old"), s: fact("s", { sensitivity: "restricted" }) },
      [rel("s", "old", T1)]
    );
    const res = await get("old", Q);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.supersededById).toBeNull();
    expect(body).not.toHaveProperty("supersededAt");
  });

  it("supersedesIds lists targets newest first, dropping those above the ceiling", async () => {
    const { get } = await build(
      {
        n: fact("n"),
        p1: closed("p1"),
        p2: closed("p2"),
        p3: closed("p3", { sensitivity: "restricted" }),
      },
      [rel("n", "p1", T0), rel("n", "p2", T2), rel("n", "p3", T1)]
    );
    const body = (await (await get("n", Q)).json()) as Record<string, unknown>;
    expect(body.supersedesIds).toEqual(["p2", "p1"]);
  });

  it("sessionId: episode sourceConversationId, else fact.sessionId; above ceiling null; no episode uses fact.sessionId", async () => {
    const { get } = await build(
      {
        a: fact("a", { episodeId: "e1", sessionId: "fs" }),
        b: fact("b", { episodeId: "e2", sessionId: "fs" }),
        c: fact("c", { episodeId: "e3", sessionId: "fs" }),
        d: fact("d", { sessionId: "ds" }),
        e: fact("e"),
      },
      [],
      {
        e1: { id: "e1", sensitivity: "internal", sourceConversationId: "conv" },
        e2: { id: "e2", sensitivity: "internal" },
        e3: { id: "e3", sensitivity: "restricted", sourceConversationId: "secret" },
      }
    );
    const j = async (id: string) => (await (await get(id, Q)).json()) as Record<string, unknown>;
    expect((await j("a")).sessionId).toBe("conv");
    expect((await j("b")).sessionId).toBe("fs");
    expect((await j("c")).sessionId).toBeNull();
    // …and the hidden episode is not named by episodeId either.
    expect((await j("c")).episodeId).toBeNull();
    expect((await j("a")).episodeId).toBe("e1");
    expect((await j("d")).sessionId).toBe("ds");
    expect((await j("e")).sessionId).toBeNull();
  });

  it("lenient flags: 1 / yes / empty are ignored (200, default body, no lookups)", async () => {
    const { get, getRelations, getEpisode } = await build({ a: fact("a"), c: closed("c") });
    for (const qs of [
      "?includeClosed=1",
      "?provenance=yes",
      "?includeClosed=&provenance=",
      "?provenance=false",
    ]) {
      const res = await get("a", qs);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("sessionId");
      expect(body).not.toHaveProperty("supersedesIds");
    }
    expect((await get("c", "?includeClosed=1")).status).toBe(404);
    expect(getRelations).not.toHaveBeenCalled();
    expect(getEpisode).not.toHaveBeenCalled();
  });
});
