/**
 * AB2 — Region-lock middleware tests.
 * spec §35 "Multi-Region & Data Residency" lines 4049–4083.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import bcrypt from "bcrypt";
import { regionLockMiddleware } from "../middleware/region.js";
import { toErrorBody } from "../errors.js";
import { createApp } from "../app.js";
import type { ServerDeps } from "../deps.js";
import { makeMockCognitive } from "./helpers/mockCognitive.js";

function buildApp(workspaceRegion: string | undefined, envRegion: string | undefined) {
  const app = new Hono<{ Variables: { workspaceId: string; workspaceRegion?: string } }>();

  // Error handler matching app.ts pattern
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as any);
  });

  // Simulate auth middleware setting workspaceId + workspaceRegion
  app.use("*", async (c, next) => {
    c.set("workspaceId", "ws-test-123");
    if (workspaceRegion !== undefined) {
      (c as any).set("workspaceRegion", workspaceRegion);
    }
    await next();
  });

  // The region-lock middleware under test
  app.use("*", regionLockMiddleware({ getEnvRegion: () => envRegion }));

  app.get("/facts", (c) => c.json({ items: [] }));

  return app;
}

describe("regionLockMiddleware — spec §35 lines 4049–4083", () => {
  it("returns 403 wrong_region when workspace region mismatches MNEMO_REGION", async () => {
    const app = buildApp("eu-west-1", "us-east-1");
    const res = await app.request("/facts");
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("wrong_region");
    expect(body.error.details?.homeRegion).toBe("eu-west-1");
  });

  it("allows request when workspace region matches MNEMO_REGION", async () => {
    const app = buildApp("us-east-1", "us-east-1");
    const res = await app.request("/facts");
    expect(res.status).toBe(200);
  });

  it("allows request when MNEMO_REGION is not set (single-region mode)", async () => {
    const app = buildApp("eu-west-1", undefined);
    const res = await app.request("/facts");
    expect(res.status).toBe(200);
  });

  it("allows request when workspace region is not set (null/undefined)", async () => {
    const app = buildApp(undefined, "us-east-1");
    const res = await app.request("/facts");
    expect(res.status).toBe(200);
  });
});

// ── Mounted in createApp: auth → region lock, the region read from Postgres ──
describe("region lock mounted on the v1 surface (app.ts)", () => {
  const WS = "11111111-2222-4333-8444-555555555555";
  const KEY = "mns_live_regionlockmounttest0000001";
  const origRegion = process.env.MNEMO_REGION;
  afterEach(() => {
    if (origRegion === undefined) delete process.env.MNEMO_REGION;
    else process.env.MNEMO_REGION = origRegion;
  });

  async function makeApp(workspaceRegion: string | null) {
    const keyHash = await bcrypt.hash(KEY, 4);
    const regionQueries: unknown[] = [];
    // Tagged-template stand-in for postgres.Sql: answers the region lookup only.
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("?").includes("mnemo_workspace_region")) {
        regionQueries.push(values[0]);
        return Promise.resolve([{ region: workspaceRegion }]);
      }
      return Promise.reject(new Error("unexpected query"));
    };
    const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
    const deps = {
      apiKeys: {
        async listActive() {
          return [
            { id: "key_region", keyHash, workspaceId: WS, scopes: ["memory:read"], plan: "free" },
          ];
        },
        async touch() {},
      },
      embedModel: "text-embedding-3-small",
      cognitive: makeMockCognitive(),
      telemetry: {
        startSpan: () => noopSpan,
        counter: () => {},
        histogram: () => {},
        gauge: () => {},
        shutdown: async () => {},
      },
      metricsPgClient: sql,
    } as unknown as ServerDeps;
    return { app: createApp({ deps, version: "test" }), regionQueries };
  }
  const me = { headers: { authorization: `Bearer ${KEY}` } };

  it("answers 403 wrong_region when the workspace region differs from MNEMO_REGION", async () => {
    process.env.MNEMO_REGION = "us-east-1";
    const { app } = await makeApp("eu-west-1");
    const res = await app.request("/me", me);
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("wrong_region");
    expect(body.error.details).toMatchObject({
      homeRegion: "eu-west-1",
      instanceRegion: "us-east-1",
    });
  });

  it("lets the request through when the regions match, reading the region once per workspace", async () => {
    process.env.MNEMO_REGION = "eu-west-1";
    const { app, regionQueries } = await makeApp("eu-west-1");
    expect((await app.request("/me", me)).status).toBe(200);
    expect((await app.request("/me", me)).status).toBe(200);
    expect(regionQueries).toEqual([WS]);
  });

  it("lets the request through without MNEMO_REGION", async () => {
    delete process.env.MNEMO_REGION;
    const { app } = await makeApp("eu-west-1");
    expect((await app.request("/me", me)).status).toBe(200);
  });

  it("lets a workspace without a region through", async () => {
    process.env.MNEMO_REGION = "us-east-1";
    const { app } = await makeApp(null);
    expect((await app.request("/me", me)).status).toBe(200);
  });

  it("leaves the unauthenticated probes alone", async () => {
    process.env.MNEMO_REGION = "us-east-1";
    const { app, regionQueries } = await makeApp("eu-west-1");
    expect((await app.request("/healthz")).status).toBe(200);
    expect(regionQueries).toEqual([]);
  });
});
