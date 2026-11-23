/**
 * Tier A parity — GET/POST /export, GET /export/jsonl (design.md D3).
 *
 * HTTP characterization contract for `packages/server/src/routes/export.ts`.
 * Originally written and merged green against the legacy
 * `deps.core.exportWorkspace` (`CoreLike`) implementation (flatten-legacy-
 * dual-core PR5, when the port was blocked — see apply-progress.md PR5
 * "Scope finding"). The port commit (PR9h, design.md D6.5/D6.6) swapped the
 * route to the pure-core `exportWorkspace`/`exportRelations`/
 * `exportCitations` projections (`@mnemo-ai/core/cognitive`), composed from
 * `deps.storage.{queryFactsPage,queryDecisions,getRelations,listCitations}`.
 *
 * Asserts the observable contract on `buildMountHarness()`: status matrix,
 * response key set/types (via `contracts/export.schema.json`), and the
 * approval-gate 202/403 branches. Fine-grained approval-gate edge cases are
 * already covered by `unit/export-approval.test.ts` and JSONL type coverage
 * by `unit/export-coverage.test.ts` — this file is the buildMountHarness()
 * characterization D3 requires, not a duplicate of that coverage.
 *
 * Per D3, response-body assertions (`validate(body, exportSchema)`, status
 * codes) are unchanged by the port. One disclosed exception, unavoidable
 * and not a behavior change: `buildApp`'s deps-fake wiring moved from
 * `deps.core.exportWorkspace` to `deps.storage.{queryFactsPage,
 * queryDecisions,getRelations,listCitations}` — 4 typed calls replace 1
 * legacy call, so the 3 `expect(...).toHaveBeenCalledWith(...)` assertions
 * that verify the legacy call fired now assert the 4 typed calls fired
 * instead (same "composed calls" exception class `relations.parity.test.ts`
 * (PR9d) and `decisions.parity.test.ts` (PR8) already established).
 */
import { describe, it, expect, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import bcrypt from "bcrypt";
import { InMemoryApprovalStore } from "@mnemo-ai/types/testing";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { loadSchema, validate } from "../_schemaValidate.js";
import { mountExport } from "../../routes/export.js";

const PLAINTEXT_KEY = "mns_live_exportparitytest0000001";
const WS_ID = "00000000-0000-0000-0000-000000000e01";

async function makeKeyLookup(scopes: string[]): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    // userId bound — the approval gate (checkApprovalGate) requires a
    // user-bound key: dual control on /approvals/:id/resolve compares
    // requestedBy against the resolver's userId (see routes/approvals.ts).
    listActive: async () => [
      { id: "export-key-001", keyHash, workspaceId: WS_ID, scopes, userId: "user_export_test" },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, ...extra };
}

function fullStorageMock() {
  const emptyPage = { items: [], nextCursor: null };
  return {
    queryFacts: vi.fn().mockResolvedValue(emptyPage),
    // PR9h port: GET/POST /export compose from these 4 typed calls instead
    // of the legacy `deps.core.exportWorkspace` — see this file's header.
    queryFactsPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 }),
    queryDecisions: vi.fn().mockResolvedValue(emptyPage),
    getRelations: vi.fn().mockResolvedValue([]),
    listCitations: vi.fn().mockResolvedValue([]),
    queryEpisodes: vi.fn().mockResolvedValue(emptyPage),
    queryEntities: vi.fn().mockResolvedValue(emptyPage),
    queryStrategies: vi.fn().mockResolvedValue(emptyPage),
    queryWorkflows: vi.fn().mockResolvedValue(emptyPage),
    querySkills: vi.fn().mockResolvedValue(emptyPage),
    queryTasks: vi.fn().mockResolvedValue(emptyPage),
    queryEvents: vi.fn().mockResolvedValue(emptyPage),
    queryReasoning: vi.fn().mockResolvedValue(emptyPage),
    queryHyperedges: vi.fn().mockResolvedValue(emptyPage),
    listWebhookEndpoints: vi.fn().mockResolvedValue([]),
    listReminders: vi.fn().mockResolvedValue([]),
    appendAuditEntry: vi.fn().mockResolvedValue(undefined),
  };
}

