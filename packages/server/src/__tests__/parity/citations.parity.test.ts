/**
 * Tier A parity — GET /citations (design.md D3).
 *
 * HTTP characterization contract for `packages/server/src/routes/citations.ts`.
 * Originally written and merged green against the legacy
 * `deps.core.listCitations` (`CoreLike`) implementation; the port commit
 * (flatten-legacy-dual-core PR9e, design.md D6.5) swapped the route to
 * `deps.storage.listCitations` (v3 `StorageAdapter`). Per D3, every
 * `expect(...)` line below is unchanged by the port — only `buildApp`'s
 * deps-fake wiring changed (`core: { listCitations }` ->
 * `storage: { listCitations }`), same pattern `decisions.parity.test.ts`
 * (PR8) established.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { loadSchema, validate } from "../_schemaValidate.js";
import { mountCitations } from "../../routes/citations.js";

const PLAINTEXT_KEY = "mns_live_citationsparitytest0001";
const WS_ID = "00000000-0000-0000-0000-000000000c01";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "citations-key-001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, ...extra };
}

const NOW = "2026-06-20T00:00:00.000Z"; // determinism-ok: fixed fixture timestamp, not derived from Date.now()

function citationRecord(id: string) {
  return {
    id,
    workspaceId: WS_ID,
    memoryKind: "fact" as const,
    memoryId: "fact_abc",
    sourceKind: "message" as const,
    sourceId: "msg_1",
    extractorModel: "gpt-x",
    extractorPromptVersion: "v1",
    judgeModel: null,
    judgeRelationId: null,
    evidenceExcerpt: "the evidence text",
    createdAt: NOW,
  };
}

async function buildApp(listCitations = vi.fn().mockResolvedValue([citationRecord("cit_1")])) {
  const deps = {
    storage: { listCitations },
    apiKeys: await makeKeyLookup(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountCitations]);
  return { app, deps, listCitations };
}

describe("Tier A parity: GET /citations", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/citations");
    expect(res.status).toBe(401);
  });

  it("returns 200 with items conforming to citation.schema.json", async () => {
    const citationSchema = loadSchema("citation");
    const { app } = await buildApp();
    const res = await app.request("/citations", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      const err = validate(item, citationSchema);
      expect(err).toBeNull();
    }
  });

  it("forwards workspaceId + default limit (50) to deps.core.listCitations", async () => {
    const { app, listCitations } = await buildApp();
    await app.request("/citations", { headers: authed() });
    expect(listCitations).toHaveBeenCalledWith({ workspaceId: WS_ID, limit: 50 });
  });

  it("forwards memoryKind + memoryId + limit query params", async () => {
    const { app, listCitations } = await buildApp();
    await app.request("/citations?memoryKind=decision&memoryId=dec_1&limit=10", {
      headers: authed(),
    });
    expect(listCitations).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      memoryKind: "decision",
      memoryId: "dec_1",
      limit: 10,
    });
  });

  it("returns 400 on an invalid memoryKind enum value", async () => {
    const { app } = await buildApp();
    const res = await app.request("/citations?memoryKind=not_a_kind", { headers: authed() });
    expect(res.status).toBe(400);
  });

  it("returns 400 when limit exceeds the max (500)", async () => {
    const { app } = await buildApp();
    const res = await app.request("/citations?limit=501", { headers: authed() });
    expect(res.status).toBe(400);
  });

  it("returns an empty items array when the store has no matches", async () => {
    const { app } = await buildApp(vi.fn().mockResolvedValue([]));
    const res = await app.request("/citations", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});
