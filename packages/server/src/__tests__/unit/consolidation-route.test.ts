import bcrypt from "bcrypt";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";

const { runConsolidationTick } = vi.hoisted(() => ({
  runConsolidationTick: vi.fn(),
}));

vi.mock("@mnemo-ai/consolidation", () => ({ runConsolidationTick }));

const API_KEY = "mns_live_consolidationroutetest001";
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000021";
const queryFacts = vi.fn();
const appendAuditEntry = vi.fn(async () => undefined);
const idempotencyStore = {
  begin: vi.fn(),
  complete: vi.fn(),
  recordPhase: vi.fn(),
  getRecoveryPoint: vi.fn(),
};

let tickResult = {
  workspaceCount: 1,
  mergedPairs: 0,
  skippedPairs: 0,
  candidateCount: 0,
  errors: 0,
};

let app: ReturnType<typeof createApp>;

function authed(): Record<string, string> {
  return {
    authorization: `Bearer ${API_KEY}`,
    "content-type": "application/json",
  };
}

beforeAll(async () => {
  const keyHash = await bcrypt.hash(API_KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [
      {
        id: "consolidation-route-key",
        keyHash,
        workspaceId: WORKSPACE_ID,
        scopes: ["memory:governance", "memory:read"],
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;

  const deps = {
    core: {},
    apiKeys,
    embedModel: "text-embedding-3-small",
    storage: { queryFacts, appendAuditEntry },
    idempotencyStore,
  } as unknown as ServerDeps;

  app = createApp({ deps, version: "0.0.0-test" });
});

beforeEach(() => {
  queryFacts.mockReset();
  appendAuditEntry.mockReset().mockResolvedValue(undefined);
  idempotencyStore.begin.mockReset().mockResolvedValue({ state: "new" });
  idempotencyStore.complete.mockReset().mockResolvedValue(undefined);
  idempotencyStore.recordPhase.mockReset().mockResolvedValue(undefined);
  idempotencyStore.getRecoveryPoint.mockReset().mockResolvedValue(null);
  tickResult = {
    workspaceCount: 1,
    mergedPairs: 0,
    skippedPairs: 0,
    candidateCount: 0,
    errors: 0,
  };
  runConsolidationTick.mockReset().mockImplementation(async (ctx, workspaceId) => {
    await ctx.storage.queryFacts({ workspaceId });
    return tickResult;
  });
});

describe("POST /consolidation/trigger", () => {
  it("rejects dry-run before scheduler or storage access", async () => {
    const response = await app.request("/consolidation/trigger", {
      method: "POST",
      headers: { ...authed(), "Idempotency-Key": "dry-run-request" },
      body: JSON.stringify({ mode: "fast", dryRun: true }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "dry_run_not_supported",
        message: "Consolidation dry-run is not supported yet; no changes were made.",
      },
    });
    expect(runConsolidationTick).not.toHaveBeenCalled();
    expect(queryFacts).not.toHaveBeenCalled();
    expect(idempotencyStore.begin).not.toHaveBeenCalled();
    expect(idempotencyStore.complete).not.toHaveBeenCalled();
    expect(idempotencyStore.recordPhase).not.toHaveBeenCalled();
    expect(idempotencyStore.getRecoveryPoint).not.toHaveBeenCalled();
  });

  it("rejects deep mode through the alias before idempotency or storage access", async () => {
    const response = await app.request("/admin/consolidate", {
      method: "POST",
      headers: { ...authed(), "Idempotency-Key": "deep-mode-request" },
      body: JSON.stringify({ mode: "deep", dryRun: false }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "deep_mode_not_supported",
        message: "Manual deep consolidation is not supported yet; no changes were made.",
      },
    });
    expect(runConsolidationTick).not.toHaveBeenCalled();
    expect(queryFacts).not.toHaveBeenCalled();
    expect(idempotencyStore.begin).not.toHaveBeenCalled();
    expect(idempotencyStore.complete).not.toHaveBeenCalled();
    expect(idempotencyStore.recordPhase).not.toHaveBeenCalled();
    expect(idempotencyStore.getRecoveryPoint).not.toHaveBeenCalled();
  });

  it("leaves malformed consolidation requests to normal validation", async () => {
    const response = await app.request("/consolidation/trigger", {
      method: "POST",
      headers: { ...authed(), "Idempotency-Key": "malformed-request" },
      body: JSON.stringify({ mode: "invalid", dryRun: true }),
    });

    expect(response.status).toBe(400);
    expect(idempotencyStore.begin).toHaveBeenCalledOnce();
    expect(idempotencyStore.getRecoveryPoint).toHaveBeenCalledOnce();
    expect(idempotencyStore.complete).toHaveBeenCalledOnce();
    expect(idempotencyStore.recordPhase).not.toHaveBeenCalled();
    expect(runConsolidationTick).not.toHaveBeenCalled();
    expect(queryFacts).not.toHaveBeenCalled();
  });

  it("preserves the successful fast-mode response", async () => {
    tickResult = {
      workspaceCount: 1,
      mergedPairs: 1,
      skippedPairs: 2,
      candidateCount: 3,
      errors: 0,
    };

    const response = await app.request("/consolidation/trigger", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ mode: "fast", dryRun: false }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accepted: true,
      workspaceId: WORKSPACE_ID,
      mode: "fast",
      dryRun: false,
      mergedPairs: 1,
      skippedPairs: 2,
      candidatesProcessed: 3,
      errors: 0,
    });
    expect(runConsolidationTick).toHaveBeenCalledOnce();
    expect(runConsolidationTick).toHaveBeenCalledWith(expect.any(Object), WORKSPACE_ID);
    expect(queryFacts).toHaveBeenCalledOnce();
    expect(queryFacts).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID });
  });

  it("seals the caller's resolveProvenance() actor onto the SchedulerContext (p47)", async () => {
    const response = await app.request("/consolidation/trigger", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ mode: "fast", dryRun: false }),
    });

    expect(response.status).toBe(200);
    expect(runConsolidationTick).toHaveBeenCalledOnce();
    const ctxArg = runConsolidationTick.mock.calls[0]![0] as {
      actor: { actorType: string; actorId: string; userId: string | null };
    };
    // "consolidation-route-key" is the mocked API key row id (mns_live_ legacy
    // key) — resolveProvenance() namespaces it as "key:<id>" and auth.ts
    // hardcodes actorType "user" for every legacy mns_* key; no userId bound.
    expect(ctxArg.actor.actorId).toBe("key:consolidation-route-key");
    expect(ctxArg.actor.actorType).toBe("user");
    expect(ctxArg.actor.userId).toBeNull();
  });

  it("p45 Slice C: emits an admin_access audit entry reusing the same resolveProvenance() call (p47)", async () => {
    tickResult = {
      workspaceCount: 1,
      mergedPairs: 2,
      skippedPairs: 1,
      candidateCount: 3,
      errors: 0,
    };

    const response = await app.request("/consolidation/trigger", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ mode: "fast", dryRun: false }),
    });

    expect(response.status).toBe(200);
    expect(appendAuditEntry).toHaveBeenCalledOnce();
    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        actorId: "key:consolidation-route-key",
        actorType: "user",
        action: "admin_access",
        resourceKind: "consolidation",
        resourceId: "fast",
      })
    );
  });
});

