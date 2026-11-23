/**
 * Unit tests for the export approval gate (Wave X2.4).
 *
 * Tests verify:
 *   - Requests without memory:export scope → 403
 *   - No approvalRequestId + ApprovalStore wired → 202 with approval id
 *   - Invalid approvalRequestId (not found) → 403
 *   - Approved approval → 200 with export payload
 *   - Denied approval → 403
 *   - Expired approval → 403
 *   - Workspace mismatch → 403
 *   - No ApprovalStore (legacy) → 200 immediately (backward compat)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { InMemoryApprovalStore } from "@mnemo-ai/types/testing";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountExport } from "../../routes/export.js";
import { toErrorBody } from "../../errors.js";

const WS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ACTOR = "agent-abc";

// flatten-legacy-dual-core PR9h port: the legacy `deps.core.exportWorkspace`
// mock is replaced by a minimal `deps.storage` mock — the 4 typed calls
// `exportWorkspace` (`@mnemo-ai/core/cognitive`) composes from, plus
// `appendAuditEntry` (unlike the removed `core` field, a truthy `deps.storage`
// makes `emitAudit` actually call it — see audit-emit.ts's `if (!deps.storage)
// return;` short-circuit, which no longer applies once `storage` is wired).
function fakeStorage() {
  const emptyPage = { items: [], nextCursor: null, total: 0 };
  return {
    queryFactsPage: vi.fn().mockResolvedValue(emptyPage),
    queryDecisions: vi
      .fn()
      .mockResolvedValue({ items: [], total: 0, offset: 0, limit: 100_000, hasMore: false }),
    getRelations: vi.fn().mockResolvedValue([]),
    listCitations: vi.fn().mockResolvedValue([]),
    appendAuditEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as ServerDeps["storage"];
}

function buildApp(
  scopes: string[],
  approvals?: InMemoryApprovalStore,
  workspaceId = WS,
  userId: string | null = ACTOR
) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", workspaceId);
    c.set("scopes", scopes);
    c.set("actorId", ACTOR);
    c.set("userId", userId);
    c.set("apiKeyPrefix", "mns_live_");
    await next();
  });

  const storage = fakeStorage();
  const deps = {
    storage,
    ...(approvals ? { approvals } : {}),
  } as ServerDeps;

  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 501 | 503);
  });

  mountExport(app, deps);
  return { app, storage };
}

describe("GET /export — scope gate", () => {
  it("rejects missing memory:export scope with 403", async () => {
    const { app } = buildApp(["memory:read"]);
    const res = await app.request("/export");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("INSUFFICIENT_SCOPE");
  });
});

describe("GET /export — no ApprovalStore (backward compat)", () => {
  it("returns 200 immediately when no approvals dep is wired", async () => {
    const { app } = buildApp(["memory:export"]);
    const res = await app.request("/export");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.workspaceId).toBe(WS);
    expect(body.meta.embeddingsExcluded).toBe(true);
    expect(Array.isArray(body.facts)).toBe(true);
  });
});

describe("GET /export — approval gate with ApprovalStore", () => {
  let approvals: InMemoryApprovalStore;

  beforeEach(() => {
    approvals = new InMemoryApprovalStore();
    vi.clearAllMocks();
  });

  it("creates approval request and returns 202 when no approvalRequestId", async () => {
    const { app } = buildApp(["memory:export"], approvals);
    const res = await app.request("/export");
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(typeof body.approvalRequestId).toBe("string");
    expect(body.approvalRequestId.length).toBeGreaterThan(0);
    expect(typeof body.expiresAt).toBe("string");
    expect(body.message).toMatch(/approvalRequestId/);
  });

  it("returns 403 when approvalRequestId is not found", async () => {
    const { app } = buildApp(["memory:export"], approvals);
    const res = await app.request("/export?approvalRequestId=nonexistent-id");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("approval_not_found");
  });

  it("returns 403 when approval status is pending (not yet approved)", async () => {
    const { app } = buildApp(["memory:export"], approvals);
    // Create a pending approval
    const pending = await approvals.create({
      workspaceId: WS,
      requestedBy: ACTOR,
      trigger: "bulk_export",
      resource: "workspace",
      resourceId: WS,
      payload: {},
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days future: always valid // determinism-ok: self-consistent, not expired relative to itself
    });
    const res = await app.request(`/export?approvalRequestId=${pending.id}`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("approval_not_approved");
    expect(body.error.details?.status).toBe("pending");
  });

  it("returns 403 when approval is denied", async () => {
    const { app } = buildApp(["memory:export"], approvals);
    const created = await approvals.create({
      workspaceId: WS,
      requestedBy: ACTOR,
      trigger: "bulk_export",
      resource: "workspace",
      resourceId: WS,
      payload: {},
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days future: always valid // determinism-ok: self-consistent, not expired relative to itself
    });
    await approvals.resolve(WS, created.id, "denied", "operator-1");
    const res = await app.request(`/export?approvalRequestId=${created.id}`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("approval_not_approved");
    expect(body.error.details?.status).toBe("denied");
  });

  it("returns 403 when approval is expired (expiresAt in past)", async () => {
    const { app } = buildApp(["memory:export"], approvals);
    const created = await approvals.create({
      workspaceId: WS,
      requestedBy: ACTOR,
      trigger: "bulk_export",
      resource: "workspace",
      resourceId: WS,
      payload: {},
      expiresAt: new Date(Date.now() + 60_000), // determinism-ok: moved into the past below
    });
    await approvals.resolve(WS, created.id, "approved", "operator-1");
    // APP-007: an expired request can no longer be approved, so it expires after approval.
    (await approvals.get(WS, created.id))!.expiresAt = new Date("2025-01-01T00:00:00Z");
    const res = await app.request(`/export?approvalRequestId=${created.id}`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("approval_expired");
  });

  it("returns 200 with export payload when approval is valid and approved", async () => {
    const { app, storage } = buildApp(["memory:export"], approvals);
    const created = await approvals.create({
      workspaceId: WS,
      requestedBy: ACTOR,
      trigger: "bulk_export",
      resource: "workspace",
      resourceId: WS,
      // The request the approval was raised on (S1): it is spent only there.
      payload: { method: "GET", path: "/export" },
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days future: always valid // determinism-ok: self-consistent, not expired relative to itself
    });
    await approvals.resolve(WS, created.id, "approved", "operator-1");
    const res = await app.request(`/export?approvalRequestId=${created.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.workspaceId).toBe(WS);
    expect(body.meta.embeddingsExcluded).toBe(true);
    expect(Array.isArray(body.facts)).toBe(true);
    expect(storage!.queryFactsPage).toHaveBeenCalledWith({
      workspaceId: WS,
      status: "all",
      sortBy: "created_at",
      order: "asc",
      limit: 500,
      // The caller's read ceiling (default env ceiling here).
      maxSensitivity: "internal",
    });
  });

  it("returns 403 APPROVAL_WORKSPACE_MISMATCH when approval belongs to different workspace", async () => {
    const DIFFERENT_WS = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    // Create approval for a different workspace
    const created = await approvals.create({
      workspaceId: DIFFERENT_WS,
      requestedBy: ACTOR,
      trigger: "bulk_export",
      resource: "workspace",
      resourceId: DIFFERENT_WS,
      payload: {},
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days future: always valid // determinism-ok: self-consistent, not expired relative to itself
    });
    await approvals.resolve(DIFFERENT_WS, created.id, "approved", "operator-1");

    // But the request is scoped to WS (not DIFFERENT_WS)
    // We build the app for WS — so when it calls approvals.get(WS, created.id), it won't find it
    const { app } = buildApp(["memory:export"], approvals);
    const res = await app.request(`/export?approvalRequestId=${created.id}`);
    // InMemoryApprovalStore.get is scoped by workspaceId, so this returns null
    expect(res.status).toBe(403);
    const body = await res.json();
    // Either not_found (store filtered it out) or workspace_mismatch
    expect(["approval_not_found", "approval_workspace_mismatch"]).toContain(body.error.code);
  });
});

describe("GET /export — approval gate requires a user-bound key (G2 fix)", () => {
  it("rejects with 403 when the key has no bound userId, even with an ApprovalStore wired", async () => {
    const approvals = new InMemoryApprovalStore();
    // A key with no userId (e.g. a service/workspace key) must not be able to
    // request or consume export approvals — requestedBy/resolvedBy dual
    // control is keyed on the human, not the credential.
    const { app } = buildApp(["memory:export"], approvals, WS, null);
    const res = await app.request("/export");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("user_binding_required");
  });
});

// S1 (re-audit 2026-11-22). The export gate took any approved, unexpired
// approval of the workspace: no trigger, requester or single-use check, never
// consumed. One approved delete_fact (or one export approval) exported the
// workspace as many times as anyone liked.
describe("GET /export — an approval is one export by the user who asked for it", () => {
  let approvals: InMemoryApprovalStore;
  beforeEach(() => {
    approvals = new InMemoryApprovalStore();
  });

  async function approvedExport(path = "/export"): Promise<string> {
    const { app } = buildApp(["memory:export"], approvals);
    const gate = await (await app.request(path)).json();
    await approvals.resolve(WS, gate.approvalRequestId, "approved", "operator-1");
    return gate.approvalRequestId as string;
  }

  it("refuses an approval granted for another trigger", async () => {
    const other = await approvals.create({
      workspaceId: WS,
      requestedBy: ACTOR,
      trigger: "delete_fact",
      resource: "facts",
      payload: { method: "GET", path: "/export" },
      expiresAt: new Date(Date.now() + 60_000), // determinism-ok: judged against the real clock
    });
    await approvals.resolve(WS, other.id, "approved", "operator-1");
    const { app } = buildApp(["memory:export"], approvals);
    const res = await app.request(`/export?approvalRequestId=${other.id}`);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("approval_wrong_trigger");
  });

  it("refuses an approval requested by another user", async () => {
    const id = await approvedExport();
    const { app } = buildApp(["memory:export"], approvals, WS, "someone-else");
    const res = await app.request(`/export?approvalRequestId=${id}`);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("approval_wrong_requester");
  });

  it("is spent by the first export it lets through", async () => {
    const id = await approvedExport();
    const { app } = buildApp(["memory:export"], approvals);
    expect((await app.request(`/export?approvalRequestId=${id}`)).status).toBe(200);
    const second = await app.request(`/export?approvalRequestId=${id}`);
    expect(second.status).toBe(403);
    const body = await second.json();
    expect(body.error.code).toBe("approval_not_approved");
    expect(body.error.details?.status).toBe("consumed");
  });

  it("does not cover a broader export of the same route (re-audit 2, item 5)", async () => {
    const { app } = buildApp(["memory:export"], approvals);
    const post = (body: Record<string, unknown>, id?: string) =>
      app.request(`/export${id ? `?approvalRequestId=${id}` : ""}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const gate = await (await post({ includeEmbeddings: false })).json();
    await approvals.resolve(WS, gate.approvalRequestId, "approved", "operator-1");
    const wider = await post({ includeEmbeddings: true }, gate.approvalRequestId);
    expect(wider.status).toBe(403);
    expect((await wider.json()).error.code).toBe("approval_not_covering");
    const same = await post({ includeEmbeddings: false }, gate.approvalRequestId);
    expect(same.status).toBe(200);
  });

  it("covers only the export it was raised for", async () => {
    const id = await approvedExport("/export");
    const { app } = buildApp(["memory:export"], approvals);
    const res = await app.request(`/export/jsonl?approvalRequestId=${id}`);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("approval_not_covering");
  });
});
