/**
 * SEC-1 — RBAC middleware mount smoke tests.
 *
 * Verifies that createApp correctly:
 *   - mounts RBAC + approval middleware when both deps are supplied
 *   - passes through (no 403) when no policy is configured for the agent
 *   - returns 202 + approval_request_id for a delete_fact trigger when a
 *     policy requiring approval is configured
 *   - skips RBAC entirely when accessPolicies dep is absent (backward compat)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcrypt";
import { createApp } from "../../app.js";
import { InMemoryAccessPolicyStore } from "@mnemo-ai/types/testing";
import { InMemoryApprovalStore } from "@mnemo-ai/types/testing";
import type { ServerDeps } from "../../deps.js";
import type { ApiKeyLookup } from "../../auth.js";
import { makeMockCognitive } from "../helpers/mockCognitive.js";

const WS = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const AGENT = "agent-sec1-test";
// Use a valid mns_test_ key pattern so the auth pattern passes.
// Suffix must be 20+ lowercase alphanumeric chars.
const KEY = "mns_test_sec1mounttest00000001";
let keyHash = "";

beforeEach(async () => {
  keyHash = await bcrypt.hash(KEY, 4); // cost 4 for test speed
});

/** Minimal ApiKeyLookup that authenticates one hardcoded key. */
function makeApiKeys(): ApiKeyLookup {
  return {
    async listActive() {
      return [
        {
          id: AGENT,
          keyHash,
          workspaceId: WS,
          scopes: ["memory:read", "memory:write", "memory:delete"],
          plan: "free",
          userId: AGENT,
        },
      ];
    },
    async touch() {},
  };
}

/** Build a full app with optional RBAC deps. */
function makeApp(accessPolicies?: InMemoryAccessPolicyStore, approvals?: InMemoryApprovalStore) {
  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps = {
    apiKeys: makeApiKeys(),
    embedModel: "text-embedding-3-small",
    cognitive: makeMockCognitive(),
    ...(accessPolicies ? { accessPolicies } : {}),
    ...(approvals ? { approvals } : {}),
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  } as unknown as ServerDeps;
  return createApp({ deps, version: "test" });
}

function authHeader() {
  return { Authorization: `Bearer ${KEY}` };
}

describe("SEC-1 — RBAC middleware mounted in createApp", () => {
  it("passes through with no RBAC deps (backward compat — no 4xx on any route)", async () => {
    const app = makeApp();
    // Any authenticated request should not blow up with RBAC-related errors
    const res = await app.request("/recall", {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ query: "test" }),
    });
    // We only care it isn't a 401/403 from RBAC; 422/500 from route logic is fine
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("passes through when agent has no policy configured (open agent)", async () => {
    const policies = new InMemoryAccessPolicyStore();
    const approvals = new InMemoryApprovalStore();
    // No policy for AGENT → middleware must not restrict
    const app = makeApp(policies, approvals);
    const res = await app.request("/recall", {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ query: "test" }),
    });
    expect(res.status).not.toBe(403);
  });

  it("returns 202 with approval_request_id when delete_fact trigger fires", async () => {
    const policies = new InMemoryAccessPolicyStore();
    const approvals = new InMemoryApprovalStore();
    // Register a policy that requires approval for delete_fact
    await policies.putPolicy({
      agentId: AGENT,
      workspaceId: WS,
      readScopes: ["memory:read"],
      writeScopes: ["memory:write", "memory:delete"],
      selfEdit: { enabled: false },
      taskScopes: { canCreate: false, canDelegate: false, canDelegateTo: [] },
      limits: {
        maxRecallsPerMinute: 600,
        maxWritesPerMinute: 120,
        maxSessionsConcurrent: 10,
        maxSelfEditsPerSession: 3,
      },
      requireApprovalFor: ["delete_fact"],
      federationAccess: "none",
    });

    const app = makeApp(policies, approvals);
    const res = await app.request("/facts/some-id", {
      method: "DELETE",
      headers: authHeader(),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.approval_request_id).toBeTruthy();
    expect(body.status).toBe("pending");
  });
});
