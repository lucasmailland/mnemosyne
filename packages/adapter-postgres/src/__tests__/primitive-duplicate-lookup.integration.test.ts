/**
 * PRIM-18 (dedup part) — real-Postgres proof for the exact-repeat lookups that
 * remember() runs before inserting a decision or a strategy.
 *
 * Runs as a non-superuser, non-BYPASSRLS role, like production's `mnemo_app`:
 * the lookup opens its own transaction and sets the workspace GUC, and a row
 * in another workspace must stay invisible.
 *
 * Prerequisites: Docker daemon running. Node 22 (testcontainers/undici).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";

import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_USER = "dedup_app";
const APP_PASS = "dedup_app_pass";

const WS_A = "aaaaaaaa-3333-4aaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-4444-4bbb-bbbb-bbbbbbbbbbbb";

let container: StartedTestContainer;
let superSql: ReturnType<typeof postgres>;
let appClient: ReturnType<typeof createDrizzleClient>;
let adapter: DrizzleStorageAdapter;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASS, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://${PG_USER}:${PG_PASS}@${host}:${port}/${PG_DB}`;
  const appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG_DB}`;

  await migrate({ databaseUrl: superUrl, log: () => void 0 });

  superSql = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  await superSql.unsafe(`
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
  `);

  appClient = createDrizzleClient(appUrl);
  adapter = new DrizzleStorageAdapter(appClient.db, appClient.pgClient);
}, 120_000);

afterAll(async () => {
  await appClient?.pgClient.end().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

async function outboxPayload(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await superSql<Array<{ payload: Record<string, unknown> }>>`
    SELECT payload FROM mnemosyne.mnemo_outbox
    WHERE event_type = 'vector_upsert' AND payload->>'id' = ${id}
  `;
  return rows[0]?.payload;
}

/** Fields that legitimately differ between two inserts of different bodies. */
function comparable<T extends object>(row: T): Partial<T> {
  const {
    id: _id,
    createdAt: _c,
    updatedAt: _u,
    validFrom: _v,
    body: _b,
    action: _a,
    normalizedHash: _h,
    ...rest
  } = row as Record<string, unknown>;
  return rest as Partial<T>;
}

describe("createDecisionUnlessDuplicate (real Postgres, RLS)", () => {
  it("returns the identical active decision and inserts for anything that differs", async () => {
    const body = `We use PostgreSQL 17 for ledger-api (${crypto.randomUUID()}).`;
    const same = {
      workspaceId: WS_A,
      kind: "decision" as const,
      title: "database",
      body,
      scopeOwner: `workspace:${WS_A}`,
    };
    const existing = await adapter.createDecision(same);

    const repeat = await adapter.createDecisionUnlessDuplicate(same);
    expect(repeat).toMatchObject({ reused: true, decision: { id: existing.id } });

    for (const differs of [
      { ...same, body: `${body} v2` },
      { ...same, kind: "policy" as const },
      { ...same, sensitivity: "restricted" as const },
      { ...same, scopeOwner: "user:someone" },
      { ...same, scopeRef: "proj-x" },
      { ...same, workspaceId: WS_B, scopeOwner: `workspace:${WS_B}` },
    ]) {
      const res = await adapter.createDecisionUnlessDuplicate(differs);
      expect(res.reused).toBe(false);
      expect(res.decision.id).not.toBe(existing.id);
    }

    await adapter.archiveDecision(existing.id, WS_A);
    const afterArchive = await adapter.createDecisionUnlessDuplicate(same);
    expect(afterArchive.reused).toBe(false);
  });

  it("eight identical concurrent writes leave one decision", async () => {
    const body = `Concurrent decision (${crypto.randomUUID()}).`;
    const input = {
      workspaceId: WS_A,
      kind: "decision" as const,
      title: "concurrency",
      body,
      scopeOwner: `workspace:${WS_A}`,
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => adapter.createDecisionUnlessDuplicate(input))
    );

    expect(new Set(results.map((r) => r.decision.id)).size).toBe(1);
    expect(results.filter((r) => !r.reused)).toHaveLength(1);
    const rows = await superSql`
      SELECT id FROM mnemosyne.mnemo_decision WHERE workspace_id = ${WS_A} AND body = ${body}
    `;
    expect(rows).toHaveLength(1);
  });

  it("writes the same row and outbox entry as createDecision (parity)", async () => {
    const n = crypto.randomUUID();
    const base = {
      workspaceId: WS_A,
      kind: "architecture" as const,
      title: `parity ${n}`,
      scopeOwner: `workspace:${WS_A}`,
      agentId: "agent-p",
      actorId: "key:parity",
      userId: null,
      actorType: "agent" as const,
      conversationId: `conv-${n}`,
      scopeRef: "proj-parity",
      confidence: 0.8,
      sensitivity: "internal" as const,
      metadata: { source: "parity" },
    };
    const viaCreate = await adapter.createDecision({ ...base, body: `A ${n}` });
    const viaDedup = (await adapter.createDecisionUnlessDuplicate({ ...base, body: `B ${n}` }))
      .decision;

    expect(comparable(viaDedup)).toEqual(comparable(viaCreate));
    const [pa, pb] = [await outboxPayload(viaCreate.id), await outboxPayload(viaDedup.id)];
    expect(Object.keys(pb ?? {}).sort()).toEqual(Object.keys(pa ?? {}).sort());
    expect(pb?.["text"]).toBe(String(pa?.["text"]).replace(`A ${n}`, `B ${n}`));
  });

  // remember() keeps the decision's subject in metadata (AGENTSIM-7): the same
  // sentence about another subject is another decision, and a row with a
  // subject is not a row without one.
  it("tells decisions apart by the subject remember() keeps in metadata", async () => {
    const body = `Retry with backoff (${crypto.randomUUID()}).`;
    const same = {
      workspaceId: WS_A,
      kind: "decision" as const,
      title: body,
      body,
      scopeOwner: `workspace:${WS_A}`,
      scopeRef: "repo:ledger-api",
      metadata: { subject: "ledger-api" },
    };
    const first = await adapter.createDecisionUnlessDuplicate(same);
    expect(first.reused).toBe(false);

    const repeat = await adapter.createDecisionUnlessDuplicate(same);
    expect(repeat).toMatchObject({ reused: true, decision: { id: first.decision.id } });

    const other = await adapter.createDecisionUnlessDuplicate({
      ...same,
      metadata: { subject: "payments-api" },
    });
    expect(other.reused).toBe(false);
    const { metadata: _omit, ...noSubject } = same;
    const bare = await adapter.createDecisionUnlessDuplicate(noSubject);
    expect(bare.reused).toBe(false);
  });
});

