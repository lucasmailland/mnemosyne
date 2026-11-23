/**
 * §19 agent RBAC policies against real Postgres: the four
 * /admin/agent-polic{y,ies} routes and `mnemo policy`, through the real
 * DrizzleAccessPolicyStore and the RBAC middleware it mounts. The round trip
 * ends with the agent's own request being refused by the policy just written.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "../harness/live-surface.js";

let surface: LiveSurface;
let dir: string;

beforeAll(async () => {
  surface = await startLiveSurface({ accessPolicies: true });
  dir = mkdtempSync(join(tmpdir(), "mnemo-policy-it-"));
}, 120_000);

afterAll(async () => {
  await surface.close();
  rmSync(dir, { recursive: true, force: true });
});

const JSON_HEADERS = { "content-type": "application/json" };

function policyBody(agentId: string, writeScopes: string[]) {
  return {
    agentId,
    readScopes: ["memory:read"],
    writeScopes,
    selfEdit: { enabled: false },
    taskScopes: { canCreate: false, canDelegate: false, canDelegateTo: [] },
    limits: {
      maxRecallsPerMinute: 0,
      maxWritesPerMinute: 0,
      maxSessionsConcurrent: 0,
      maxSelfEditsPerSession: 0,
    },
    requireApprovalFor: [],
    federationAccess: "none",
    namespaces: ["acme-*"],
  };
}

async function newAgentKey(label: string): Promise<{ id: string; key: string }> {
  const res = await surface.http("POST", "/admin/keys", {
    headers: JSON_HEADERS,
    body: JSON.stringify({ label, scopes: ["memory:read", "memory:write"] }),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string; key: string }>;
}

describe("agent policy routes (real Postgres)", () => {
  it("PUT, GET, list, the agent is refused, DELETE", async () => {
    const agent = await newAgentKey("Larkspur ingest agent");

    const put = await surface.http("PUT", "/admin/agent-policy", {
      headers: JSON_HEADERS,
      body: JSON.stringify(policyBody(agent.id, [])),
    });
    expect(put.status).toBe(200);

    const got = await surface.http("GET", `/admin/agent-policy?agentId=${agent.id}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({
      ...policyBody(agent.id, []),
      workspaceId: surface.workspaceId,
    });

    const list = await surface.http("GET", "/admin/agent-policies");
    const ids = ((await list.json()) as { policies: { agentId: string }[] }).policies.map(
      (p) => p.agentId
    );
    expect(ids).toContain(agent.id);

    // The policy grants no write scope, so the agent's write is refused.
    const write = await surface.http("POST", "/remember", {
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${agent.key}` },
      body: JSON.stringify({ statement: "Larkspur Robotics ships on Fridays" }),
    });
    expect(write.status).toBe(403);

    const del = await surface.http("DELETE", `/admin/agent-policy?agentId=${agent.id}`);
    expect(del.status).toBe(204);
    const gone = await surface.http("GET", `/admin/agent-policy?agentId=${agent.id}`);
    expect(gone.status).toBe(404);
  });
});

describe("mnemo policy (real CLI binary)", () => {
  it("set, get, list and delete an agent policy", async () => {
    const agent = await newAgentKey("Acme triage agent");
    const file = join(dir, "acme-agent-policy.json");
    writeFileSync(file, JSON.stringify(policyBody("ignored", ["memory:write"])));

    const set = await surface.cli(["policy", "set", agent.id, "--file", file]);
    expect(set.code).toBe(0);
    expect(set.stdout).toContain(agent.id);

    const get = await surface.cli(["policy", "get", agent.id]);
    expect(get.code).toBe(0);
    expect(get.stdout).toContain('"memory:write"');

    const list = await surface.cli(["policy", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(agent.id);

    expect((await surface.cli(["policy", "delete", agent.id])).code).toBe(0);
    expect((await surface.cli(["policy", "get", agent.id])).code).toBe(4);
  });
});
