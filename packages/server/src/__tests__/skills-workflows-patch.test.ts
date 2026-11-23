/**
 * P111/P112 — PATCH /skills/:id and PATCH /workflows/:id.
 *
 * `updateSkill` and `updateWorkflow` were implemented on every adapter and
 * called from nowhere: no route, no MCP tool, no CLI command. Both primitives
 * could be created and then never corrected — for a stored prompt template and
 * a reusable process template, that is the whole point of storing them.
 *
 * These tests cover the shape of the new routes and the two properties that
 * make a PATCH different from a create: only supplied fields travel, and the
 * workspace comes from the row rather than the body.
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

const PLAINTEXT_KEY = "mns_live_patchtest0000000000001";
const WS_ID = "00000000-0000-0000-0000-000000000024";
const NOW = new Date("2026-08-12T00:00:00.000Z");

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "key001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

const authed = () => ({
  authorization: `Bearer ${PLAINTEXT_KEY}`,
  "content-type": "application/json",
});

const makeCoreDeps = () => ({ recall: async () => [] }) as unknown as ServerDeps["core"];

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

async function harness(storage: Partial<StorageAdapter>) {
  const deps = {
    core: makeCoreDeps(),
    apiKeys: await makeKeyLookup(),
    embedModel: "text-embedding-3-small",
    storage: storage as StorageAdapter,
  } as unknown as ServerDeps;
  return buildMountHarness(deps, [mountWorkflows, mountSkills]);
}

describe("PATCH /skills/:id (P111)", () => {
  it("passes only the supplied fields through to updateSkill", async () => {
    let captured: Record<string, unknown> | undefined;
    const app = await harness({
      getSkill: async () => fakeSkill(),
      updateSkill: async (_id: string, input: unknown) => {
        captured = input as Record<string, unknown>;
        return fakeSkill({ promptTemplate: "Write BETTER SQL for {goal}" });
      },
    } as Partial<StorageAdapter>);

    const res = await app.request("/skills/sk1", {
      method: "PATCH",
      headers: authed(),
      body: JSON.stringify({ promptTemplate: "Write BETTER SQL for {goal}" }),
    });

    expect(res.status).toBe(200);
    expect(captured).toBeDefined();
    // The workspace comes from the authenticated row, never the body.
    expect(captured!.workspaceId).toBe(WS_ID);
    expect(captured!.promptTemplate).toBe("Write BETTER SQL for {goal}");
    // Untouched fields must be absent, not undefined-valued: an adapter that
    // spreads the input would otherwise blank them.
    expect(Object.keys(captured!).sort()).toEqual(["promptTemplate", "workspaceId"]);
  });

  it("404s for a skill that does not exist, without calling updateSkill", async () => {
    let called = false;
    const app = await harness({
      getSkill: async () => null,
      updateSkill: async () => {
        called = true;
        return fakeSkill();
      },
    } as Partial<StorageAdapter>);

    const res = await app.request("/skills/nope", {
      method: "PATCH",
      headers: authed(),
      body: JSON.stringify({ name: "x" }),
    });

    expect(res.status).toBe(404);
    expect(called).toBe(false);
  });

  it("rejects an empty body rather than issuing a no-op write", async () => {
    const app = await harness({
      getSkill: async () => fakeSkill(),
      updateSkill: async () => fakeSkill(),
    } as Partial<StorageAdapter>);

    const res = await app.request("/skills/sk1", {
      method: "PATCH",
      headers: authed(),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

describe("PATCH /workflows/:id (P111)", () => {
  it("passes only the supplied fields through to updateWorkflow", async () => {
    let captured: Record<string, unknown> | undefined;
    const app = await harness({
      getWorkflow: async () => fakeWorkflow(),
      updateWorkflow: async (_id: string, input: unknown) => {
        captured = input as Record<string, unknown>;
        return fakeWorkflow({ status: "deprecated" });
      },
    } as Partial<StorageAdapter>);

    const res = await app.request("/workflows/wf1", {
      method: "PATCH",
      headers: authed(),
      body: JSON.stringify({ status: "deprecated" }),
    });

    expect(res.status).toBe(200);
    expect(captured!.workspaceId).toBe(WS_ID);
    expect(Object.keys(captured!).sort()).toEqual(["status", "workspaceId"]);
  });

  it("rejects a status outside the real enum", async () => {
    const app = await harness({
      getWorkflow: async () => fakeWorkflow(),
      updateWorkflow: async () => fakeWorkflow(),
    } as Partial<StorageAdapter>);

    // "archived" is not a MnemoWorkflow status — the set is
    // active | deprecated | draft.
    const res = await app.request("/workflows/wf1", {
      method: "PATCH",
      headers: authed(),
      body: JSON.stringify({ status: "archived" }),
    });

    expect(res.status).toBe(400);
  });

  it("404s for a workflow that does not exist", async () => {
    const app = await harness({
      getWorkflow: async () => null,
      updateWorkflow: async () => fakeWorkflow(),
    } as Partial<StorageAdapter>);

    const res = await app.request("/workflows/nope", {
      method: "PATCH",
      headers: authed(),
      body: JSON.stringify({ name: "x" }),
    });

    expect(res.status).toBe(404);
  });
});
