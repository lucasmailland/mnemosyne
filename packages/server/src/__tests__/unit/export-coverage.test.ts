/**
 * C1 — JSONL export covers all 4 missing spec core types:
 *   decision, entity, strategy, workflow
 *
 * Mounts the export route with a mock storage whose queryDecisions/queryEntities/
 * queryStrategies/queryWorkflows are vi.fn() stubs. Performs GET /export/jsonl and
 * asserts:
 *   1. Each of the 4 query methods was called.
 *   2. The decompressed JSONL output contains at least one line per missing type.
 */

import { describe, it, expect, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountExport } from "../../routes/export.js";

const WS = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function buildApp() {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("scopes", ["memory:export"]);
    c.set("actorId", "agent-test");
    c.set("apiKeyPrefix", "mns_live_");
    await next();
  });

  const mockStorage = {
    // Already-present types (minimal stubs so the route doesn't crash)
    queryFacts: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    // flatten-legacy-dual-core PR9h port: relations + citations lines now
    // come from `exportRelations`/`exportCitations` (`@mnemo-ai/core/
    // cognitive`) instead of the legacy `deps.core.exportWorkspace`.
    getRelations: vi.fn().mockResolvedValue([]),
    listCitations: vi.fn().mockResolvedValue([]),
    queryEpisodes: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    querySkills: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    queryTasks: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    queryEvents: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    queryReasoning: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    queryHyperedges: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listWebhookEndpoints: vi.fn().mockResolvedValue([]),
    listReminders: vi.fn().mockResolvedValue([]),
    // The 4 missing spec-core types under test:
    queryDecisions: vi.fn().mockResolvedValue({
      items: [{ id: "d1", title: "Go with Postgres", workspaceId: WS }],
      nextCursor: null,
    }),
    queryEntities: vi.fn().mockResolvedValue({
      items: [{ id: "en1", name: "Alice", kind: "person", workspaceId: WS }],
      nextCursor: null,
    }),
    queryStrategies: vi.fn().mockResolvedValue({
      items: [{ id: "st1", title: "Expand north", workspaceId: WS }],
      nextCursor: null,
    }),
    queryWorkflows: vi.fn().mockResolvedValue({
      items: [{ id: "wf1", name: "Onboard user", workspaceId: WS }],
      nextCursor: null,
    }),
    // p50-audit-log-emitters PR5: the jsonl handler now emits an `export`
    // audit entry after the payload is produced — appendAuditEntry must be
    // stubbed or emitAudit's `deps.storage.appendAuditEntry(entry)` call
    // throws synchronously (missing method), not a rejection it can swallow.
    appendAuditEntry: vi.fn().mockResolvedValue(undefined),
  };

  const deps: ServerDeps = {
    storage: mockStorage as unknown as ServerDeps["storage"],
  } as unknown as ServerDeps;

  mountExport(app, deps);
  return { app, mockStorage };
}

describe("C1 — GET /export/jsonl covers all 4 missing spec-core types", () => {
  it("calls queryDecisions, queryEntities, queryStrategies, queryWorkflows", async () => {
    const { app, mockStorage } = buildApp();
    const res = await app.request("/export/jsonl");
    expect(res.status).toBe(200);

    expect(mockStorage.queryDecisions).toHaveBeenCalledOnce();
    expect(mockStorage.queryEntities).toHaveBeenCalledOnce();
    expect(mockStorage.queryStrategies).toHaveBeenCalledOnce();
    expect(mockStorage.queryWorkflows).toHaveBeenCalledOnce();
  });

  it("emits _type:decision, _type:entity, _type:strategy, _type:workflow lines in JSONL output", async () => {
    const { app } = buildApp();
    const res = await app.request("/export/jsonl");
    expect(res.status).toBe(200);

    const compressed = Buffer.from(await res.arrayBuffer());
    const plain = gunzipSync(compressed).toString("utf8");
    const lines = plain.split("\n").filter((l) => l.trim().length > 0);
    const types = new Set(
      lines.map((l) => {
        try {
          return (JSON.parse(l) as Record<string, unknown>)["_type"] as string;
        } catch {
          return "";
        }
      })
    );

    expect(types).toContain("decision");
    expect(types).toContain("entity");
    expect(types).toContain("strategy");
    expect(types).toContain("workflow");
  });
});
