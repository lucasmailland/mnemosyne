/**
 * Tier A parity — `routes/governance.ts` (design.md D3).
 *
 * HTTP characterization contract for GET /governance/worth,
 * POST /governance/gate, GET /governance/drift. `GET /governance/worth` and
 * `GET /governance/drift` already used `deps.storage`/`getHealthSnapshot`
 * before this PR (not `deps.core`) — this file only exercises the
 * `deps.core`->`deps.storage` port for `POST /governance/gate`
 * (`getFact`+`pinFact` -> `getFact`+`updateFact`). Written and merged green
 * against the legacy `deps.core.{getFact,pinFact}` implementation FIRST
 * (flatten-legacy-dual-core PR11); the port commit in this same PR swaps
 * the route to `deps.storage.{getFact,updateFact}`.
 *
 * DISCLOSED exception: legacy `pinFact({workspaceId, id, pinned})` takes one
 * options object; v3 `updateFact(id, workspaceId, {pinned})` takes 3
 * positional args (ports.ts:113) — a real calling-convention difference
 * (same class as `health.parity.test.ts`'s `vitals`/`getWorkspaceVitals`
 * precedent), not a behavior change. Both call-shape assertions below are
 * updated to match; every other `expect(...)` line (status codes, response
 * bodies) is unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { loadSchema, validate } from "../_schemaValidate.js";
import { mountGovernance } from "../../routes/governance.js";

const PLAINTEXT_KEY = "mns_live_governanceparitytest001";
const WS_ID = "00000000-0000-0000-0000-000000000901";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "governance-key-001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, ...extra };
}

const NOW = "2026-06-20T00:00:00.000Z"; // determinism-ok: fixed fixture timestamp

function worthFactRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WS_ID,
    subject: "workspace",
    statement: "Some statement",
    worth: 0.7,
    worthAlpha: 8,
    worthBeta: 2,
    hitCount: 5,
    ...overrides,
  };
}

// v3 `MnemoFact` shape (subject/statement/pinned are native fields).
function v3FactRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WS_ID,
    subject: "workspace",
    statement: "Some statement",
    pinned: false,
    validFrom: new Date(NOW),
    validTo: undefined,
    ...overrides,
  };
}

async function buildApp(
  overrides: Partial<{
    queryFacts: ReturnType<typeof vi.fn>;
    getFact: ReturnType<typeof vi.fn>;
    updateFact: ReturnType<typeof vi.fn>;
  }> = {}
) {
  const queryFacts =
    overrides.queryFacts ??
    vi.fn().mockResolvedValue({
      items: [worthFactRow("fact_1")],
      total: 1,
      offset: 0,
      limit: 50,
      hasMore: false,
    });
  const getFact = overrides.getFact ?? vi.fn().mockResolvedValue(v3FactRow("fact_1"));
  // v3 has no dedicated `pinFact` — `updateFact(id, workspaceId, {pinned})`
  // is the direct equivalent (ports.ts:113, UpdateFactInput.pinned).
  const updateFact =
    overrides.updateFact ?? vi.fn().mockResolvedValue(v3FactRow("fact_1", { pinned: true }));
  const deps = {
    // appendAuditEntry backs `emitAudit` (audit-emit.ts) called by
    // POST /governance/gate — unrelated to the deps.core->deps.storage port
    // under test here, just required wiring so the fake doesn't throw.
    storage: {
      queryFacts,
      getFact,
      updateFact,
      appendAuditEntry: vi.fn().mockResolvedValue(undefined),
    },
    apiKeys: await makeKeyLookup(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountGovernance]);
  return { app, queryFacts, getFact, pinFact: updateFact };
}

describe("Tier A parity: GET /governance/worth", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/governance/worth");
    expect(res.status).toBe(401);
  });

  it("returns 200 with items conforming to governance-worth-item.schema.json", async () => {
    const schema = loadSchema("governance-worth-item");
    const { app } = await buildApp();
    const res = await app.request("/governance/worth", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      const err = validate(item, schema);
      expect(err).toBeNull();
    }
  });

  it("forwards workspaceId + status:active to queryFacts", async () => {
    const { app, queryFacts } = await buildApp();
    await app.request("/governance/worth", { headers: authed() });
    expect(queryFacts).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS_ID, status: "active" })
    );
  });
});

describe("Tier A parity: POST /governance/gate", () => {
  it("returns 404 when the fact does not exist", async () => {
    const { app } = await buildApp({ getFact: vi.fn().mockResolvedValue(null) });
    const res = await app.request("/governance/gate", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ factId: "fact_missing", gate: "canonical" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 with pinned:true when gate='canonical'", async () => {
    const { app, pinFact } = await buildApp();
    const res = await app.request("/governance/gate", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ factId: "fact_1", gate: "canonical" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { factId: string; gate: string; pinned: boolean };
    expect(body).toEqual({ factId: "fact_1", gate: "canonical", pinned: true });
    // DISCLOSED exception (see file header) — v3 `updateFact` call shape.
    expect(pinFact).toHaveBeenCalledWith("fact_1", WS_ID, { pinned: true });
  });

  it("returns 200 with pinned:false when gate='release'", async () => {
    const { app, pinFact } = await buildApp({
      updateFact: vi.fn().mockResolvedValue(v3FactRow("fact_1", { pinned: false })),
    });
    const res = await app.request("/governance/gate", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ factId: "fact_1", gate: "release" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pinned: boolean };
    expect(body.pinned).toBe(false);
    // DISCLOSED exception (see file header) — v3 `updateFact` call shape.
    expect(pinFact).toHaveBeenCalledWith("fact_1", WS_ID, { pinned: false });
  });
});
