/**
 * Unit tests for GET /metacognition route (Wave F4).
 *
 * Mirrors the pattern from hyperedges-route.test.ts:
 *   - Build a minimal OpenAPIHono app with a fake auth middleware
 *   - Mount the metacognition sub-router with fake storage overrides
 *   - Drive via app.request() — no real HTTP socket, no DB
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect } from "vitest";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type {
  StorageAdapter,
  ConfidenceMapRow,
  KnowledgeGapRow,
  MetacognitionTrends,
} from "@mnemo-ai/types";
import { mountMetacognition } from "../../routes/metacognition.js";

// ── Test workspace ID (valid UUID) ────────────────────────────────────────────

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

// buildSelfModel (Wave L2) always reads trends for the default 'all' aspect, so
// every fake storage must supply getMetacognitionTrends or the route 500s.
const ZERO_TREND = { current: 0, previous: 0, delta: 0 };
const TRENDS: MetacognitionTrends = {
  recallHitRate: ZERO_TREND,
  avgRecallLatency: ZERO_TREND,
  sessionCollapseQuality: ZERO_TREND,
  strategySuccessRate: ZERO_TREND,
};

// ── Helper: build minimal app with fake storage ───────────────────────────────

function makeMetacognitionApp(storageOverrides: Partial<StorageAdapter>) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  // Fake auth — stamps all required AuthVariables without touching bcrypt/DB
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", [] as ReadonlyArray<string>);
    await next();
  });

  const fakeDeps = {
    storage: storageOverrides as unknown as StorageAdapter,
    core: {} as unknown,
  } as unknown as ServerDeps;

  mountMetacognition(app, fakeDeps);

  return { request: app.request.bind(app) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /metacognition", () => {
  it("returns 200 with SelfModel shape", async () => {
    const { request } = makeMetacognitionApp({
      getConfidenceMap: async (): Promise<ConfidenceMapRow[]> => [],
      getKnowledgeGaps: async (): Promise<KnowledgeGapRow[]> => [],
      getMetacognitionTrends: async (): Promise<MetacognitionTrends> => TRENDS,
    });
    const res = await request("/metacognition");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("strongTopics");
    expect(body).toHaveProperty("gaps");
    expect(body).toHaveProperty("summary");
    expect(body).toHaveProperty("workspaceId", WORKSPACE_ID);
    expect(body.summary.totalTopics).toBe(0);
  });

  it("passes aspect=gaps query param through", async () => {
    const { request } = makeMetacognitionApp({
      getConfidenceMap: async (): Promise<ConfidenceMapRow[]> => [],
      getKnowledgeGaps: async (): Promise<KnowledgeGapRow[]> => [],
      getMetacognitionTrends: async (): Promise<MetacognitionTrends> => TRENDS,
    });
    const res = await request("/metacognition?aspect=gaps");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.strongTopics).toEqual([]);
  });

  it("returns strong topics from confidence data", async () => {
    const { request } = makeMetacognitionApp({
      getConfidenceMap: async (): Promise<ConfidenceMapRow[]> => [
        {
          workspaceId: WORKSPACE_ID,
          // Entity-keyed shape (Wave L2, migration 0020).
          entityId: "00000000-0000-0000-0000-0000000000aa",
          canonicalName: "auth",
          kind: "service",
          factCount: 10,
          avgConfidence: 0.9,
          coverageLevel: "expert",
          freshness: "current",
          // Back-compat aggregate fields.
          topicKey: "auth",
          memoryCount: 10,
          avgWorth: 0.9,
          evidenceVolume: 20,
          distinctAttributions: 2,
          pinnedCount: 1,
          lowStrengthCount: 0,
          lastUpdatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        },
      ],
      getKnowledgeGaps: async (): Promise<KnowledgeGapRow[]> => [],
      getMetacognitionTrends: async (): Promise<MetacognitionTrends> => TRENDS,
    });
    const res = await request("/metacognition?aspect=strengths");
    expect(res.status).toBe(200);
    const body = await res.json();
    // strongTopics is now keyed on the entity's canonicalName (aliased to topicKey).
    expect(body.strongTopics).toHaveLength(1);
    expect(body.strongTopics[0].topicKey).toBe("auth");
  });
});
