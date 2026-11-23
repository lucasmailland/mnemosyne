/**
 * Tier A parity — GET /me's `personalFactsLive` field (design.md D3).
 *
 * HTTP characterization contract for the ONE `deps.core` call site in
 * `packages/server/src/routes/keys.ts` (`GET /me`'s `deps.core.vitals`, used
 * only when a personal workspace resolves for the caller's `userId`).
 * `keys.ts`'s other routes (create/list/revoke/show/rotate key, and the rest
 * of `GET /me`) never used `deps.core` and are already covered by
 * `unit/me-route.test.ts` / `unit/keys-*-route.test.ts` — not duplicated
 * here.
 *
 * Written and merged green against the legacy `deps.core.vitals` (`CoreLike`)
 * implementation FIRST (flatten-legacy-dual-core PR12); the port commit in
 * this same PR then swapped the branch to `deps.storage.getWorkspaceVitals`
 * (v3 `StorageAdapter`) with ZERO changes to any `expect(...)` line below
 * EXCEPT the one explicitly marked "DISCLOSED exception" (same
 * `vitals({workspaceId})` bag vs. `getWorkspaceVitals(workspaceId)`
 * positional call-shape difference `health.parity.test.ts`/
 * `admin.parity.test.ts` already documented for this method).
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { mountKeys } from "../../routes/keys.js";

vi.mock("../../recall/multi-level.js", async (importActual) => {
  const actual = await importActual<typeof import("../../recall/multi-level.js")>();
  return { ...actual, getUserPersonalWorkspaceId: vi.fn() };
});
import { getUserPersonalWorkspaceId } from "../../recall/multi-level.js";

const PLAINTEXT_KEY = "mns_live_keysparitytest0000001";
const WS_ID = "00000000-0000-0000-0000-000000000b01";
const KEY_ID = "keys-parity-key-001";
const USER_ID = "00000000-0000-0000-0000-0000000fu001";
const PERSONAL_WS_ID = "00000000-0000-0000-0000-0000000fp001";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: KEY_ID, keyHash, workspaceId: WS_ID, scopes: [], userId: USER_ID },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}` };
}

/** `withKeysTx` sequence: SET LOCAL ROLE -> SET LOCAL search_path -> 2x set_config -> the real SELECT. */
function fakeMetricsPgClient(): ServerDeps["metricsPgClient"] {
  const fakeSql = vi.fn() as unknown as Record<string, unknown>;
  fakeSql.array = (v: unknown) => v;
  fakeSql.begin = async (fn: (tx: unknown) => Promise<unknown>) => {
    let callCount = 0;
    const fakeTx = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 4) return Promise.resolve([]);
      return Promise.resolve([
        {
          id: KEY_ID,
          expires_at: null,
          ip_allowlist: [],
          workspace_name: "Acme Corp",
          user_id: USER_ID,
        },
      ]);
    });
    (fakeTx as unknown as Record<string, unknown>).array = (v: unknown) => v;
    return fn(fakeTx);
  };
  return fakeSql as unknown as ServerDeps["metricsPgClient"];
}

async function buildApp(vitals = vi.fn().mockResolvedValue({ factsLive: 7 })) {
  vi.mocked(getUserPersonalWorkspaceId).mockResolvedValue(PERSONAL_WS_ID);
  const deps = {
    metricsPgClient: fakeMetricsPgClient(),
    storage: { getWorkspaceVitals: vitals },
    apiKeys: await makeKeyLookup(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountKeys]);
  return { app, vitals };
}

describe("Tier A parity: GET /me — personalFactsLive", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/me");
    expect(res.status).toBe(401);
  });

  it("returns personalFactsLive from vitals when a personal workspace resolves", async () => {
    const { app } = await buildApp();
    const res = await app.request("/me", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.personalWorkspaceId).toBe(PERSONAL_WS_ID);
    expect(body.personalFactsLive).toBe(7);
  });

  it("returns personalFactsLive: null when the vitals call fails (best-effort degrade)", async () => {
    const { app } = await buildApp(vi.fn().mockRejectedValue(new Error("boom")));
    const res = await app.request("/me", { headers: authed() });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.personalFactsLive).toBeNull();
  });

  it("returns personalFactsLive: null when no personal workspace resolves (vitals never called)", async () => {
    const { app, vitals } = await buildApp();
    vi.mocked(getUserPersonalWorkspaceId).mockResolvedValue(null);
    const res = await app.request("/me", { headers: authed() });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.personalWorkspaceId).toBeNull();
    expect(body.personalFactsLive).toBeNull();
    expect(vitals).not.toHaveBeenCalled();
  });

  it("forwards the resolved personal workspaceId to the vitals call", async () => {
    // DISCLOSED exception (see file header): pre-port `vitals({workspaceId})`
    // takes an options bag; post-port `getWorkspaceVitals(workspaceId)` takes
    // a positional string. Every other expect() in this file is unchanged.
    const { app, vitals } = await buildApp();
    await app.request("/me", { headers: authed() });
    expect(vitals).toHaveBeenCalledWith(PERSONAL_WS_ID);
  });
});
