/**
 * §4 Knowledge-unit creation routes (deep re-audit P1-5).
 *
 * POST /workflows and POST /skills were the two missing knowledge-unit
 * creation endpoints. These tests confirm create + read + list go through the
 * storage adapter with the right shapes.
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { MnemoWorkflow, MnemoSkill, StorageAdapter } from "@mnemo-ai/types";
import { mountWorkflows } from "../routes/workflows.js";
import { mountSkills } from "../routes/skills.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_workflowskilltest00001";
const WS_ID = "00000000-0000-0000-0000-000000000023";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "key001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json", ...extra };
}

function makeCoreDeps() {
  return { recall: async () => [] } as unknown as ServerDeps["core"];
}

const NOW = new Date("2026-06-17T00:00:00.000Z");

function fakeWorkflow(over: Partial<MnemoWorkflow> = {}): MnemoWorkflow {
  return {
    id: "wf1",
    workspaceId: WS_ID,
    name: "Deploy",
    steps: [{ order: 1, action: "build", expectedDurationMs: 1000 }],
    avgDurationMs: 0,
    successRate: 0,
    executionCount: 0,
    version: 1,
    status: "active",
    // P120: response schemas project the bitemporal interval.
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validTo: null,
    createdAt: NOW,
    updatedAt: NOW,
    metadata: {},
    ...over,
  };
}

function fakeSkill(over: Partial<MnemoSkill> = {}): MnemoSkill {
  return {
    id: "sk1",
    workspaceId: WS_ID,
    name: "sql-gen",
    promptTemplate: "Write SQL for {goal}",
    variables: ["goal"],
    requiredContext: [],
    qualityScore: 0,
    usageCount: 0,
    embeddingStale: true,
    // P120: response schemas project the bitemporal interval.
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validTo: null,
    createdAt: NOW,
    updatedAt: NOW,
    metadata: {},
    ...over,
  };
}

describe("§4 POST /workflows (P1-5)", () => {
  it("creates a workflow via the storage adapter and returns 201", async () => {
    let captured: unknown;
    const storage = {
      createWorkflow: async (input: unknown) => {
        captured = input;
        return fakeWorkflow();
      },
    } as unknown as StorageAdapter;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      storage,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountWorkflows, mountSkills]);

    const res = await app.request("/workflows", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        name: "Deploy",
        steps: [{ order: 1, action: "build", expectedDurationMs: 1000 }],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; steps: unknown[] };
    expect(body.id).toBe("wf1");
    expect(body.name).toBe("Deploy");
    expect(body.steps).toHaveLength(1);
    expect((captured as { workspaceId: string }).workspaceId).toBe(WS_ID);
  });

  it("lists workflows with pagination envelope", async () => {
    const storage = {
      queryWorkflows: async () => ({
        items: [fakeWorkflow()],
        total: 1,
        offset: 0,
        limit: 50,
        hasMore: false,
      }),
    } as unknown as StorageAdapter;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      storage,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountWorkflows, mountSkills]);

    const res = await app.request("/workflows", { method: "GET", headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it("404s an unknown workflow id", async () => {
    const storage = { getWorkflow: async () => null } as unknown as StorageAdapter;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      storage,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountWorkflows, mountSkills]);

    const res = await app.request("/workflows/nope", { method: "GET", headers: authed() });
    expect(res.status).toBe(404);
  });
});

describe("§4 POST /skills (P1-5)", () => {
  it("creates a skill via the storage adapter and returns 201", async () => {
    let captured: unknown;
    const storage = {
      createSkill: async (input: unknown) => {
        captured = input;
        return fakeSkill();
      },
    } as unknown as StorageAdapter;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      storage,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountWorkflows, mountSkills]);

    const res = await app.request("/skills", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        name: "sql-gen",
        promptTemplate: "Write SQL for {goal}",
        variables: ["goal"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; promptTemplate: string };
    expect(body.id).toBe("sk1");
    expect(body.promptTemplate).toBe("Write SQL for {goal}");
    expect((captured as { promptTemplate: string }).promptTemplate).toBe("Write SQL for {goal}");
  });

  it("rejects a skill with an empty promptTemplate (400)", async () => {
    const storage = { createSkill: async () => fakeSkill() } as unknown as StorageAdapter;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      storage,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountWorkflows, mountSkills]);

    const res = await app.request("/skills", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ name: "x", promptTemplate: "" }),
    });
    expect(res.status).toBe(400);
  });
});
