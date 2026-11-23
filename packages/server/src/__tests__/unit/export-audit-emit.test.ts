/**
 * Unit tests for p50-audit-log-emitters PR5 — export.ts audit emission.
 *
 * Covers task 5.1-5.4: `export` is emitted from all 3 call sites
 * (GET /export, POST /export, GET /export/jsonl) after the approval gate
 * passes (never on the 202 pending branch), with a namespaced actorId and a
 * secret-free `detail` blob (metadata only — format/rowCapPerResource/
 * approvalRequestId/userId — never raw export content or key material).
 *
 * Pattern: mirrors keys-audit-emit.test.ts (spy on deps.storage.appendAuditEntry)
 * combined with export-approval.test.ts / export-coverage.test.ts's app-building
 * fixtures for the approval gate and the full jsonl storage stub set.
 */
import { describe, it, expect, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { OpenAPIHono } from "@hono/zod-openapi";
import { InMemoryApprovalStore } from "@mnemo-ai/types/testing";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { AuditLogEntry } from "@mnemo-ai/types";
import { mountExport } from "../../routes/export.js";

const WS = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const RAW_ACTOR_ID = "agent-p50-export";
const USER_ID = "user-p50-export";

// flatten-legacy-dual-core PR9h port: GET/POST /export (and the jsonl
// handler's relations+citations lines) now compose from these 4 typed
// `deps.storage` calls instead of the legacy `deps.core.exportWorkspace` —
// always present regardless of `withJsonlStorage` since GET/POST /export
// need them even when the jsonl-only 11-type stub set is not requested.
// `queryFactsPage`'s one fake fact carries the same "super secret fact
// content" statement the legacy fixture used, so the secret-content
// audit-detail assertions below still exercise a real leak surface.
function exportStorageStubs() {
  return {
    queryFactsPage: vi.fn().mockResolvedValue({
      items: [{ id: "f1", statement: "super secret fact content" }],
      nextCursor: null,
      total: 1,
    }),
    queryDecisions: vi
      .fn()
      .mockResolvedValue({ items: [], total: 0, offset: 0, limit: 100_000, hasMore: false }),
    getRelations: vi.fn().mockResolvedValue([]),
    listCitations: vi.fn().mockResolvedValue([]),
  };
}

function jsonlStorageStubs() {
  return {
    queryFacts: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    queryDecisions: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    queryEpisodes: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    queryEntities: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    queryStrategies: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    queryWorkflows: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    querySkills: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    queryTasks: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    queryEvents: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    queryReasoning: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    queryHyperedges: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listWebhookEndpoints: vi.fn().mockResolvedValue([]),
    listReminders: vi.fn().mockResolvedValue([]),
  };
}

function buildApp(opts: {
  approvals?: InMemoryApprovalStore;
  userId?: string | null;
  withJsonlStorage?: boolean;
}) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("scopes", ["memory:export"]);
    c.set("actorId", RAW_ACTOR_ID);
    c.set("actorType", "agent");
    c.set("userId", opts.userId === undefined ? USER_ID : opts.userId);
    c.set("apiKeyPrefix", "mns_live_");
    await next();
  });

  const appendAuditEntry = vi.fn().mockResolvedValue(undefined);
  const storage = opts.withJsonlStorage
    ? { ...jsonlStorageStubs(), ...exportStorageStubs(), appendAuditEntry }
    : { ...exportStorageStubs(), appendAuditEntry };

  const deps = {
    storage: storage as unknown as ServerDeps["storage"],
    ...(opts.approvals ? { approvals: opts.approvals } : {}),
  } as ServerDeps;

  mountExport(app, deps);
  return { app, appendAuditEntry };
}

function firstEntry(spy: ReturnType<typeof vi.fn>): Omit<AuditLogEntry, "id" | "createdAt"> {
  expect(spy).toHaveBeenCalledTimes(1);
  return spy.mock.calls[0]![0] as Omit<AuditLogEntry, "id" | "createdAt">;
}

