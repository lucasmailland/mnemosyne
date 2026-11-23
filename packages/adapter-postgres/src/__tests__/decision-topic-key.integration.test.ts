/**
 * Integration test: DrizzleStorageAdapter.mergeDecisionByTopicKey (slice a).
 *
 * Requires Docker + Node >=22 — see CLAUDE.md "Node version" note and
 * fact-lsh.integration.test.ts for the same testcontainers pattern this
 * file mirrors.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let adapter: DrizzleStorageAdapter;
let rawSql: postgres.Sql;

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
  const databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  await migrate({
    databaseUrl,
    log: (msg) => process.stdout.write(`[migrate] ${msg}\n`),
  });

  const { db, pgClient } = createDrizzleClient(databaseUrl);
  adapter = new DrizzleStorageAdapter(db, pgClient);
  rawSql = postgres(databaseUrl, { connection: { search_path: "mnemosyne,public" } });
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await rawSql?.end();
  await container?.stop();
});

describe("DrizzleStorageAdapter.mergeDecisionByTopicKey", () => {
  const WS = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

  it("matches an existing active decision case/whitespace-insensitively and bumps revision", async () => {
    const created = await adapter.createDecision({
      workspaceId: WS,
      title: "Original title",
      body: "Original body",
      kind: "decision",
      topicKey: "Auth-Strategy",
    });

    const merged = await adapter.mergeDecisionByTopicKey({
      workspaceId: WS,
      topicKey: " auth-strategy ",
      title: "Updated title",
      body: "Updated body",
      kind: "architecture",
    });

    expect(merged).not.toBeNull();
    expect(merged!.id).toBe(created.id);
    expect(merged!.title).toBe("Updated title");
    expect(merged!.body).toBe("Updated body");
    expect(merged!.kind).toBe("architecture");
    expect(merged!.revisionCount).toBe(created.revisionCount + 1);

    const rows = await rawSql<Array<{ count: string }>>`
      SELECT COUNT(*)::int AS count FROM mnemosyne.mnemo_decision
      WHERE workspace_id = ${WS} AND status = 'active' AND lower(btrim(topic_key)) = 'auth-strategy'
    `;
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it("returns null when no active row exists for the topicKey", async () => {
    const result = await adapter.mergeDecisionByTopicKey({
      workspaceId: WS,
      topicKey: "no-such-topic",
      title: "Title",
      body: "Body",
      kind: "decision",
    });
    expect(result).toBeNull();
  });

  it("never raises 23505 on repeated writes with the same topicKey — never a duplicate row", async () => {
    const topicKey = "repeat-key";
    const first = await adapter.createDecision({
      workspaceId: WS,
      title: "First",
      body: "First body",
      kind: "decision",
      topicKey,
    });

    for (let i = 0; i < 5; i++) {
      const merged = await adapter.mergeDecisionByTopicKey({
        workspaceId: WS,
        topicKey,
        title: `Revision ${i}`,
        body: `Body ${i}`,
        kind: "decision",
      });
      expect(merged).not.toBeNull();
      expect(merged!.id).toBe(first.id);
    }

    const rows = await rawSql<Array<{ count: string }>>`
      SELECT COUNT(*)::int AS count FROM mnemosyne.mnemo_decision
      WHERE workspace_id = ${WS} AND lower(btrim(topic_key)) = ${topicKey}
    `;
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it("enqueues a vector_upsert outbox row on merge, matching createDecision's payload shape", async () => {
    const topicKey = "outbox-key";
    const created = await adapter.createDecision({
      workspaceId: WS,
      title: "Outbox original",
      body: "Outbox body",
      kind: "decision",
      topicKey,
    });

    const before = await rawSql<Array<{ count: string }>>`
      SELECT COUNT(*)::int AS count FROM mnemosyne.mnemo_outbox
      WHERE workspace_id = ${WS} AND event_type = 'vector_upsert'
        AND payload->>'id' = ${created.id}
    `;
    const baselineCount = Number(before[0]!.count);

    await adapter.mergeDecisionByTopicKey({
      workspaceId: WS,
      topicKey,
      title: "Outbox merged title",
      body: "Outbox merged body",
      kind: "decision",
    });

    const after = await rawSql<Array<{ count: string; payload: unknown }>>`
      SELECT COUNT(*)::int AS count FROM mnemosyne.mnemo_outbox
      WHERE workspace_id = ${WS} AND event_type = 'vector_upsert'
        AND payload->>'id' = ${created.id}
    `;
    expect(Number(after[0]!.count)).toBe(baselineCount + 1);

    const latest = await rawSql<Array<{ payload: { kind?: string; text?: string } }>>`
      SELECT payload FROM mnemosyne.mnemo_outbox
      WHERE workspace_id = ${WS} AND event_type = 'vector_upsert'
        AND payload->>'id' = ${created.id}
      ORDER BY created_at DESC LIMIT 1
    `;
    expect(latest[0]!.payload.kind).toBe("decision");
    expect(latest[0]!.payload.text).toBe("Outbox merged title Outbox merged body");
  });
});
