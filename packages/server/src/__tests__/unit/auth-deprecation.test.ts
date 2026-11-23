/**
 * §6 API key lifecycle — deprecation grace (deep re-audit P0-2, version A).
 *
 * A key with deprecated_at set stays valid for a 7-day sunset window and returns
 * Deprecation + Sunset headers; past the window it is rejected with 401. Existing
 * keys (deprecated_at NULL) behave exactly as before.
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { makeMockCognitive } from "../helpers/mockCognitive.js";

const KEY = "mns_live_deprecationtest00000001";
const WS = "00000000-0000-0000-0000-000000000011";
const DAY = 24 * 60 * 60 * 1000;

function makeCore() {
  return { recall: async () => [] } as unknown as ServerDeps["core"];
}

async function lookupWith(deprecatedAt: Date | null): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: "k1", keyHash, workspaceId: WS, scopes: ["memory:read"], plan: "free", deprecatedAt },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed() {
  return { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
}

async function appWith(deprecatedAt: Date | null) {
  const deps = {
    core: makeCore(),
    apiKeys: await lookupWith(deprecatedAt),
    embedModel: "text-embedding-3-small",
    cognitive: makeMockCognitive(),
  } as unknown as ServerDeps;
  return createApp({ deps, version: "0.0.0-test" });
}

async function recall(app: Awaited<ReturnType<typeof appWith>>) {
  return app.request("/recall", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ query: "x", topK: 3 }),
  });
}

describe("§6 deprecation grace (P0-2 A)", () => {
  it("a key within the 7-day grace works and emits Deprecation + Sunset headers", async () => {
    // 2 days ago: always within the 7-day grace window
    const res = await recall(await appWith(new Date(Date.now() - 2 * DAY))); // determinism-ok: always within 7-day grace (2 < 7)
    expect(res.status).toBe(200);
    expect(res.headers.get("Deprecation")).toBeTruthy();
    expect(res.headers.get("Sunset")).toBeTruthy();
  });

  it("a key past the 7-day sunset is rejected (401)", async () => {
    // 10 days ago: always past the 7-day sunset window
    const res = await recall(await appWith(new Date(Date.now() - 10 * DAY))); // determinism-ok: always past 7-day sunset (10 > 7)
    expect(res.status).toBe(401);
  });

  it("a non-deprecated key works with no Sunset header (backward-compatible)", async () => {
    const res = await recall(await appWith(null));
    expect(res.status).toBe(200);
    expect(res.headers.get("Sunset")).toBeFalsy();
  });
});
