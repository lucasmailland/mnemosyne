/**
 * POST /strategies refuses a `validFrom` in the future, as POST /remember does
 * (final review M1): the default list reads "current" as an open interval, so
 * a future-dated strategy would be listed as current before it starts. A past
 * instant is stored as given.
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { mountStrategies } from "../routes/strategies.js";
import { buildMountHarness } from "./_mountHarness.js";

const KEY = "mns_live_strategyvalidfrom000001";
const WS = "00000000-0000-0000-0000-000000000909";

async function makeApp() {
  const storage = new InMemoryStorageAdapter();
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  const deps = {
    apiKeys: {
      listActive: async () => [
        { id: "k", keyHash, workspaceId: WS, scopes: ["memory:write"], plan: "free" },
      ],
      touch: async () => {},
    } as unknown as ApiKeyLookup,
    storage,
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountStrategies]);
  const post = (body: unknown) =>
    app.request("/strategies", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { post, storage };
}

describe("POST /strategies — validFrom", () => {
  it("stores a past validFrom", async () => {
    const { post } = await makeApp();
    const res = await post({ trigger: "t", action: "a", validFrom: "2026-01-05T09:00Z" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { validFrom: string }).validFrom).toBe(
      "2026-01-05T09:00:00.000Z"
    );
  });

  it("refuses a validFrom in the future with 400 on the field, and stores nothing", async () => {
    const { post, storage } = await makeApp();
    const res = await post({ trigger: "t", action: "a", validFrom: "2999-01-01T00:00:00Z" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("validFrom cannot be in the future.");
    expect((await storage.queryStrategies({ workspaceId: WS })).items).toHaveLength(0);
  });
});