describe("createStrategyUnlessDuplicate (real Postgres, RLS)", () => {
  it("returns the identical active strategy and inserts for anything that differs", async () => {
    const action = `Roll back, then rerun with --dry-run (${crypto.randomUUID()}).`;
    const same = {
      workspaceId: WS_A,
      trigger: "when a migration fails",
      action,
      scopeOwner: `workspace:${WS_A}`,
    };
    const existing = await adapter.createStrategy(same);

    const repeat = await adapter.createStrategyUnlessDuplicate(same);
    expect(repeat).toMatchObject({ reused: true, strategy: { id: existing.id } });

    for (const differs of [
      { ...same, action: `${action} later` },
      { ...same, trigger: "when a deploy fails" },
      { ...same, sensitivity: "confidential" as const },
      { ...same, workspaceId: WS_B, scopeOwner: `workspace:${WS_B}` },
    ]) {
      const res = await adapter.createStrategyUnlessDuplicate(differs);
      expect(res.reused).toBe(false);
    }

    await adapter.archiveStrategy(existing.id, WS_A);
    expect((await adapter.createStrategyUnlessDuplicate(same)).reused).toBe(false);
  });

  it("eight identical concurrent writes leave one strategy", async () => {
    const action = `Concurrent strategy (${crypto.randomUUID()}).`;
    const input = {
      workspaceId: WS_A,
      trigger: "when two agents race",
      action,
      scopeOwner: `workspace:${WS_A}`,
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => adapter.createStrategyUnlessDuplicate(input))
    );

    expect(new Set(results.map((r) => r.strategy.id)).size).toBe(1);
    const rows = await superSql`
      SELECT id FROM mnemosyne.mnemo_strategy WHERE workspace_id = ${WS_A} AND action = ${action}
    `;
    expect(rows).toHaveLength(1);
  });

  it("writes the same row and outbox entry as createStrategy (parity)", async () => {
    const n = crypto.randomUUID();
    const base = {
      workspaceId: WS_A,
      trigger: `parity ${n}`,
      scopeOwner: `workspace:${WS_A}`,
      agentId: "agent-p",
      actorId: "key:parity",
      userId: null,
      actorType: "agent" as const,
      scopeRef: "proj-parity",
      context: "ctx",
      sensitivity: "internal" as const,
      metadata: { source: "parity" },
    };
    const viaCreate = await adapter.createStrategy({ ...base, action: `A ${n}` });
    const viaDedup = (await adapter.createStrategyUnlessDuplicate({ ...base, action: `B ${n}` }))
      .strategy;

    expect(comparable(viaDedup)).toEqual(comparable(viaCreate));
    const [pa, pb] = [await outboxPayload(viaCreate.id), await outboxPayload(viaDedup.id)];
    expect(Object.keys(pb ?? {}).sort()).toEqual(Object.keys(pa ?? {}).sort());
    expect(pb?.["text"]).toBe(String(pa?.["text"]).replace(`A ${n}`, `B ${n}`));
  });
});
