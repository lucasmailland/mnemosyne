/**
 * p46 PR5 — real-Postgres proof for write-provenance columns
 * (actor_id/user_id/actor_type) on `mnemo_relation` + `mnemo_hyperedge`.
 *
 * Covers what unit tests / test doubles (InMemoryStorageAdapter,
 * StorageAdapterContract) can't: a real round-trip through
 * `GraphRepository.createRelation`/`createHyperedge`
 * (packages/adapter-postgres/src/schema/relations.ts) plus the CHECK/FK
 * constraints added by migration 0025.
 *
 * flatten-legacy-dual-core Phase 7: this file originally ALSO exercised a
 * second, independent write path — `core/src/graph/relation.ts createRelation`,
 * reached via the legacy `createCore().createRelation(args)` bridge
 * (`packages/core/src/factory.ts`) — as a GATING check that
 * `adapter-postgres/src/schema/relations.ts` and `core/src/db/schema/
 * relation.ts` (two independent Drizzle table objects mapping the SAME
 * physical `mnemosyne.mnemo_relation` table) stayed in lockstep. That bridge
 * (`createCore`/`CoreContract`) is deleted this Phase together with
 * `factory.ts`; the `core/graph/relation.ts` write path it reached has zero
 * remaining callers anywhere in the repo (not even `core/src/index.ts`'s own
 * barrel re-exports it) — the GATING describe block that exercised it is
 * removed, not ported, since porting it would mean inventing a new call site
 * for a genuinely orphaned write path. The v3 describe blocks below (this
 * file's real subject) are unaffected.
 *
 * Prerequisites: Docker daemon running.
 * Run with: pnpm --filter @mnemo-ai/adapter-postgres test:integration
 * (Node 22 required — testcontainers/undici; see CLAUDE.md.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let databaseUrl: string;

function v3Adapter() {
  const { db, pgClient } = createDrizzleClient(databaseUrl);
  return new DrizzleStorageAdapter(db, pgClient);
}

/** Seed a real mnemo_tenant + mnemo_user row (mnemo_relation.user_id FK requires it). */
async function seedUser(a: DrizzleStorageAdapter, email: string): Promise<string> {
  const pg = (
    a as unknown as {
      pgClient: {
        unsafe: (q: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
      };
    }
  ).pgClient;
  const [tenant] = await pg.unsafe(
    `INSERT INTO mnemosyne.mnemo_tenant (name, kind, plan) VALUES ($1, 'personal', 'free') RETURNING id`,
    [email]
  );
  const [user] = await pg.unsafe(
    `INSERT INTO mnemosyne.mnemo_user (email, personal_tenant_id) VALUES ($1, $2) RETURNING id`,
    [email, tenant!["id"]]
  );
  return user!["id"] as string;
}

let wsCounter = 0;
function freshWorkspaceId(): string {
  wsCounter++;
  return `00000000-0000-0000-0000-${String(wsCounter).padStart(12, "0")}`;
}

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  await migrate({ databaseUrl, log: (msg) => process.stdout.write(`[migrate] ${msg}\n`) });
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

describe("mnemo_relation.actor_id/user_id/actor_type — v3 write path (GraphRepository)", () => {
  it("createRelation persists and reads back all 3 provenance fields", async () => {
    const a = v3Adapter();
    const ws = freshWorkspaceId();
    const userId = await seedUser(a, "v3-relation@example.com");

    const created = await a.createRelation({
      workspaceId: ws,
      sourceId: "fact_source_1",
      sourceType: "fact",
      targetId: "fact_target_1",
      targetType: "fact",
      verb: "related",
      actorId: "key:v3-test-key",
      userId,
      actorType: "agent",
    });

    expect(created.actorId).toBe("key:v3-test-key");
    expect(created.userId).toBe(userId);
    expect(created.actorType).toBe("agent");

    const [fetched] = await a.getRelations({
      workspaceId: ws,
      sourceId: "fact_source_1",
      targetId: "fact_target_1",
    });
    expect(fetched?.actorId).toBe("key:v3-test-key");
    expect(fetched?.userId).toBe(userId);
    expect(fetched?.actorType).toBe("agent");
  });

  it("createRelation omitting the 3 fields persists NULLs with unchanged behavior", async () => {
    const a = v3Adapter();
    const ws = freshWorkspaceId();

    const created = await a.createRelation({
      workspaceId: ws,
      sourceId: "fact_source_2",
      sourceType: "fact",
      targetId: "fact_target_2",
      targetType: "fact",
      verb: "related",
    });

    expect(created.actorId).toBeUndefined();
    expect(created.userId).toBeUndefined();
    expect(created.actorType).toBeUndefined();

    const [fetched] = await a.getRelations({
      workspaceId: ws,
      sourceId: "fact_source_2",
      targetId: "fact_target_2",
    });
    expect(fetched?.actorId).toBeUndefined();
    expect(fetched?.userId).toBeUndefined();
    expect(fetched?.actorType).toBeUndefined();
  });

  it("rejects an invalid actor_type via the CHECK constraint", async () => {
    const a = v3Adapter();
    const ws = freshWorkspaceId();

    await expect(
      a.createRelation({
        workspaceId: ws,
        sourceId: "fact_source_3",
        sourceType: "fact",
        targetId: "fact_target_3",
        targetType: "fact",
        verb: "related",
        // @ts-expect-error — deliberately invalid to prove the DB CHECK fires
        actorType: "not-a-real-actor-type",
      })
    ).rejects.toThrow(/actor_type/i);
  });

  it("sets user_id to NULL when the referenced user is deleted (FK ON DELETE SET NULL)", async () => {
    const a = v3Adapter();
    const ws = freshWorkspaceId();
    const userId = await seedUser(a, "v3-relation-fk@example.com");

    const created = await a.createRelation({
      workspaceId: ws,
      sourceId: "fact_source_4",
      sourceType: "fact",
      targetId: "fact_target_4",
      targetType: "fact",
      verb: "related",
      userId,
    });
    expect(created.userId).toBe(userId);

    const pg = (
      a as unknown as {
        pgClient: {
          unsafe: (q: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
        };
      }
    ).pgClient;
    await pg.unsafe(`DELETE FROM mnemosyne.mnemo_user WHERE id = $1`, [userId]);

    const [fetched] = await a.getRelations({
      workspaceId: ws,
      sourceId: "fact_source_4",
      targetId: "fact_target_4",
    });
    expect(fetched?.userId).toBeUndefined();
  });
});

describe("mnemo_hyperedge.actor_id/user_id/actor_type — v3 write path (GraphRepository)", () => {
  it("createHyperedge persists and reads back all 3 provenance fields", async () => {
    const a = v3Adapter();
    const ws = freshWorkspaceId();
    const userId = await seedUser(a, "v3-hyperedge@example.com");

    const created = await a.createHyperedge({
      workspaceId: ws,
      memberIds: ["h1", "h2", "h3"],
      actorId: "key:v3-hyperedge-key",
      userId,
      actorType: "system",
    });

    expect(created.actorId).toBe("key:v3-hyperedge-key");
    expect(created.userId).toBe(userId);
    expect(created.actorType).toBe("system");

    const fetched = await a.getHyperedge(created.id, ws);
    expect(fetched?.actorId).toBe("key:v3-hyperedge-key");
    expect(fetched?.userId).toBe(userId);
    expect(fetched?.actorType).toBe("system");
  });

  it("createHyperedge omitting the 3 fields persists NULLs with unchanged behavior", async () => {
    const a = v3Adapter();
    const ws = freshWorkspaceId();

    const created = await a.createHyperedge({
      workspaceId: ws,
      memberIds: ["h4", "h5", "h6"],
    });

    expect(created.actorId).toBeUndefined();
    expect(created.userId).toBeUndefined();
    expect(created.actorType).toBeUndefined();

    const fetched = await a.getHyperedge(created.id, ws);
    expect(fetched?.actorId).toBeUndefined();
    expect(fetched?.userId).toBeUndefined();
    expect(fetched?.actorType).toBeUndefined();
  });

  it("rejects an invalid actor_type via the CHECK constraint", async () => {
    const a = v3Adapter();
    const ws = freshWorkspaceId();

    await expect(
      a.createHyperedge({
        workspaceId: ws,
        memberIds: ["h7", "h8", "h9"],
        // @ts-expect-error — deliberately invalid to prove the DB CHECK fires
        actorType: "not-a-real-actor-type",
      })
    ).rejects.toThrow(/actor_type/i);
  });
});