describe("GET /export — export audit emission", () => {
  it("emits an export entry with format:json, a namespaced actorId, and no secret material", async () => {
    const { app, appendAuditEntry } = buildApp({});
    const res = await app.request("/export");
    expect(res.status).toBe(200);

    const entry = firstEntry(appendAuditEntry);
    expect(entry.action).toBe("export");
    expect(entry.resourceKind).toBe("workspace");
    expect(entry.resourceId).toBe(WS);
    expect(entry.isTerminal).toBe(false);
    expect(entry.workspaceId).toBe(WS);
    expect(entry.actorType).toBe("agent");
    expect(entry.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(entry.detail).toMatchObject({
      userId: USER_ID,
      format: "json",
      rowCapPerResource: 100_000,
    });
  });

  it("does not emit when the approval gate returns a 202 pending response", async () => {
    const approvals = new InMemoryApprovalStore();
    const { app, appendAuditEntry } = buildApp({ approvals });
    const res = await app.request("/export");
    expect(res.status).toBe(202);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("includes approvalRequestId in detail when the approval gate passed with one", async () => {
    const approvals = new InMemoryApprovalStore();
    const created = await approvals.create({
      workspaceId: WS,
      requestedBy: USER_ID,
      trigger: "bulk_export",
      resource: "workspace",
      resourceId: WS,
      // The request it was raised on: an approval is spent only there (S1).
      payload: { method: "GET", path: "/export" },
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // determinism-ok: filler expiresAt on an approval-request fixture, never asserted
    });
    await approvals.resolve(WS, created.id, "approved", "operator-1");

    const { app, appendAuditEntry } = buildApp({ approvals });
    const res = await app.request(`/export?approvalRequestId=${created.id}`);
    expect(res.status).toBe(200);

    const entry = firstEntry(appendAuditEntry);
    expect(entry.detail).toMatchObject({ approvalRequestId: created.id });
  });
});

describe("POST /export — export audit emission", () => {
  it("emits an export entry with format:json", async () => {
    const { app, appendAuditEntry } = buildApp({});
    const res = await app.request("/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    const entry = firstEntry(appendAuditEntry);
    expect(entry.action).toBe("export");
    expect(entry.resourceKind).toBe("workspace");
    expect(entry.resourceId).toBe(WS);
    expect(entry.isTerminal).toBe(false);
    expect(entry.detail).toMatchObject({ userId: USER_ID, format: "json" });
  });

  it("does not emit when the approval gate returns a 202 pending response", async () => {
    const approvals = new InMemoryApprovalStore();
    const { app, appendAuditEntry } = buildApp({ approvals });
    const res = await app.request("/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});

describe("GET /export/jsonl — export audit emission", () => {
  it("emits an export entry with format:jsonl after the gzip payload is produced", async () => {
    const { app, appendAuditEntry } = buildApp({ withJsonlStorage: true });
    const res = await app.request("/export/jsonl");
    expect(res.status).toBe(200);

    const entry = firstEntry(appendAuditEntry);
    expect(entry.action).toBe("export");
    expect(entry.resourceKind).toBe("workspace");
    expect(entry.resourceId).toBe(WS);
    expect(entry.isTerminal).toBe(false);
    expect(entry.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(entry.detail).toMatchObject({ userId: USER_ID, format: "jsonl" });
  });

  it("does not emit when the approval gate returns a 202 pending response", async () => {
    const approvals = new InMemoryApprovalStore();
    const { app, appendAuditEntry } = buildApp({ approvals, withJsonlStorage: true });
    const res = await app.request("/export/jsonl");
    expect(res.status).toBe(202);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});

describe("export audit detail — secret-free snapshot (all 3 sites)", () => {
  const ALLOWED_DETAIL_KEYS = new Set([
    "userId",
    "format",
    "approvalRequestId",
    "rowCapPerResource",
  ]);

  it("GET /export detail contains only the allowlisted metadata keys", async () => {
    const { app, appendAuditEntry } = buildApp({});
    await app.request("/export");
    const entry = firstEntry(appendAuditEntry);
    const keys = Object.keys(entry.detail ?? {});
    for (const key of keys) {
      expect(ALLOWED_DETAIL_KEYS.has(key)).toBe(true);
    }
    const serialized = JSON.stringify(entry.detail);
    expect(serialized).not.toContain("super secret fact content");
    expect(serialized).not.toContain("mns_live_");
    expect(serialized).not.toMatch(/plainKey|keyHash|lookupHash/);
  });

  it("GET /export/jsonl detail contains only the allowlisted metadata keys", async () => {
    const { app, appendAuditEntry } = buildApp({ withJsonlStorage: true });
    await app.request("/export/jsonl");
    const entry = firstEntry(appendAuditEntry);
    const keys = Object.keys(entry.detail ?? {});
    for (const key of keys) {
      expect(ALLOWED_DETAIL_KEYS.has(key)).toBe(true);
    }
    const serialized = JSON.stringify(entry.detail);
    expect(serialized).not.toContain("super secret fact content");
    expect(serialized).not.toContain("mns_live_");
  });
});

describe("POST /export — body (R-19)", () => {
  const post = (app: ReturnType<typeof buildApp>["app"], body: unknown) =>
    app.request("/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("rejects a types filter with 400 instead of ignoring it, and exports nothing", async () => {
    const { app, appendAuditEntry } = buildApp({});
    const res = await post(app, { types: ["fact"] });
    expect(res.status).toBe(400);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("still accepts the other body fields", async () => {
    const { app } = buildApp({});
    const res = await post(app, { format: "json", includeEmbeddings: false });
    expect(res.status).toBe(200);
  });
});
