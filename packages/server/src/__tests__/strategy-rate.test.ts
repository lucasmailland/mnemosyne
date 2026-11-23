/**
 * Task A7b — POST /strategies/:id/rate
 *
 * Tests confirm:
 *  - 404 on unknown strategy
 *  - success outcome increments successCount and recomputes worth
 *  - failure outcome increments failureCount and recomputes worth
 *  - Beta-Bernoulli formula: alpha=2+sc, beta=2+fc, worth=alpha/(alpha+beta)
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { MnemoStrategy, StorageAdapter, UpdateStrategyInput } from "@mnemo-ai/types";
import { mountStrategies } from "../routes/strategies.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_strategyratetest000001";
const WS_ID = "00000000-0000-0000-0000-000000000022";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "key001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json", ...extra };
}

function makeCoreDeps() {
  return { recall: async () => [] } as unknown as ServerDeps["core"];
}

const NOW = new Date("2026-06-20T00:00:00.000Z");

function fakeStrategy(over: Partial<MnemoStrategy> = {}): MnemoStrategy {
  return {
    id: "strat-1",
    workspaceId: WS_ID,
    trigger: "Error occurs",
    action: "Retry with backoff",
    successCount: 3,
    failureCount: 1,
    worth: 0.625, // (2+3)/((2+3)+(2+1)) = 5/8
    status: "active",
    embeddingStale: false,
    validFrom: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    metadata: {},
    ...over,
  };
}

describe("POST /strategies/:id/rate", () => {
  it("returns 404 when the strategy is not found", async () => {
    const storage = {
      getStrategy: async () => null,
    } as unknown as StorageAdapter;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      storage,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountStrategies]);

    const res = await app.request("/strategies/missing/rate", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ outcome: "success" }),
    });
    expect(res.status).toBe(404);
  });

  it("success outcome increments successCount and recomputes worth", async () => {
    // Initial: successCount=3, failureCount=1
    // After success: sc=4, fc=1 → alpha=6, beta=3, worth=6/9=0.6667
    let capturedPatch: UpdateStrategyInput | undefined;
    const initial = fakeStrategy();
    const updated = fakeStrategy({ successCount: 4, worth: 6 / 9 });

    const storage = {
      getStrategy: async () => initial,
      updateStrategy: async (_id: string, patch: UpdateStrategyInput) => {
        capturedPatch = patch;
        return updated;
      },
    } as unknown as StorageAdapter;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      storage,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountStrategies]);

    const res = await app.request("/strategies/strat-1/rate", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ outcome: "success" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      successCount: number;
      failureCount: number;
      worth: number;
    };
    expect(body.successCount).toBe(4);
    expect(body.failureCount).toBe(1);
    expect(capturedPatch?.successCount).toBe(4);
    expect(capturedPatch?.failureCount).toBe(1);
    // worth = alpha/(alpha+beta) = 6/9 ≈ 0.6667
    expect(capturedPatch?.worth).toBeCloseTo(6 / 9, 5);
  });

  it("failure outcome increments failureCount and recomputes worth", async () => {
    // Initial: successCount=3, failureCount=1
    // After failure: sc=3, fc=2 → alpha=5, beta=4, worth=5/9≈0.5556
    let capturedPatch: UpdateStrategyInput | undefined;
    const initial = fakeStrategy();
    const updated = fakeStrategy({ failureCount: 2, worth: 5 / 9 });

    const storage = {
      getStrategy: async () => initial,
      updateStrategy: async (_id: string, patch: UpdateStrategyInput) => {
        capturedPatch = patch;
        return updated;
      },
    } as unknown as StorageAdapter;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      storage,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountStrategies]);

    const res = await app.request("/strategies/strat-1/rate", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ outcome: "failure" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      successCount: number;
      failureCount: number;
      worth: number;
    };
    expect(body.failureCount).toBe(2);
    expect(capturedPatch?.failureCount).toBe(2);
    expect(capturedPatch?.successCount).toBe(3);
    // worth = alpha/(alpha+beta) = 5/9 ≈ 0.5556
    expect(capturedPatch?.worth).toBeCloseTo(5 / 9, 5);
  });

  it("Beta-Bernoulli formula: fresh strategy (sc=0, fc=0) → worth=0.5", async () => {
    // alpha=2+0=2, beta=2+0=2, worth=2/4=0.5
    let capturedPatch: UpdateStrategyInput | undefined;
    const initial = fakeStrategy({ successCount: 0, failureCount: 0, worth: 0.5 });
    const updated = fakeStrategy({ successCount: 1, failureCount: 0, worth: 3 / 5 });

    const storage = {
      getStrategy: async () => initial,
      updateStrategy: async (_id: string, patch: UpdateStrategyInput) => {
        capturedPatch = patch;
        return updated;
      },
    } as unknown as StorageAdapter;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      storage,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountStrategies]);

    const res = await app.request("/strategies/strat-1/rate", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ outcome: "success" }),
    });
    expect(res.status).toBe(200);
    // After first success: sc=1, fc=0 → alpha=3, beta=2, worth=3/5=0.6
    expect(capturedPatch?.successCount).toBe(1);
    expect(capturedPatch?.failureCount).toBe(0);
    expect(capturedPatch?.worth).toBeCloseTo(3 / 5, 5);
  });
});
