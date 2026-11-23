/**
 * `debug.lexicalCandidateCount` counts lexical candidates before the
 * sensitivity ceiling runs (recall-cold), so it is emitted only to a caller
 * whose ceiling admits every tier — the same rule `debug.trace` follows
 * (traceCounts in recall-cold). Triage H10.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { RecallQuery, RecallResponse } from "@mnemo-ai/types";
import { mountRecall } from "../routes/recall.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_recalldebugceiling00001";
const WS_ID = "00000000-0000-0000-0000-000000000019";

async function recallDebug(scopes: string[]): Promise<Record<string, unknown>> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [{ id: "key001", keyHash, workspaceId: WS_ID, scopes, plan: "free" }],
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const cognitive = {
    recall: async (q: RecallQuery): Promise<RecallResponse> => ({
      hits: [],
      total: 0,
      query: { text: q.text, limit: q.limit ?? 10, offset: q.offset ?? 0 },
      latencyMs: 1,
      fromHotTier: false,
      searchMode: "hybrid",
      debug: {
        modeRequested: "hybrid",
        modeUsed: "hybrid",
        tiersConsulted: ["cold"],
        cacheHit: false,
        fallback: false,
        fusionApplied: true,
        lexicalCandidateCount: 3,
      },
    }),
  } as unknown as NonNullable<ServerDeps["cognitive"]>;
  const app = buildMountHarness(
    { apiKeys, embedModel: "text-embedding-3-small", cognitive } as unknown as ServerDeps,
    [mountRecall]
  );
  const res = await app.request("/recall", {
    method: "POST",
    headers: { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "coffee" }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { debug: Record<string, unknown> }).debug;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /recall — debug.lexicalCandidateCount and the sensitivity ceiling", () => {
  it("is absent for a read key", async () => {
    const debug = await recallDebug(["memory:read"]);
    expect("lexicalCandidateCount" in debug).toBe(false);
    expect(debug.fusionApplied).toBe(true);
  });

  it("is absent for an admin key under the default env ceiling", async () => {
    const debug = await recallDebug(["memory:read", "memory:admin"]);
    expect("lexicalCandidateCount" in debug).toBe(false);
  });

  it("is present for an admin key whose ceiling is restricted", async () => {
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted");
    const debug = await recallDebug(["memory:read", "memory:admin"]);
    expect(debug.lexicalCandidateCount).toBe(3);
  });

  it("is absent for a read key even when the env ceiling is restricted", async () => {
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted");
    const debug = await recallDebug(["memory:read"]);
    expect("lexicalCandidateCount" in debug).toBe(false);
  });
});
