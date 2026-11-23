/**
 * POST /strategies, /workflows, /skills, /reminders — targetWorkspaceId
 * cross-workspace write parity (P57 slice 2b). Each route gained an optional
 * `targetWorkspaceId` body field + a call to the shared
 * `resolveTargetWorkspace()` helper (slice 1), replacing its previous bare
 * `getAuthCtx(c).workspaceId` read.
 *
 * design.md flags that hono zod-openapi does NOT validate responses at
 * runtime — schema presence alone does not prove a field is actually in the
 * 201 body. Every test here parses the real response JSON and asserts
 * `body.workspaceId` at the value level, not just the type level.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type {
  MnemoStrategy,
  MnemoWorkflow,
  MnemoSkill,
  MnemoReminder,
  StorageAdapter,
} from "@mnemo-ai/types";
import { mountStrategies } from "../routes/strategies.js";
import { mountWorkflows } from "../routes/workflows.js";
import { mountSkills } from "../routes/skills.js";
import { mountReminders } from "../routes/reminders.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_targetworkspaceroutes01";
const KEY_WS_ID = "00000000-0000-0000-0000-cc0000000001";
const TARGET_WS_ID = "00000000-0000-0000-0000-cc0000000002";
const USER_ID = "user-target-workspace-routes-001";

const NOW = new Date("2026-08-11T00:00:00.000Z");

async function makeKeyLookup(opts: { userId?: string | null } = {}): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  // "userId" in opts (not `opts.userId ?? USER_ID`) so an explicit `userId: null`
  // is respected instead of silently falling back to the default USER_ID.
  const userId = "userId" in opts ? opts.userId : USER_ID;
  return {
    listActive: async () => [
      {
        id: "key-target-workspace-routes",
        keyHash,
        workspaceId: KEY_WS_ID,
        scopes: ["memory:write"],
        userId,
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

/** Fake postgres.Sql for the membership check only (no personal-workspace lookup needed here). */
function makeFakeSql(opts: { role?: string | null }) {
  const tx = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("set_config")) return Promise.resolve([]);
    if (text.includes("mnemo_workspace_member")) {
      return Promise.resolve(opts.role ? [{ role: opts.role }] : []);
    }
    return Promise.resolve([]);
  };
  return {
    begin: async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as ServerDeps["metricsPgClient"];
}

const authed = () => ({
  authorization: `Bearer ${PLAINTEXT_KEY}`,
  "content-type": "application/json",
});

function fakeStrategy(over: Partial<MnemoStrategy> = {}): MnemoStrategy {
  return {
    id: "strat-1",
    workspaceId: KEY_WS_ID,
    trigger: "Error occurs",
    action: "Retry with backoff",
    successCount: 0,
    failureCount: 0,
    worth: 0.5,
    status: "active",
    embeddingStale: false,
    validFrom: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    metadata: {},
    ...over,
  };
}

