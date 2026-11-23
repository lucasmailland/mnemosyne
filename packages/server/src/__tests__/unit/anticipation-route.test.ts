/**
 * Unit tests for GET /anticipation route (Wave G4).
 *
 * Mirrors the pattern from metacognition-route.test.ts:
 *   - Build a minimal OpenAPIHono app with a fake auth middleware
 *   - Mount the anticipation sub-router with fake storage overrides
 *   - Drive via app.request() — no real HTTP socket, no DB
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter } from "@mnemo-ai/types";
import { mountAnticipation } from "../../routes/anticipation.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

function makeApp(storageOverrides: Partial<StorageAdapter>) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
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
  mountAnticipation(app, fakeDeps);
  return { request: app.request.bind(app) };
}

describe("GET /anticipation", () => {
  it("returns 200 with AnticipationFeed shape", async () => {
    const { request } = makeApp({
      getSequentialPatterns: async () => [],
      getPeriodicPatterns: async () => [],
      getConditionalPatterns: async () => [],
      getCoOccurrencePatterns: async () => [],
    });
    const res = await request("/anticipation");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("cue");
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("passes recentlyRecalledId query param through", async () => {
    const { request } = makeApp({
      getSequentialPatterns: async () => [],
      getPeriodicPatterns: async () => [],
      getConditionalPatterns: async () => [],
      getCoOccurrencePatterns: async () => [],
    });
    const res = await request("/anticipation?recentlyRecalledId=fact-123");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cue?.recentlyRecalledId).toBe("fact-123");
  });
});