describe("consolidation OpenAPI contract", () => {
  it("describes bounded fast-mode behavior and declares the canonical 422 error schema", async () => {
    const response = await app.request("/openapi.json", {
      headers: authed(),
    });
    const document = (await response.json()) as {
      paths: Record<
        string,
        {
          post?: {
            description?: string;
            responses?: Record<
              string,
              {
                content?: {
                  "application/json"?: {
                    schema?: {
                      properties?: Record<string, unknown>;
                    };
                  };
                };
              }
            >;
          };
        }
      >;
      components?: {
        schemas?: Record<
          string,
          {
            properties?: Record<string, { type?: string; enum?: unknown[] }>;
          }
        >;
      };
    };
    const operation = document.paths["/consolidation/trigger"]?.post;
    const schema = operation?.responses?.["422"]?.content?.["application/json"]?.schema as {
      required?: string[];
      properties?: {
        error?: {
          type?: string;
          required?: string[];
          properties?: Record<string, { type?: string; additionalProperties?: unknown }>;
        };
      };
    };
    const errorSchema = schema?.properties?.error;
    const successSchema = document.components?.schemas?.TriggerConsolidationResponse;

    expect(response.status).toBe(200);
    expect(operation?.description).toContain("bounded low-worth candidate set");
    expect(operation?.description).toContain("does not reweight or reindex the entire graph");
    expect(successSchema?.properties?.mode).toMatchObject({
      type: "string",
      enum: ["fast"],
    });
    expect(successSchema?.properties?.dryRun).toMatchObject({
      type: "boolean",
      enum: [false],
    });
    expect(schema?.required).toEqual(["error"]);
    expect(errorSchema?.type).toBe("object");
    expect(errorSchema?.required).toEqual(["type", "code", "message"]);
    expect(errorSchema?.properties).toEqual(
      expect.objectContaining({
        type: expect.objectContaining({ type: "string" }),
        code: expect.objectContaining({ type: "string" }),
        message: expect.objectContaining({ type: "string" }),
        param: expect.objectContaining({ type: "string" }),
        details: expect.objectContaining({ type: "object" }),
        request_id: expect.objectContaining({ type: "string" }),
      })
    );
    expect(errorSchema?.required).not.toContain("param");
    expect(errorSchema?.required).not.toContain("details");
    expect(errorSchema?.required).not.toContain("request_id");
  });
});
