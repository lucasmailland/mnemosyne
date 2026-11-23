/**
 * §19 agent policy administration: /admin/agent-policies and
 * /admin/agent-policy (routes/admin-agent-policies.ts), through the full
 * createApp stack so the scope guard and the RBAC middleware both run.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import bcrypt from "bcrypt";
import { createApp } from "../../app.js";
import { InMemoryAccessPolicyStore, InMemoryApprovalStore } from "@mnemo-ai/types/testing";
import type { ServerDeps } from "../../deps.js";
import type { ApiKeyLookup } from "../../auth.js";
import { makeMockCognitive } from "../helpers/mockCognitive.js";

const WS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_WS = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const KEYS = {
  admin: {
    id: "key-admin",
    ws: WS,
    scopes: ["memory:admin"],
    secret: "mns_test_policyadmin000000000001",
  },
  agent: {
    id: "key-agent",
    ws: WS,
    scopes: ["memory:read", "memory:write"],
    secret: "mns_test_policyagent000000000001",
  },
  otherAdmin: {
    id: "key-other-admin",
    ws: OTHER_WS,
    scopes: ["memory:admin"],
    secret: "mns_test_policyother000000000001",
  },
} as const;

type KeyName = keyof typeof KEYS;
const hashes: Partial<Record<KeyName, string>> = {};

beforeAll(async () => {
  for (const name of Object.keys(KEYS) as KeyName[]) {
    hashes[name] = await bcrypt.hash(KEYS[name].secret, 4);
  }
});

function apiKeys(): ApiKeyLookup {
  return {
    async listActive() {
      return (Object.keys(KEYS) as KeyName[]).map((name) => ({
        id: KEYS[name].id,
        keyHash: hashes[name]!,
        workspaceId: KEYS[name].ws,
        scopes: [...KEYS[name].scopes],
        plan: "free",
      }));
    },
    async touch() {},
  };
}

function makeApp(opts: { withStore?: boolean } = {}) {
  const policies = new InMemoryAccessPolicyStore();
  const appendAuditEntry = vi.fn(async () => {});
  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps = {
    apiKeys: apiKeys(),
    embedModel: "text-embedding-3-small",
    cognitive: makeMockCognitive(),
    storage: { appendAuditEntry },
    ...(opts.withStore === false ? {} : { accessPolicies: policies }),
    approvals: new InMemoryApprovalStore(),
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  } as unknown as ServerDeps;
  return { app: createApp({ deps, version: "test" }), policies, appendAuditEntry };
}

function call(
  app: ReturnType<typeof makeApp>["app"],
  as: KeyName,
  method: string,
  path: string,
  body?: unknown
) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${KEYS[as].secret}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function policyFor(agentId: string, over: Record<string, unknown> = {}) {
  return {
    agentId,
    readScopes: ["memory:read"],
    writeScopes: ["memory:write"],
    selfEdit: { enabled: false },
    taskScopes: { canCreate: false, canDelegate: false, canDelegateTo: [] },
    limits: {
      maxRecallsPerMinute: 600,
      maxWritesPerMinute: 120,
      maxSessionsConcurrent: 10,
      maxSelfEditsPerSession: 3,
    },
    requireApprovalFor: [],
    federationAccess: "none",
    ...over,
  };
}

describe("agent policy administration", () => {
  it("answers 503 when the policy store is not configured", async () => {
    const { app } = makeApp({ withStore: false });
    const res = await call(app, "admin", "GET", "/admin/agent-policies");
    expect(res.status).toBe(503);
  });

  it("requires memory:admin for every route", async () => {
    const { app } = makeApp();
    expect((await call(app, "agent", "GET", "/admin/agent-policies")).status).toBe(403);
    expect((await call(app, "agent", "GET", "/admin/agent-policy?agentId=x")).status).toBe(403);
    expect((await call(app, "agent", "PUT", "/admin/agent-policy", policyFor("x"))).status).toBe(
      403
    );
    expect((await call(app, "agent", "DELETE", "/admin/agent-policy?agentId=x")).status).toBe(403);
  });

  it("rejects a body that does not match the policy shape", async () => {
    const { app, policies } = makeApp();
    const bad = [
      policyFor("x", { readScopes: ["memory:everything"] }),
      policyFor("x", { requireApprovalFor: ["launch_rockets"] }),
      policyFor("x", { federationAccess: "write" }),
      policyFor("x", { limits: { ...policyFor("x").limits, maxWritesPerMinute: -1 } }),
      policyFor("x", { extra: true }),
      { ...policyFor("x"), limits: undefined },
    ];
    for (const body of bad) {
      expect((await call(app, "admin", "PUT", "/admin/agent-policy", body)).status).toBe(400);
    }
    expect(await policies.listPolicies(WS)).toEqual([]);
  });

  it("never writes or reads across workspaces", async () => {
    const { app, policies } = makeApp();
    // A body naming another workspace is refused outright.
    const forged = { ...policyFor(KEYS.agent.id), workspaceId: OTHER_WS };
    expect((await call(app, "admin", "PUT", "/admin/agent-policy", forged)).status).toBe(400);

    const put = await call(app, "admin", "PUT", "/admin/agent-policy", policyFor(KEYS.agent.id));
    expect(put.status).toBe(200);
    expect((await put.json()).workspaceId).toBe(WS);

    const q = `/admin/agent-policy?agentId=${KEYS.agent.id}`;
    expect((await call(app, "otherAdmin", "GET", q)).status).toBe(404);
    expect((await call(app, "otherAdmin", "DELETE", q)).status).toBe(404);
    const otherList = await call(app, "otherAdmin", "GET", "/admin/agent-policies");
    expect((await otherList.json()).policies).toEqual([]);
    expect(await policies.getPolicy(WS, KEYS.agent.id)).not.toBeNull();
  });

  it("refuses to let a key change its own policy", async () => {
    const { app } = makeApp();
    const own = policyFor(KEYS.admin.id, { readScopes: [], writeScopes: [] });
    expect((await call(app, "admin", "PUT", "/admin/agent-policy", own)).status).toBe(403);
    const del = await call(app, "admin", "DELETE", `/admin/agent-policy?agentId=${KEYS.admin.id}`);
    expect(del.status).toBe(403);
  });

  it("without a policy the same agent write is not refused (baseline for the round trip)", async () => {
    const { app } = makeApp();
    const write = await call(app, "agent", "POST", "/remember", {
      statement: "Acme ships on Fridays",
    });
    expect(write.status).not.toBe(403);
  });

  it("a policy written or deleted takes effect at once, not after the cache TTL", async () => {
    const { app } = makeApp();
    const write = () =>
      call(app, "agent", "POST", "/remember", { statement: "Acme ships on Fridays" });
    // Caches "no policy" for the agent.
    expect((await write()).status).not.toBe(403);
    const body = policyFor(KEYS.agent.id, { writeScopes: [] });
    expect((await call(app, "admin", "PUT", "/admin/agent-policy", body)).status).toBe(200);
    expect((await write()).status).toBe(403);
    expect(
      (await call(app, "admin", "DELETE", `/admin/agent-policy?agentId=${KEYS.agent.id}`)).status
    ).toBe(204);
    expect((await write()).status).not.toBe(403);
  });

  it("round trip: write, read, list, the agent is restricted, then delete", async () => {
    const { app, appendAuditEntry } = makeApp();
    // The agent may read but has no write scope in its policy.
    const body = policyFor(KEYS.agent.id, { writeScopes: [], namespaces: ["team-*"] });
    const put = await call(app, "admin", "PUT", "/admin/agent-policy", body);
    expect(put.status).toBe(200);

    const got = await call(app, "admin", "GET", `/admin/agent-policy?agentId=${KEYS.agent.id}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ ...body, workspaceId: WS });

    const list = await call(app, "admin", "GET", "/admin/agent-policies");
    expect((await list.json()).policies.map((p: { agentId: string }) => p.agentId)).toEqual([
      KEYS.agent.id,
    ]);

    // The agent's next write is denied by the policy it was just given.
    const write = await call(app, "agent", "POST", "/remember", {
      statement: "Acme ships on Fridays",
    });
    expect(write.status).toBe(403);
    const outside = await app.request("/recall", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEYS.agent.secret}`,
        "content-type": "application/json",
        "x-mnemo-namespace": "sales",
      },
      body: JSON.stringify({ query: "Acme" }),
    });
    expect(outside.status).toBe(403);

    const del = await call(app, "admin", "DELETE", `/admin/agent-policy?agentId=${KEYS.agent.id}`);
    expect(del.status).toBe(204);
    expect(
      (await call(app, "admin", "GET", `/admin/agent-policy?agentId=${KEYS.agent.id}`)).status
    ).toBe(404);

    const audited = appendAuditEntry.mock.calls.map(
      (args) => (args as unknown as [{ resourceKind: string; detail: { method: string } }])[0]
    );
    expect(
      audited.filter((e) => e.resourceKind === "agent_policy").map((e) => e.detail.method)
    ).toEqual(["PUT", "DELETE"]);
  });
});
