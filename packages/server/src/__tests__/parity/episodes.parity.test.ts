/**
 * Tier A parity — `routes/episodes.ts`'s handlers (design.md D3): GET
 * /episodes, GET /episodes/:id, GET /episodes/:id/timeline.
 *
 * `POST /episodes` already runs on `deps.storage.createEpisode` before this PR
 * and is not touched here. Originally written and merged green against the
 * legacy core client's `{listEpisodes,getEpisode}` implementation FIRST
 * (flatten-legacy-dual-core PR10).
 *
 * flatten-legacy-dual-core PR15 note (Phase 6c, task 6c.2): `GET
 * /episodes/:id` and `GET /episodes/:id/timeline` are PORTED to
 * `deps.storage.{getEpisode,getFact}` by this PR — the `linkedMemoryIds`
 * port-surface gap PR8/PR10 documented (see legacy-core-usage.test.ts's PR10
 * note) was already fixed by PR9a (D6.2); this PR was the first to actually
 * port these 2 handlers onto it.
 *
 * DISCLOSED exceptions to D3's zero-`expect(...)`-diff rule (composed-calls
 * class, same as `decisions.parity.test.ts`/`relations.parity.test.ts`/
 * `export.parity.test.ts`'s precedent):
 *   - `getEpisode` is now called positionally (`(id, workspaceId)`, matching
 *     `StorageAdapter.getEpisode`'s signature) instead of legacy's
 *     `{workspaceId, id}` options bag, and returns a bare `MnemoEpisode |
 *     null` instead of `{episode, linkedFacts} | null` — the route composes
 *     the linked-facts read itself now (a new `deps.storage.getFact` call
 *     per `linkedFactId`, since `StorageAdapter` has no batched by-id fact
 *     fetch).
 *   - Fixtures switched from wire-shaped (ISO-string `occurredAt`/
 *     `createdAt`/`updatedAt`) to domain-shaped (`Date` fields) — what
 *     `deps.storage.getEpisode`/`getFact` actually return. The
 *     HTTP-observable response shape (ISO strings after JSON
 *     serialization) is unchanged.
 *
 * `GET /episodes`'s tests are UNCHANGED by this PR (already ported in PR10)
 * — `queryEpisodes` returns a `PaginatedResult<MnemoEpisode>`
 * (`{items,total,offset,limit,hasMore}`), not a bare array, and its
 * `EpisodeFilter` uses `after`/`before`/`topics: string[]` instead of
 * legacy's `from`/`to`/`topic: string`. The observable HTTP contract (200 +
 * `{items}`, same query params accepted) is unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { loadSchema, validate } from "../_schemaValidate.js";
import { mountEpisodes } from "../../routes/episodes.js";

const PLAINTEXT_KEY = "mns_live_episodesparitytest0001";
const WS_ID = "00000000-0000-0000-0000-000000000e01";
const EPISODE_ID = "mepi_a23bcdef0123456789ghijkl";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "episodes-key-001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, ...extra };
}

const NOW = "2026-06-20T00:00:00.000Z"; // determinism-ok: fixed fixture timestamp, not derived from Date.now()

// Domain-shaped MnemoEpisode fixture (Date fields) — what
// `deps.storage.{queryEpisodes,getEpisode}` actually return.
function episodeRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WS_ID,
    title: "Q2 planning",
    narrative: "Team discussed the roadmap.",
    occurredAt: new Date(NOW),
    durationMinutes: null,
    participants: [] as string[],
    topics: [] as string[],
    linkedFactIds: [] as string[],
    sourceConversationId: null,
    sensitivity: "internal" as const,
    metadata: {},
    isRoot: true,
    depth: 0,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    validFrom: new Date(NOW),
    isSynthetic: false,
    ...overrides,
  };
}

// Domain-shaped MnemoFact fixture (Date fields) — what
// `deps.storage.getFact` returns for episode.ts's linked-facts resolution.
function factRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WS_ID,
    scope: "global" as const,
    statement: "prefers dark mode",
    subject: "user",
    kind: "preference" as const,
    confidence: 1,
    relevance: 1,
    hitCount: 0,
    worthSuccess: 0,
    worthFailure: 0,
    worthAlpha: 1,
    worthBeta: 1,
    worth: 1,
    memoryType: "semantic" as const,
    memoryStrength: 1,
    memoryStability: 1,
    attribution: "user_stated" as const,
    sourceMessageIds: [] as string[],
    linkedMemoryIds: [] as string[],
    revisionCount: 1,
    protocolVersion: "v3",
    status: "active" as const,
    pinned: false,
    canonical: false,
    sensitivity: "internal" as const,
    embeddingStale: false,
    validFrom: new Date(NOW),
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    metadata: {},
    ...overrides,
  };
}

function paginated(items: unknown[]) {
  return { items, total: items.length, offset: 0, limit: 50, hasMore: false };
}

async function buildApp(
  overrides: {
    queryEpisodes?: ReturnType<typeof vi.fn>;
    getEpisode?: ReturnType<typeof vi.fn>;
    getFact?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const queryEpisodes =
    overrides.queryEpisodes ?? vi.fn().mockResolvedValue(paginated([episodeRecord(EPISODE_ID)]));
  const getEpisode = overrides.getEpisode ?? vi.fn().mockResolvedValue(episodeRecord(EPISODE_ID));
  const getFact = overrides.getFact ?? vi.fn().mockResolvedValue(null);

  const deps = {
    // Nothing above the ceiling here: the pointer check finds no hidden id.
    storage: { queryEpisodes, getEpisode, getFact, findHiddenIds: vi.fn().mockResolvedValue([]) },
    apiKeys: await makeKeyLookup(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountEpisodes]);
  return { app, deps, queryEpisodes, getEpisode, getFact };
}

describe("Tier A parity: GET /episodes", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/episodes");
    expect(res.status).toBe(401);
  });

  it("returns 200 with items conforming to episode.schema.json", async () => {
    const schema = loadSchema("episode");
    const { app } = await buildApp();
    const res = await app.request("/episodes", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      const err = validate(item, schema);
      expect(err).toBeNull();
    }
  });

  it("forwards workspaceId + default limit (50), default excludes synthetic", async () => {
    const { app, queryEpisodes } = await buildApp();
    await app.request("/episodes", { headers: authed() });
    expect(queryEpisodes).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      limit: 50,
      isSynthetic: false,
    });
  });

  it("forwards from/to/topic as after/before/topics; includeSynthetic=true drops the isSynthetic filter", async () => {
    const { app, queryEpisodes } = await buildApp();
    await app.request(
      "/episodes?from=2026-01-01T00%3A00%3A00Z&to=2026-06-01T00%3A00%3A00Z&topic=roadmap&includeSynthetic=true&limit=5",
      { headers: authed() }
    );
    expect(queryEpisodes).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      after: new Date("2026-01-01T00:00:00Z"),
      before: new Date("2026-06-01T00:00:00Z"),
      topics: ["roadmap"],
      limit: 5,
    });
  });

  it("filters out items above the sensitivity ceiling", async () => {
    const { app } = await buildApp({
      queryEpisodes: vi
        .fn()
        .mockResolvedValue(paginated([episodeRecord(EPISODE_ID, { sensitivity: "restricted" })])),
    });
    const res = await app.request("/episodes", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("returns 400 on an invalid limit", async () => {
    const { app } = await buildApp();
    const res = await app.request("/episodes?limit=0", { headers: authed() });
    expect(res.status).toBe(400);
  });
});

describe("Tier A parity: GET /episodes/:id", () => {
  it("returns 200 with {episode, linkedFacts}", async () => {
    const { app, getEpisode } = await buildApp();
    const res = await app.request(`/episodes/${EPISODE_ID}`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { episode: unknown; linkedFacts: unknown[] };
    expect(body.episode).toMatchObject({ id: EPISODE_ID });
    expect(Array.isArray(body.linkedFacts)).toBe(true);
    expect(getEpisode).toHaveBeenCalledWith(EPISODE_ID, WS_ID);
  });

  it("resolves linkedFactIds via per-id getFact, skipping ids that no longer resolve", async () => {
    const getFact = vi.fn().mockResolvedValueOnce(factRecord("fact_1")).mockResolvedValueOnce(null);
    const { app } = await buildApp({
      getEpisode: vi
        .fn()
        .mockResolvedValue(episodeRecord(EPISODE_ID, { linkedFactIds: ["fact_1", "fact_gone"] })),
      getFact,
    });
    const res = await app.request(`/episodes/${EPISODE_ID}`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { linkedFacts: Array<{ id: string }> };
    expect(body.linkedFacts.map((f) => f.id)).toEqual(["fact_1"]);
    expect(getFact).toHaveBeenCalledWith("fact_1", WS_ID);
    expect(getFact).toHaveBeenCalledWith("fact_gone", WS_ID);
  });

  it("includes an archived (validTo set) linked fact — matches legacy's filter-free inArray resolution", async () => {
    const { app } = await buildApp({
      getEpisode: vi
        .fn()
        .mockResolvedValue(episodeRecord(EPISODE_ID, { linkedFactIds: ["fact_archived"] })),
      getFact: vi
        .fn()
        .mockResolvedValue(
          factRecord("fact_archived", { validTo: new Date(NOW), status: "forgotten" })
        ),
    });
    const res = await app.request(`/episodes/${EPISODE_ID}`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { linkedFacts: Array<{ id: string }> };
    expect(body.linkedFacts.map((f) => f.id)).toEqual(["fact_archived"]);
  });

  it("returns 404 when the episode doesn't exist", async () => {
    const { app } = await buildApp({ getEpisode: vi.fn().mockResolvedValue(null) });
    const res = await app.request(`/episodes/${EPISODE_ID}`, { headers: authed() });
    expect(res.status).toBe(404);
  });

  it("returns 404 (not 403) above the sensitivity ceiling", async () => {
    const { app } = await buildApp({
      getEpisode: vi
        .fn()
        .mockResolvedValue(episodeRecord(EPISODE_ID, { sensitivity: "restricted" })),
    });
    const res = await app.request(`/episodes/${EPISODE_ID}`, { headers: authed() });
    expect(res.status).toBe(404);
  });

  it("returns 400 on a malformed id", async () => {
    const { app } = await buildApp();
    const res = await app.request(`/episodes/not-a-valid-id`, { headers: authed() });
    expect(res.status).toBe(400);
  });
});

describe("Tier A parity: GET /episodes/:id/timeline", () => {
  it("returns 200 with chronological events", async () => {
    const { app } = await buildApp({
      getEpisode: vi
        .fn()
        .mockResolvedValue(
          episodeRecord(EPISODE_ID, { createdAt: new Date(NOW), linkedFactIds: ["fact_1"] })
        ),
      getFact: vi
        .fn()
        .mockResolvedValue(
          factRecord("fact_1", { createdAt: new Date("2026-06-19T00:00:00.000Z") })
        ),
    });
    const res = await app.request(`/episodes/${EPISODE_ID}/timeline`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ kind: string }> };
    expect(body.events.map((e) => e.kind)).toEqual(["fact_linked", "episode_created"]);
  });

  it("returns 404 when the episode doesn't exist", async () => {
    const { app } = await buildApp({ getEpisode: vi.fn().mockResolvedValue(null) });
    const res = await app.request(`/episodes/${EPISODE_ID}/timeline`, { headers: authed() });
    expect(res.status).toBe(404);
  });
});
