/**
 * CHAOS-10 (WP-2 request to WP-3, applied at integration): the user/tenant
 * multi-level recall branch of POST /recall went straight to storage while
 * the workspace-only branch went through `circuitBreakers.storageRead`. With
 * the database down, a user-bound key's recall waited out every timeout
 * instead of failing fast once the breaker opened.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { createApp } from "../app.js";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";

const PLAINTEXT_KEY = "mns_live_multilevelbreaker00000001";
const WS_ID = "00000000-0000-0000-0000-dd0000000001";
const PERSONAL_WS_ID = "00000000-0000-0000-0000-dd0000000002";
const USER_ID = "user-multilevel-breaker-001";

function fakeSql() {
  const tx = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("mnemo_user")) return Promise.resolve([{ personal_tenant_id: "t-p" }]);
    if (text.includes("mnemo_workspace")) return Promise.resolve([{ id: PERSONAL_WS_ID }]);
    return Promise.resolve([]);
  };
  return {
    begin: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as ServerDeps["metricsPgClient"];
}

async function keyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      {
        id: "key-multilevel-breaker",
        keyHash,
        workspaceId: WS_ID,
        scopes: ["memory:read"],
        userId: USER_ID,
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function breakers(open: boolean) {
  const storageRead = vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => {
    if (open) throw Object.assign(new Error("Breaker is open"), { code: "EOPENBREAKER" });
    return fn();
  });
  const pass = async <T>(fn: () => Promise<T>): Promise<T> => fn();
  return { storageRead, storageWrite: pass, llmGenerate: pass, llmEmbed: pass };
}

async function appWith(open: boolean) {
  const recall = vi.fn(async () => ({
    hits: [],
    total: 0,
    query: { text: "q", limit: 5, offset: 0 },
    latencyMs: 1,
    fromHotTier: false,
  }));
  const circuitBreakers = breakers(open);
  const deps = {
    apiKeys: await keyLookup(),
    cognitive: { recall },
    metricsPgClient: fakeSql(),
    circuitBreakers,
  } as unknown as ServerDeps;
  return { app: createApp({ deps, version: "0.0.0-test" }), recall, circuitBreakers };
}

const headers = { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json" };

describe("POST /recall — the multi-level branches go through the storage breaker", () => {
  it.each([
    ["blended user/tenant recall", {}],
    ["scope: personal", { scope: "personal" }],
  ])("%s fails fast with 503 when the breaker is open", async (_label, extra) => {
    const { app, recall, circuitBreakers } = await appWith(true);
    const res = await app.request("/recall", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "auth module", topK: 5, ...extra }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(circuitBreakers.storageRead).toHaveBeenCalledTimes(1);
    expect(recall).not.toHaveBeenCalled();
  });

  it("a closed breaker runs the multi-level recall inside it", async () => {
    const { app, recall, circuitBreakers } = await appWith(false);
    const res = await app.request("/recall", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "auth module", topK: 5 }),
    });
    expect(res.status).toBe(200);
    expect(circuitBreakers.storageRead).toHaveBeenCalledTimes(1);
    expect(recall).toHaveBeenCalled();
  });
});