async function buildApp(
  opts: {
    scopes?: string[];
    approvals?: InMemoryApprovalStore;
    storage?: ReturnType<typeof fullStorageMock>;
  } = {}
) {
  const scopes = opts.scopes ?? ["memory:export"];
  const storage = opts.storage ?? fullStorageMock();
  const deps = {
    storage,
    apiKeys: await makeKeyLookup(scopes),
    ...(opts.approvals ? { approvals: opts.approvals } : {}),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountExport]);
  return { app, storage };
}

describe("Tier A parity: GET /export", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/export");
    expect(res.status).toBe(401);
  });

  it("returns 403 without memory:export scope", async () => {
    const { app } = await buildApp({ scopes: ["memory:read"] });
    const res = await app.request("/export", { headers: authed() });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INSUFFICIENT_SCOPE");
  });

  it("returns 200 conforming to export.schema.json when no ApprovalStore is wired", async () => {
    const exportSchema = loadSchema("export");
    const { app, storage } = await buildApp();
    const res = await app.request("/export", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(validate(body, exportSchema)).toBeNull();
    expect(storage.queryFactsPage).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      status: "all",
      sortBy: "created_at",
      order: "asc",
      limit: 500,
      // The caller's read ceiling (default env ceiling here).
      maxSensitivity: "internal",
    });
    expect(storage.queryDecisions).toHaveBeenCalledWith({ workspaceId: WS_ID, limit: 100_000 });
    expect(storage.getRelations).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      openOnly: false,
      limit: 100_000,
    });
    expect(storage.listCitations).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      limit: 500,
      offset: 0,
    });
  });

  it("returns 202 pending when an ApprovalStore is wired and no approvalRequestId is given", async () => {
    const { app } = await buildApp({ approvals: new InMemoryApprovalStore() });
    const res = await app.request("/export", { headers: authed() });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; approvalRequestId: string };
    expect(body.status).toBe("pending");
    expect(typeof body.approvalRequestId).toBe("string");
  });
});

describe("Tier A parity: POST /export", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/export", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("returns 200 conforming to export.schema.json (same gate as GET)", async () => {
    const exportSchema = loadSchema("export");
    const { app, storage } = await buildApp();
    const res = await app.request("/export", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(validate(body, exportSchema)).toBeNull();
    expect(storage.queryFactsPage).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      status: "all",
      sortBy: "created_at",
      order: "asc",
      limit: 500,
      // The caller's read ceiling (default env ceiling here).
      maxSensitivity: "internal",
    });
    expect(storage.queryDecisions).toHaveBeenCalledWith({ workspaceId: WS_ID, limit: 100_000 });
  });
});

describe("Tier A parity: GET /export/jsonl", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/export/jsonl");
    expect(res.status).toBe(401);
  });

  it("returns 200 gzip JSONL with a versioned header line as the first record", async () => {
    const { app } = await buildApp();
    const res = await app.request("/export/jsonl", { headers: authed() });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(res.headers.get("Content-Encoding")).toBe("gzip");

    const compressed = Buffer.from(await res.arrayBuffer());
    const plain = gunzipSync(compressed).toString("utf8");
    const lines = plain.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(header["_type"]).toBe("header");
    expect(header["version"]).toBe("mnemo-export-v1");
    expect(header["embeddingsExcluded"]).toBe(true);
  });

  it("uses deps.storage.getRelations/listCitations for the relations + citations lines", async () => {
    const { app, storage } = await buildApp();
    await app.request("/export/jsonl", { headers: authed() });
    expect(storage.getRelations).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      openOnly: false,
      limit: 100_000,
    });
    expect(storage.listCitations).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      limit: 500,
      offset: 0,
    });
  });
});
