/**
 * FULL-STACK HTTP contract test for the `memory_workflow` MCP tool's server-side
 * surface: GET /workflows, POST /workflows, GET /workflows/:id
 * (packages/server/src/routes/workflows.ts), which packages/mcp/src/tools/workflow.ts
 * calls via MnemosyneClient.createWorkflow()/getWorkflow()/listWorkflows().
 *
 * Harness mirrors conflicts.integration.test.ts / purge-facts-hard-delete.integration.test.ts:
 * a throwaway pgvector/pgvector:pg17 testcontainer, real migrations (core +
 * adapter-postgres v3), and — per this repo's DB/RLS verification rule — the whole
 * app runs through a real NOSUPERUSER NOBYPASSRLS application role (not the bootstrap
 * superuser), exactly like production's `mnemo_app` role provisioned by
 * docker/scripts/provision-app-role.mjs. Hermetic & CI-safe: every run gets a fresh
 * DB. Requires Docker.
 *
 * Verifies, per the tool-promise audit
 * (docs/archive/openspec/tool-promise-remediation/tools/memory_workflow.md):
 *
 *   1. Step order survives a create -> get round trip EXACTLY, including when the
 *      "order" field values are NOT monotonically increasing in array position
 *      (catches any accidental re-sort-by-order-field, and confirms the `steps`
 *      column is stored/retrieved as an ordered JSON array, not an unordered
 *      representation that could silently reshuffle).
 *   2. action="list" returns ONLY workflows — tasks and skills seeded in the very
 *      same workspace must never leak through a shared underlying query.
 *   3. mnemo_workflow / mnemo_task / mnemo_skill are genuinely separate storage
 *      tables (not the same primitive aliased under three tool names) — each
 *      created id lives in exactly one of the three tables at the SQL level.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import bcrypt from "bcrypt";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const WS = "d00fee00-1234-4abc-9def-0123456789ab";
const PLAINTEXT_KEY = "mns_live_workflowstestkey000001";

const PG_USER = "mnemo_super";
const PG_PASSWORD = "mnemo_super";
const PG_DB = "mnemo";
const APP_ROLE = "workflows_app";
const APP_PASSWORD = "workflows_app_pass";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${PLAINTEXT_KEY}`,
    "content-type": "application/json",
    ...headers,
  };
}

interface WorkflowStepWire {
  order: number;
  action: string;
  condition?: string;
  expectedDurationMs: number;
  tools?: string[];
}

interface WorkflowBody {
  id: string;
  name: string;
  steps: WorkflowStepWire[];
  [key: string]: unknown;
}

async function createWorkflow(name: string, steps: WorkflowStepWire[]): Promise<WorkflowBody> {
  const res = await app.request("/workflows", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ name, steps }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as WorkflowBody;
}

async function getWorkflow(id: string): Promise<{ status: number; body?: WorkflowBody }> {
  const res = await app.request(`/workflows/${id}`, { headers: authed() });
  if (res.status !== 200) return { status: res.status };
  return { status: res.status, body: (await res.json()) as WorkflowBody };
}

async function listWorkflows(): Promise<{ items: WorkflowBody[]; total: number }> {
  const res = await app.request("/workflows?limit=200", { headers: authed() });
  expect(res.status).toBe(200);
  return (await res.json()) as { items: WorkflowBody[]; total: number };
}

async function createTask(title: string): Promise<{ id: string }> {
  const res = await app.request("/tasks", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ title, assignedTo: "test-agent" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

async function createSkill(name: string): Promise<{ id: string }> {
  const res = await app.request("/skills", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ name, promptTemplate: "Do the {{thing}}." }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  const bootstrap = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await bootstrap.end();
  }

  const { stdout: coreOut } = await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", superUrl],
    { timeout: 120_000 }
  );
  expect(coreOut).toContain("done");
  const { stdout: v3Out } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: superUrl },
  });
  expect(v3Out).toContain("Done. Applied:");

  admin = postgres(superUrl, { max: 3, onnotice: () => void 0 });

  // Real non-superuser, non-BYPASSRLS application role — the hard rule for any
  // DB/RLS-touching claim in this repo (docs/archive/audits/README.md): mirrors
  // conflicts.integration.test.ts / purge-facts-hard-delete.integration.test.ts /
  // session-lifecycle-rls.integration.test.ts, and production's mnemo_app role
  // (docker/scripts/provision-app-role.mjs).
  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);

  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${"key_workflows_test_01"}, ${WS}, ${keyHash}, ${"workflows-integration-test"},
            ${"workflows-integration-test"},
            ARRAY['memory:read', 'memory:write', 'memory:task']::text[])
  `;

  const appUrl = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${PG_DB}`;
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  apiKeyLookupClose = apiKeys.close;

  const [adapterPgMod, adapterVectorMod, v3CoreMod] = await Promise.all([
    import("@mnemo-ai/adapter-postgres"),
    import("@mnemo-ai/adapter-vector"),
    import("@mnemo-ai/core/cognitive"),
  ]);
  const DIMS = 1536;
  const fakeEmbed: import("@mnemo-ai/types").EmbedAdapter = {
    id: "fake-embed",
    model: "fake-model",
    dimensions: DIMS,
    async embed(texts) {
      return texts.map(() => new Float32Array(DIMS));
    },
    async embedSingle() {
      return new Float32Array(DIMS);
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };
  const { db: v3Db, pgClient: v3Pg } = adapterPgMod.createDrizzleClient(appUrl);
  const v3Storage = new adapterPgMod.DrizzleStorageAdapter(v3Db, v3Pg, undefined);
  const v3Vector = new adapterVectorMod.PgVectorAdapter({ connectionString: appUrl });
  const noopLogger: import("@mnemo-ai/types").Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: function () {
      return this;
    },
  };
  const noopTelemetry = {
    startSpan: () => ({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
  const outboxAdapter: import("@mnemo-ai/types").OutboxAdapter = {
    async append(e) {
      return v3Storage.appendOutbox(e);
    },
    async claimBatch(n) {
      return v3Storage.claimOutbox(n);
    },
    async markProcessed(ids) {
      return v3Storage.markOutboxProcessed(ids);
    },
    async markFailed(id, err) {
      return v3Storage.markOutboxFailed(id, err);
    },
    async getStats() {
      return { pending: 0, failed: 0, oldestPendingMs: 0 };
    },
  };
  const cognitive = v3CoreMod.createCore({
    storage: v3Storage,
    vector: v3Vector,
    embed: fakeEmbed,
    outbox: outboxAdapter,
    logger: noopLogger,
    telemetry: noopTelemetry,
  });

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps: ServerDeps = {
    apiKeys,
    cognitive,
    storage: v3Storage,
    llm: undefined,
    embedModel: "fake-model",
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  };
  app = createApp({ deps, version: "workflows-contract-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("memory_workflow contract — step ordering", () => {
  it("preserves exact step order across create -> get, even with non-monotonic `order` field values", async () => {
    // Deliberately NOT sorted by the `order` field (2, 0, 1) so that if get()
    // (or the storage round-trip) silently re-sorted by the order field, this
    // test would catch it. The array POSITION must be the source of truth.
    const steps: WorkflowStepWire[] = [
      { order: 2, action: "step-C: deploy to prod", expectedDurationMs: 300 },
      { order: 0, action: "step-A: run tests", expectedDurationMs: 100 },
      { order: 1, action: "step-B: build artifact", expectedDurationMs: 200 },
    ];
    const created = await createWorkflow("Non-monotonic order round-trip", steps);
    expect(created.steps.map((s) => s.action)).toEqual([
      "step-C: deploy to prod",
      "step-A: run tests",
      "step-B: build artifact",
    ]);

    const fetched = await getWorkflow(created.id);
    expect(fetched.status).toBe(200);
    const gotSteps = fetched.body?.steps ?? [];

    // Exact positional round-trip: same order-field values, same action text,
    // in the same array positions as submitted — NOT re-sorted ascending by
    // the `order` field (which would yield A, B, C).
    expect(gotSteps.map((s) => s.action)).toEqual([
      "step-C: deploy to prod",
      "step-A: run tests",
      "step-B: build artifact",
    ]);
    expect(gotSteps.map((s) => s.order)).toEqual([2, 0, 1]);
    expect(gotSteps.map((s) => s.expectedDurationMs)).toEqual([300, 100, 200]);
  });

  it("preserves order for a simple ascending A, B, C workflow", async () => {
    const steps: WorkflowStepWire[] = [
      { order: 0, action: "A", expectedDurationMs: 0 },
      { order: 1, action: "B", expectedDurationMs: 0 },
      { order: 2, action: "C", expectedDurationMs: 0 },
    ];
    const created = await createWorkflow("Ascending A-B-C", steps);
    const fetched = await getWorkflow(created.id);
    expect(fetched.status).toBe(200);
    expect(fetched.body?.steps.map((s) => s.action)).toEqual(["A", "B", "C"]);
  });
});

describe("memory_workflow contract — list does not leak tasks or skills", () => {
  it("action='list' returns only workflows when tasks and skills exist in the same workspace", async () => {
    const workflow = await createWorkflow("List-isolation workflow", [
      { order: 0, action: "only step", expectedDurationMs: 0 },
    ]);
    const task = await createTask("List-isolation task");
    const skill = await createSkill("List-isolation skill");

    const { items } = await listWorkflows();
    const ids = items.map((w) => w.id);

    expect(ids).toContain(workflow.id);
    expect(ids).not.toContain(task.id);
    expect(ids).not.toContain(skill.id);

    // No task- or skill-only fields leak into workflow list items either
    // (would indicate a shared underlying query/mapper).
    for (const item of items) {
      expect(item).not.toHaveProperty("assignedTo"); // task-only field
      expect(item).not.toHaveProperty("promptTemplate"); // skill-only field
    }
  });

  it("mnemo_workflow / mnemo_task / mnemo_skill are genuinely separate tables at the SQL level", async () => {
    const workflow = await createWorkflow("Separate-storage workflow", [
      { order: 0, action: "only step", expectedDurationMs: 0 },
    ]);
    const task = await createTask("Separate-storage task");
    const skill = await createSkill("Separate-storage skill");

    const [inWorkflowTable, inTaskTable, inSkillTable] = await Promise.all([
      admin<
        Array<{ id: string }>
      >`SELECT id FROM mnemosyne.mnemo_workflow WHERE id = ${workflow.id}`,
      admin<Array<{ id: string }>>`SELECT id FROM mnemosyne.mnemo_task WHERE id = ${task.id}`,
      admin<Array<{ id: string }>>`SELECT id FROM mnemosyne.mnemo_skill WHERE id = ${skill.id}`,
    ]);
    expect(inWorkflowTable).toHaveLength(1);
    expect(inTaskTable).toHaveLength(1);
    expect(inSkillTable).toHaveLength(1);

    // Cross-checks: the workflow's id must NOT appear in mnemo_task/mnemo_skill,
    // and the task/skill ids must NOT appear in mnemo_workflow.
    const [workflowIdInTask, workflowIdInSkill, taskIdInWorkflow, skillIdInWorkflow] =
      await Promise.all([
        admin<Array<{ id: string }>>`SELECT id FROM mnemosyne.mnemo_task WHERE id = ${workflow.id}`,
        admin<
          Array<{ id: string }>
        >`SELECT id FROM mnemosyne.mnemo_skill WHERE id = ${workflow.id}`,
        admin<Array<{ id: string }>>`SELECT id FROM mnemosyne.mnemo_workflow WHERE id = ${task.id}`,
        admin<
          Array<{ id: string }>
        >`SELECT id FROM mnemosyne.mnemo_workflow WHERE id = ${skill.id}`,
      ]);
    expect(workflowIdInTask).toHaveLength(0);
    expect(workflowIdInSkill).toHaveLength(0);
    expect(taskIdInWorkflow).toHaveLength(0);
    expect(skillIdInWorkflow).toHaveLength(0);
  });
});