function fakeWorkflow(over: Partial<MnemoWorkflow> = {}): MnemoWorkflow {
  return {
    id: "wf-1",
    workspaceId: KEY_WS_ID,
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
    id: "sk-1",
    workspaceId: KEY_WS_ID,
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

function fakeReminder(over: Partial<MnemoReminder> = {}): MnemoReminder {
  return {
    id: "rem-1",
    workspaceId: KEY_WS_ID,
    content: "Remind about the contract",
    condition: "when user mentions Acme",
    triggerAt: null,
    status: "pending",
    conditionEmbedding: null,
    triggeredAt: null,
    dismissedAt: null,
    createdByAgentId: null,
    // P120: response schemas project the bitemporal interval.
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validTo: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const FORBIDDEN_NOT_MEMBER = {
  error: "forbidden",
  message: "User is not a write member of the target workspace",
};

describe("POST /strategies — targetWorkspaceId", () => {
  it("omitting targetWorkspaceId → 201 in the key's own workspace", async () => {
    let captured: unknown;
    const storage = {
      createStrategy: async (input: unknown) => {
        captured = input;
        return fakeStrategy();
      },
    } as unknown as StorageAdapter;
    const deps = {
      apiKeys: await makeKeyLookup(),
      storage,
      metricsPgClient: makeFakeSql({}),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountStrategies]);

    const res = await app.request("/strategies", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ trigger: "Error occurs", action: "Retry with backoff" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(KEY_WS_ID);
    expect((captured as { workspaceId: string }).workspaceId).toBe(KEY_WS_ID);
  });

  it("write-role member supplies targetWorkspaceId → 201 in the target workspace", async () => {
    let captured: unknown;
    const storage = {
      createStrategy: async (input: unknown) => {
        captured = input;
        return fakeStrategy({ workspaceId: TARGET_WS_ID });
      },
    } as unknown as StorageAdapter;
    const deps = {
      apiKeys: await makeKeyLookup(),
      storage,
      metricsPgClient: makeFakeSql({ role: "write" }),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountStrategies]);

    const res = await app.request("/strategies", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        trigger: "Error occurs",
        action: "Retry with backoff",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(TARGET_WS_ID);
    expect((captured as { workspaceId: string }).workspaceId).toBe(TARGET_WS_ID);
  });

  it("non-member supplies targetWorkspaceId → 403 forbidden, zero writes", async () => {
    const createStrategy = vi.fn();
    const storage = { createStrategy } as unknown as StorageAdapter;
    const deps = {
      apiKeys: await makeKeyLookup(),
      storage,
      metricsPgClient: makeFakeSql({ role: null }),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountStrategies]);

    const res = await app.request("/strategies", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        trigger: "Error occurs",
        action: "Retry with backoff",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual(FORBIDDEN_NOT_MEMBER);
    expect(createStrategy).not.toHaveBeenCalled();
  });
});

describe("POST /workflows — targetWorkspaceId", () => {
  it("omitting targetWorkspaceId → 201 in the key's own workspace", async () => {
    let captured: unknown;
    const storage = {
      createWorkflow: async (input: unknown) => {
        captured = input;
        return fakeWorkflow();
      },
    } as unknown as StorageAdapter;
    const deps = {
      apiKeys: await makeKeyLookup(),
      storage,
      metricsPgClient: makeFakeSql({}),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountWorkflows]);

    const res = await app.request("/workflows", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        name: "Deploy",
        steps: [{ order: 1, action: "build", expectedDurationMs: 1000 }],
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(KEY_WS_ID);
    expect((captured as { workspaceId: string }).workspaceId).toBe(KEY_WS_ID);
  });

  it("write-role member supplies targetWorkspaceId → 201 in the target workspace", async () => {
    let captured: unknown;
    const storage = {
      createWorkflow: async (input: unknown) => {
        captured = input;
        return fakeWorkflow({ workspaceId: TARGET_WS_ID });
      },
    } as unknown as StorageAdapter;
    const deps = {
      apiKeys: await makeKeyLookup(),
      storage,
      metricsPgClient: makeFakeSql({ role: "admin" }),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountWorkflows]);

    const res = await app.request("/workflows", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        name: "Deploy",
        steps: [{ order: 1, action: "build", expectedDurationMs: 1000 }],
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(TARGET_WS_ID);
    expect((captured as { workspaceId: string }).workspaceId).toBe(TARGET_WS_ID);
  });

  it("read-role member supplies targetWorkspaceId → 403 forbidden, zero writes", async () => {
    const createWorkflow = vi.fn();
    const storage = { createWorkflow } as unknown as StorageAdapter;
    const deps = {
      apiKeys: await makeKeyLookup(),
      storage,
      metricsPgClient: makeFakeSql({ role: "read" }),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountWorkflows]);

    const res = await app.request("/workflows", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        name: "Deploy",
        steps: [{ order: 1, action: "build", expectedDurationMs: 1000 }],
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual(FORBIDDEN_NOT_MEMBER);
    expect(createWorkflow).not.toHaveBeenCalled();
  });
});

describe("POST /skills — targetWorkspaceId", () => {
  it("omitting targetWorkspaceId → 201 in the key's own workspace", async () => {
    let captured: unknown;
    const storage = {
      createSkill: async (input: unknown) => {
        captured = input;
        return fakeSkill();
      },
    } as unknown as StorageAdapter;
    const deps = {
      apiKeys: await makeKeyLookup(),
      storage,
      metricsPgClient: makeFakeSql({}),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountSkills]);

    const res = await app.request("/skills", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ name: "sql-gen", promptTemplate: "Write SQL for {goal}" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(KEY_WS_ID);
    expect((captured as { workspaceId: string }).workspaceId).toBe(KEY_WS_ID);
  });

  it("write-role member supplies targetWorkspaceId → 201 in the target workspace", async () => {
    let captured: unknown;
    const storage = {
      createSkill: async (input: unknown) => {
        captured = input;
        return fakeSkill({ workspaceId: TARGET_WS_ID });
      },
    } as unknown as StorageAdapter;
    const deps = {
      apiKeys: await makeKeyLookup(),
      storage,
      metricsPgClient: makeFakeSql({ role: "write" }),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountSkills]);

    const res = await app.request("/skills", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        name: "sql-gen",
        promptTemplate: "Write SQL for {goal}",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(TARGET_WS_ID);
    expect((captured as { workspaceId: string }).workspaceId).toBe(TARGET_WS_ID);
  });

  it("non-user-bound key supplies targetWorkspaceId → 403 'requires a user-bound key', zero writes", async () => {
    const createSkill = vi.fn();
    const storage = { createSkill } as unknown as StorageAdapter;
    const deps = {
      apiKeys: await makeKeyLookup({ userId: null }),
      storage,
      metricsPgClient: makeFakeSql({ role: "write" }),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountSkills]);

    const res = await app.request("/skills", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        name: "sql-gen",
        promptTemplate: "Write SQL for {goal}",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({
      error: "forbidden",
      message: "targetWorkspaceId requires a user-bound key (mk_user_* or mk_live_* with user_id)",
    });
    expect(createSkill).not.toHaveBeenCalled();
  });
});

describe("POST /reminders — targetWorkspaceId", () => {
  it("omitting targetWorkspaceId → 201 in the key's own workspace; response body now carries workspaceId at all", async () => {
    let captured: unknown;
    const storage = {
      createReminder: async (input: unknown) => {
        captured = input;
        return fakeReminder();
      },
    } as unknown as StorageAdapter;
    const deps = {
      apiKeys: await makeKeyLookup(),
      storage,
      metricsPgClient: makeFakeSql({}),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountReminders]);

    const res = await app.request("/reminders", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ content: "Remind about the contract", condition: "Acme mentioned" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId?: string };
    // The field is NEW on this schema (design.md D4 exception) — assert it
    // exists at all, not just that its value is correct.
    expect(body).toHaveProperty("workspaceId");
    expect(body.workspaceId).toBe(KEY_WS_ID);
    expect((captured as { workspaceId: string }).workspaceId).toBe(KEY_WS_ID);
  });

  it("write-role member supplies targetWorkspaceId → 201 in the target workspace, body carries it", async () => {
    let captured: unknown;
    const storage = {
      createReminder: async (input: unknown) => {
        captured = input;
        return fakeReminder({ workspaceId: TARGET_WS_ID });
      },
    } as unknown as StorageAdapter;
    const deps = {
      apiKeys: await makeKeyLookup(),
      storage,
      metricsPgClient: makeFakeSql({ role: "owner" }),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountReminders]);

    const res = await app.request("/reminders", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        content: "Remind about the contract",
        condition: "Acme mentioned",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId?: string };
    expect(body).toHaveProperty("workspaceId");
    expect(body.workspaceId).toBe(TARGET_WS_ID);
    expect((captured as { workspaceId: string }).workspaceId).toBe(TARGET_WS_ID);
  });

  it("non-member supplies targetWorkspaceId → 403 forbidden, zero writes", async () => {
    const createReminder = vi.fn();
    const storage = { createReminder } as unknown as StorageAdapter;
    const deps = {
      apiKeys: await makeKeyLookup(),
      storage,
      metricsPgClient: makeFakeSql({ role: null }),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountReminders]);

    const res = await app.request("/reminders", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        content: "Remind about the contract",
        condition: "Acme mentioned",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual(FORBIDDEN_NOT_MEMBER);
    expect(createReminder).not.toHaveBeenCalled();
  });
});
