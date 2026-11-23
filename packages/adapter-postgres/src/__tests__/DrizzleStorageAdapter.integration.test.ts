/**
 * Contract integration test: DrizzleStorageAdapter vs. StorageAdapter port.
 *
 * Spins up a fresh pgvector:pg17 container via testcontainers, applies all
 * v3 migrations using the programmatic migrate() runner, then runs the same
 * runStorageAdapterContractTests() suite that validates InMemoryStorageAdapter.
 *
 * This ensures both adapters honour the same behavioural contract and that
 * the SQL schema matches the TypeScript port definitions.
 *
 * Prerequisites: Docker daemon running.
 * Run with:  pnpm --filter @mnemo-ai/adapter-postgres test:integration
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runStorageAdapterContractTests } from "@mnemo-ai/types/testing";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { DrizzleIdempotencyStore } from "../DrizzleIdempotencyStore.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let databaseUrl: string;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  // Enable vector extension and apply all v3 migrations
  await migrate({
    databaseUrl,
    log: (msg) => process.stdout.write(`[migrate] ${msg}\n`),
  });
}, 120_000);

// Every adapter and store in this file used to open its own connection pool
// and never close it. The contract suite builds one per test, so the file ran
// past Postgres' 100-connection limit and the later tests failed with
// "sorry, too many clients already". Adapters hold no state of their own, so
// they now share one pool, closed once at the end.
let sharedClient: ReturnType<typeof createDrizzleClient> | undefined;
function openClient(): ReturnType<typeof createDrizzleClient> {
  sharedClient ??= createDrizzleClient(databaseUrl);
  return sharedClient;
}

afterAll(async () => {
  await sharedClient?.pgClient.end({ timeout: 5 }).catch(() => undefined);
  await container?.stop();
});

// Run the shared contract suite against a real DrizzleStorageAdapter.
// Each test gets a fresh adapter instance; workspace isolation is achieved
// by using different workspaceId values per test (RLS enforces this).
runStorageAdapterContractTests(() => {
  const { db, pgClient } = openClient();
  return new DrizzleStorageAdapter(db, pgClient);
});

describe("DrizzleIdempotencyStore — concurrent-duplicate guard (P0-6)", () => {
  const WS = "00000000-0000-0000-0000-0000000000d6";
  function store() {
    const { db } = openClient();
    return new DrizzleIdempotencyStore(db);
  }

  it("first begin() is 'new'; a second begin() with the same key+hash is 'in_flight' (regression: was always 'new')", async () => {
    const s = store();
    const key = "idem-seq-1";
    expect((await s.begin(WS, key, "hash-A")).state).toBe("new");
    expect((await s.begin(WS, key, "hash-A")).state).toBe("in_flight");
  });

  it("after complete(), begin() replays the stored response verbatim", async () => {
    const s = store();
    const key = "idem-seq-2";
    expect((await s.begin(WS, key, "hash-B")).state).toBe("new");
    await s.complete(WS, key, 201, JSON.stringify({ id: "x" }));
    const replay = await s.begin(WS, key, "hash-B");
    expect(replay.state).toBe("replay");
    if (replay.state === "replay") {
      expect(replay.responseCode).toBe(201);
      expect(replay.responseBody).toBe(JSON.stringify({ id: "x" }));
    }
  });

  it("same key with a different request hash is 'mismatch'", async () => {
    const s = store();
    const key = "idem-seq-3";
    expect((await s.begin(WS, key, "hash-X")).state).toBe("new");
    expect((await s.begin(WS, key, "hash-Y")).state).toBe("mismatch");
  });

  it("two concurrent begin() calls on a fresh key yield exactly one 'new' and one 'in_flight'", async () => {
    const s = store();
    const key = "idem-concurrent";
    const [a, b] = await Promise.all([s.begin(WS, key, "hash-C"), s.begin(WS, key, "hash-C")]);
    expect([a.state, b.state].sort()).toEqual(["in_flight", "new"]);
  });
});

describe("post-migration column defaults", () => {
  it("worth defaults are 2.0 and sensitivity defaults to 'internal'", async () => {
    const sql = postgres(databaseUrl);
    try {
      const rows = await sql<Array<{ column_name: string; column_default: string | null }>>`
        SELECT column_name, column_default
        FROM information_schema.columns
        WHERE table_schema = 'mnemosyne'
          AND table_name = 'mnemo_fact'
          AND column_name IN ('worth_alpha', 'worth_beta', 'sensitivity')
      `;
      const byName = Object.fromEntries(rows.map((r) => [r.column_name, r.column_default]));
      expect(byName["worth_alpha"]).toContain("2.0");
      expect(byName["worth_beta"]).toContain("2.0");
      expect(byName["sensitivity"]).toContain("internal");
    } finally {
      await sql.end();
    }
  });

  it("0053 added worth_alpha/worth_beta to the procedural + reasoning tables", async () => {
    const sql = postgres(databaseUrl);
    try {
      for (const table of ["mnemo_strategy", "mnemo_reasoning", "mnemo_workflow", "mnemo_skill"]) {
        const rows = await sql<Array<{ column_name: string }>>`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'mnemosyne'
            AND table_name = ${table}
            AND column_name IN ('worth_alpha', 'worth_beta')
        `;
        expect(rows.map((r) => r.column_name).sort()).toEqual(["worth_alpha", "worth_beta"]);
      }
    } finally {
      await sql.end();
    }
  });
});

describe("decayKind — §25.2 procedural + reasoning Beta relaxation", () => {
  function adapter() {
    const { db, pgClient } = openClient();
    return new DrizzleStorageAdapter(db, pgClient);
  }

  // Beta(α,β) relaxed toward (1,1) over Δd days at half-life H:
  //   α' = 1 + (α-1)·2^(-Δd/H).  At Δd=H the excess over the prior halves.
  it("relaxes reasoning evidence toward the (1,1) prior at H=90d", async () => {
    const WS = "00000000-0000-0000-0000-0000000000a1";
    const id = "reasoning-decay-1";
    const sql = postgres(databaseUrl);
    try {
      await sql`SELECT mnemosyne.mnemo_set_workspace(${WS}::uuid)`;
      // Seed α=11, β=1 (10 net successes), last used exactly one half-life (90d) ago.
      await sql`
        INSERT INTO mnemosyne.mnemo_reasoning
          (id, workspace_id, question, conclusion, success_count, failure_count,
           worth_alpha, worth_beta, status, last_used_at, created_at, updated_at)
        VALUES
          (${id}, ${WS}, 'q', 'c', 10, 0, 11.0, 1.0, 'active',
           NOW() - INTERVAL '90 days', NOW() - INTERVAL '90 days', NOW() - INTERVAL '90 days')
      `;

      const n = await adapter().decayKind(WS, "reasoning", 90);
      expect(n).toBeGreaterThanOrEqual(1);

      await sql`SELECT mnemosyne.mnemo_set_workspace(${WS}::uuid)`;
      const [row] = await sql<Array<{ worth_alpha: string; worth_beta: string }>>`
        SELECT worth_alpha, worth_beta FROM mnemosyne.mnemo_reasoning WHERE id = ${id}
      `;
      // α excess (10) halves → ~6; β stays at the prior (1).
      expect(parseFloat(row!.worth_alpha)).toBeCloseTo(6, 0);
      expect(parseFloat(row!.worth_beta)).toBeCloseTo(1, 1);
    } finally {
      await sql.end();
    }
  });

  it("relaxes procedural (strategy) evidence at H=173d and never drops below the prior", async () => {
    const WS = "00000000-0000-0000-0000-0000000000a2";
    const id = "strategy-decay-1";
    const archivedSkillId = "archived-skill-decay-1";
    const sql = postgres(databaseUrl);
    try {
      await sql`SELECT mnemosyne.mnemo_set_workspace(${WS}::uuid)`;
      // α=5, β=3, updated one half-life (173d) ago.
      await sql`
        INSERT INTO mnemosyne.mnemo_strategy
          (id, workspace_id, trigger, action, success_count, failure_count,
           worth_alpha, worth_beta, status, created_at, updated_at)
        VALUES
          (${id}, ${WS}, 't', 'a', 4, 2, 5.0, 3.0, 'active',
           NOW() - INTERVAL '173 days', NOW() - INTERVAL '173 days')
      `;
      await sql`
        INSERT INTO mnemosyne.mnemo_skill
          (id, workspace_id, name, prompt_template, worth_alpha, worth_beta,
           valid_to, created_at, updated_at)
        VALUES
          (${archivedSkillId}, ${WS}, 'archived', 'prompt', 5.0, 3.0,
           NOW() - INTERVAL '1 day', NOW() - INTERVAL '173 days', NOW() - INTERVAL '173 days')
      `;

      const n = await adapter().decayKind(WS, "procedural", 173);
      expect(n).toBeGreaterThanOrEqual(1);

      await sql`SELECT mnemosyne.mnemo_set_workspace(${WS}::uuid)`;
      const [row] = await sql<Array<{ worth_alpha: string; worth_beta: string }>>`
        SELECT worth_alpha, worth_beta FROM mnemosyne.mnemo_strategy WHERE id = ${id}
      `;
      const [archivedSkill] = await sql<Array<{ worth_alpha: string; worth_beta: string }>>`
        SELECT worth_alpha, worth_beta FROM mnemosyne.mnemo_skill WHERE id = ${archivedSkillId}
      `;
      // α excess (4) halves → ~3; β excess (2) halves → ~2. Both stay > prior (1).
      expect(parseFloat(row!.worth_alpha)).toBeCloseTo(3, 0);
      expect(parseFloat(row!.worth_beta)).toBeCloseTo(2, 0);
      expect(parseFloat(row!.worth_alpha)).toBeGreaterThanOrEqual(1);
      expect(parseFloat(row!.worth_beta)).toBeGreaterThanOrEqual(1);
      expect(parseFloat(archivedSkill!.worth_alpha)).toBe(5);
      expect(parseFloat(archivedSkill!.worth_beta)).toBe(3);
    } finally {
      await sql.end();
    }
  });

  it("reasoning decay leaves a fresh (Δd≈0) row's evidence unchanged", async () => {
    const WS = "00000000-0000-0000-0000-0000000000a3";
    const id = "reasoning-fresh-1";
    const sql = postgres(databaseUrl);
    try {
      await sql`SELECT mnemosyne.mnemo_set_workspace(${WS}::uuid)`;
      await sql`
        INSERT INTO mnemosyne.mnemo_reasoning
          (id, workspace_id, question, conclusion, success_count, failure_count,
           worth_alpha, worth_beta, status, last_used_at, created_at, updated_at)
        VALUES
          (${id}, ${WS}, 'q', 'c', 9, 0, 10.0, 1.0, 'active', NOW(), NOW(), NOW())
      `;

      await adapter().decayKind(WS, "reasoning", 90);

      await sql`SELECT mnemosyne.mnemo_set_workspace(${WS}::uuid)`;
      const [row] = await sql<Array<{ worth_alpha: string; worth_beta: string }>>`
        SELECT worth_alpha, worth_beta FROM mnemosyne.mnemo_reasoning WHERE id = ${id}
      `;
      expect(parseFloat(row!.worth_alpha)).toBeCloseTo(10, 1);
      expect(parseFloat(row!.worth_beta)).toBeCloseTo(1, 2);
    } finally {
      await sql.end();
    }
  });

  it("entity class and episodic class are no-ops (Event is immutable, §10)", async () => {
    const WS = "00000000-0000-0000-0000-0000000000a4";
    const a = adapter();
    expect(await a.decayKind(WS, "entity", 0)).toBe(0);
    expect(await a.decayKind(WS, "episodic", 35)).toBe(0);
  });
});

describe("C1.5 — strategy relatedFacts + attribution round-trip", () => {
  function adapter() {
    const { db, pgClient } = openClient();
    return new DrizzleStorageAdapter(db, pgClient);
  }

  it("persists non-default relatedFacts and attribution through the DB round-trip", async () => {
    const WS = "00000000-0000-0000-0000-000000000c15";
    const a = adapter();

    const created = await a.createStrategy({
      workspaceId: WS,
      trigger: "user asks about preferences",
      action: "recall stored preference",
      relatedFacts: ["fact-1", "fact-2"],
      attribution: "user_stated",
    });

    // createStrategy must echo back the caller-supplied values (not DB defaults).
    expect(created.relatedFacts).toEqual(["fact-1", "fact-2"]);
    expect(created.attribution).toBe("user_stated");
    expect(created.memoryType).toBe("procedural");

    // Read back from DB to confirm both columns were actually written.
    const fetched = await a.getStrategy(created.id, WS);
    expect(fetched).not.toBeNull();
    expect(fetched!.relatedFacts).toEqual(["fact-1", "fact-2"]);
    expect(fetched!.attribution).toBe("user_stated");
  });

  it("updateStrategy can patch relatedFacts and attribution post-creation", async () => {
    const WS = "00000000-0000-0000-0000-000000000c15";
    const a = adapter();

    const created = await a.createStrategy({
      workspaceId: WS,
      trigger: "trigger for update test",
      action: "action for update test",
      relatedFacts: [],
      attribution: "inferred",
    });

    const updated = await a.updateStrategy(created.id, {
      workspaceId: WS,
      relatedFacts: ["fact-patched"],
      attribution: "objective_fact",
    });

    expect(updated.relatedFacts).toEqual(["fact-patched"]);
    expect(updated.attribution).toBe("objective_fact");

    const fetched = await a.getStrategy(created.id, WS);
    expect(fetched!.relatedFacts).toEqual(["fact-patched"]);
    expect(fetched!.attribution).toBe("objective_fact");
  });
});

describe("bitemporal validAt filters — raw-Date driver-encoding regression (DATEBUG-2)", () => {
  function adapter() {
    const { db, pgClient } = openClient();
    return new DrizzleStorageAdapter(db, pgClient);
  }

  it("queryTasks({ validAt }) does not throw and excludes tasks archived before that instant", async () => {
    const WS = "00000000-0000-0000-0000-0000000000db";
    const a = adapter();
    const live = await a.createTask({
      workspaceId: WS,
      title: "still open",
      assignedTo: "agent-1",
    });
    const closed = await a.createTask({
      workspaceId: WS,
      title: "gets archived",
      assignedTo: "agent-1",
    });
    await a.archiveTask(closed.id, WS);
    const asOf = new Date(Date.now() + 60_000); // determinism-ok: relative seed timestamp, not an assertion value
    const page = await a.queryTasks({ workspaceId: WS, validAt: asOf, limit: 100 });
    const ids = page.items.map((t) => t.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(closed.id);
  });

  it("queryTasks({ validAt }) still returns a task at an instant before it was archived", async () => {
    const WS = "00000000-0000-0000-0000-0000000000dc";
    const a = adapter();
    const closed = await a.createTask({
      workspaceId: WS,
      title: "time travel",
      assignedTo: "agent-1",
    });
    // Archived well after it began: one millisecond before the close is still inside the
    // interval (back to back, both stamps can share a millisecond).
    await new Promise((r) => setTimeout(r, 20));
    await a.archiveTask(closed.id, WS);
    const archived = await a.getTask(closed.id, WS);
    const justBefore = new Date(archived!.validTo!.getTime() - 1);
    const page = await a.queryTasks({ workspaceId: WS, validAt: justBefore, limit: 100 });
    expect(page.items.map((t) => t.id)).toContain(closed.id);
  });

  it("queryWorkflows / queryDecisions / queryEntities / queryEpisodes / queryFacts accept a Date validAt without throwing", async () => {
    const WS = "00000000-0000-0000-0000-0000000000dd";
    const a = adapter();
    const asOf = new Date(); // determinism-ok: relative seed timestamp, not an assertion value
    await expect(a.queryWorkflows({ workspaceId: WS, validAt: asOf })).resolves.toBeDefined();
    await expect(a.queryDecisions({ workspaceId: WS, validAt: asOf })).resolves.toBeDefined();
    await expect(a.queryEntities({ workspaceId: WS, validAt: asOf })).resolves.toBeDefined();
    await expect(a.queryEpisodes({ workspaceId: WS, validAt: asOf })).resolves.toBeDefined();
    await expect(a.queryFacts({ workspaceId: WS, validAt: asOf })).resolves.toBeDefined();
  });
});

describe("B7 — archiveTask is terminal-aware against real Postgres", () => {
  function adapter() {
    const { db, pgClient } = openClient();
    return new DrizzleStorageAdapter(db, pgClient);
  }

  it("archiving a completed task preserves status:'completed' and sets validTo", async () => {
    const WS = "00000000-0000-0000-0000-0000000000de";
    const a = adapter();
    const created = await a.createTask({
      workspaceId: WS,
      title: "already completed",
      assignedTo: "agent-1",
    });
    await a.updateTask(created.id, { workspaceId: WS, status: "completed" });

    await a.archiveTask(created.id, WS);

    const archived = await a.getTask(created.id, WS);
    expect(archived!.status).toBe("completed");
    expect(archived!.validTo).toBeInstanceOf(Date);
  });

  it("archiving a non-terminal task still sets status:'cancelled'", async () => {
    const WS = "00000000-0000-0000-0000-0000000000df";
    const a = adapter();
    const created = await a.createTask({
      workspaceId: WS,
      title: "still pending",
      assignedTo: "agent-1",
    });

    await a.archiveTask(created.id, WS);

    const archived = await a.getTask(created.id, WS);
    expect(archived!.status).toBe("cancelled");
    expect(archived!.validTo).toBeInstanceOf(Date);
  });
});
