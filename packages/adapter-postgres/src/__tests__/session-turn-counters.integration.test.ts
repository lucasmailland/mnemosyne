import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";

import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

/**
 * P116 regression: `mnemo_session.turn_count` / `token_count` must track the
 * rows in `mnemo_session_turn`.
 *
 * This test HAS to run against the real adapter. `appendTurn` inserted the turn
 * and never updated the parent counters, and no unit test could see it: the
 * in-memory adapter DERIVES `turnCount` by counting turns on read
 * (types/src/testing/in-memory/sessions.ts), so the double reported the right
 * number while Postgres reported 0 forever.
 *
 * What the zeros broke: the auto-collapse sweep predicate in
 * server/src/index.ts is
 *   `started_at <= NOW() - INTERVAL '5 minutes' OR turn_count >= 5 OR token_count >= 1024`
 * — two of its three triggers were unreachable, and shouldCollapseUnderPolicy
 * decided `max_turns`/`max_tokens` against permanent zeros. Measured on a live
 * stack before the fix: sessions with 3 and 4 real turn rows, both reporting
 * turn_count = 0.
 */

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";
const WS = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

let container: StartedTestContainer;
let superSql: ReturnType<typeof postgres>;
let superClient: ReturnType<typeof createDrizzleClient>;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASS,
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const url = `postgres://${PG_USER}:${PG_PASS}@${container.getHost()}:${container.getMappedPort(
    5432
  )}/${PG_DB}`;

  await migrate({ databaseUrl: url, log: () => void 0 });
  superSql = postgres(url, { max: 1, onnotice: () => void 0 });
  superClient = createDrizzleClient(url);
}, 120_000);

afterAll(async () => {
  await superClient?.pgClient.end().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

async function counters(sessionId: string) {
  const rows = await superSql<Array<{ turn_count: number; token_count: number; rows: number }>>`
    SELECT s.turn_count,
           s.token_count,
           (SELECT COUNT(*)::int
              FROM mnemosyne.mnemo_session_turn t
             WHERE t.session_id = s.id) AS rows
      FROM mnemosyne.mnemo_session s
     WHERE s.id = ${sessionId}
  `;
  return rows[0]!;
}

describe("P116 — session turn counters track the rows", () => {
  it("allocates distinct turn indexes under concurrent appends", async () => {
    const adapter = new DrizzleStorageAdapter(superClient.db, superClient.pgClient);
    const session = await adapter.createSession({ workspaceId: WS });

    await Promise.all(
      ["first", "second"].map((content) =>
        adapter.appendTurn(session.id, {
          workspaceId: WS,
          sessionId: session.id,
          turnIndex: 0,
          role: "user",
          content,
        })
      )
    );

    const rows = await superSql<Array<{ turn_index: number }>>`
      SELECT turn_index FROM mnemosyne.mnemo_session_turn
      WHERE session_id = ${session.id}
      ORDER BY turn_index
    `;
    expect(rows.map((row) => row.turn_index)).toEqual([0, 1]);
  });

  it("turn_count equals the number of turn rows, and token_count sums them", async () => {
    const adapter = new DrizzleStorageAdapter(superClient.db, superClient.pgClient);
    const session = await adapter.createSession({ workspaceId: WS });

    expect(await counters(session.id)).toMatchObject({ turn_count: 0, token_count: 0, rows: 0 });

    for (let i = 0; i < 4; i++) {
      await adapter.appendTurn(session.id, {
        workspaceId: WS,
        sessionId: session.id,
        turnIndex: i,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i}`,
        tokenCount: 10,
      });
    }

    const after = await counters(session.id);
    // The assertion that matters is the EQUALITY, not the literal 4: a counter
    // that drifts from its rows is worse than no counter, because the sweep
    // reads it as authoritative.
    expect(after.turn_count).toBe(after.rows);
    expect(after.turn_count).toBe(4);
    expect(after.token_count).toBe(40);
  });

  it("a turn with no tokenCount still counts as a turn and adds 0 tokens", async () => {
    const adapter = new DrizzleStorageAdapter(superClient.db, superClient.pgClient);
    const session = await adapter.createSession({ workspaceId: WS });

    await adapter.appendTurn(session.id, {
      workspaceId: WS,
      sessionId: session.id,
      turnIndex: 0,
      role: "user",
      content: "no token count supplied",
    });

    const after = await counters(session.id);
    expect(after.turn_count).toBe(1);
    expect(after.turn_count).toBe(after.rows);
    // tokenCount is optional on SessionTurn; a missing value must not NULL out
    // the running total (`x + NULL` is NULL in SQL, which would silently wipe
    // every token counted before it).
    expect(after.token_count).toBe(0);
  });

  it("a rejected cross-workspace turn moves neither the rows nor the counters", async () => {
    const adapter = new DrizzleStorageAdapter(superClient.db, superClient.pgClient);
    const session = await adapter.createSession({ workspaceId: WS });

    await adapter.appendTurn(session.id, {
      workspaceId: WS,
      sessionId: session.id,
      turnIndex: 0,
      role: "user",
      content: "legitimate",
      tokenCount: 7,
    });

    await expect(
      adapter.appendTurn(session.id, {
        workspaceId: "dddddddd-dddd-4ddd-dddd-dddddddddddd",
        sessionId: session.id,
        turnIndex: 1,
        role: "user",
        content: "cross workspace",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const after = await counters(session.id);
    expect(after.turn_count).toBe(1);
    expect(after.turn_count).toBe(after.rows);
    expect(after.token_count).toBe(7);
  });
});

it("P139 — replay does not increment counters, including after successor rollover", async () => {
  const adapter = new DrizzleStorageAdapter(superClient.db, superClient.pgClient);
  const binding = {
    workspaceId: WS,
    actorId: "key:capture",
    sourceSessionId: "counter-replay",
    sourceClientInstanceId: "client",
    sourceGeneration: 0,
  };
  const first = await adapter.createSession(binding);
  const turn = {
    workspaceId: WS,
    sessionId: first.id,
    turnIndex: 0,
    role: "user" as const,
    content: "yes",
    tokenCount: 1,
    sourceMessageId: "native-occurrence",
  };
  await Promise.all([adapter.appendTurn(first.id, turn), adapter.appendTurn(first.id, turn)]);
  expect(await counters(first.id)).toMatchObject({ turn_count: 1, token_count: 1, rows: 1 });
  await adapter.closeSession(first.id, WS);
  const successor = await adapter.createSession({
    ...binding,
    sourceGeneration: 1,
    predecessorSessionId: first.id,
  });
  await adapter.appendTurn(successor.id, { ...turn, sessionId: successor.id });
  expect(await counters(successor.id)).toMatchObject({ turn_count: 0, token_count: 0, rows: 0 });
});
