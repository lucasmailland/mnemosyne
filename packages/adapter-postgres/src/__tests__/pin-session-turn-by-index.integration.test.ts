/**
 * Integration test: pinning a session turn by its ordinal index.
 *
 * `memory_session action:'pin_turn'` advertises "requiere `sessionId` y
 * `turnId` o `turnIndex`", but nothing ever translated an index into an id.
 * The MCP tool did this:
 *
 *     const turnId = args.turnId ?? String(args.turnIndex);
 *
 * so `turnIndex: 1` arrived at the storage layer as the id `"1"` and landed in
 * a uuid comparison. Observed on a live stack:
 *
 *     update "mnemosyne"."mnemo_session_turn" set "pinned" = $1
 *       where "id" = $2 and "session_id" = $3 and "workspace_id" = $4
 *     params: true, 1, ...
 *     → invalid input syntax for type uuid: "1"     (HTTP 500, retried 3x)
 *
 * The retry is its own small waste: 22P02 is a deterministic malformed-input
 * error, so every attempt failed identically.
 *
 * `mnemo_session_turn` has had a populated `turn_index integer` column all
 * along, so the selector this advertises is one WHERE clause away.
 *
 * Second thing fixed here: the update returned void, so a selector matching no
 * row was indistinguishable from success. Pinning turn 99 of a 2-turn session
 * answered 204. It now reports whether a row matched, so the route can 404.
 *
 * Requires Docker + Node >=22 — same testcontainers pattern as
 * decision-topic-key.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

const WS = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
const SESSION = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";

let container: StartedTestContainer;
let adapter: DrizzleStorageAdapter;
let raw: postgres.Sql;

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

  await migrate({ databaseUrl, log: () => undefined });

  const { db, pgClient } = createDrizzleClient(databaseUrl);
  adapter = new DrizzleStorageAdapter(db, pgClient);
  raw = postgres(databaseUrl, { connection: { search_path: "mnemosyne,public" } });
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await raw?.end();
  await container?.stop();
});

/** Two turns, indices 0 and 1, neither pinned. */
async function seedTurns(): Promise<{ first: string; second: string }> {
  await raw`DELETE FROM mnemosyne.mnemo_session_turn WHERE session_id = ${SESSION}`;
  await raw`DELETE FROM mnemosyne.mnemo_session WHERE id = ${SESSION}`;
  await raw`
    INSERT INTO mnemosyne.mnemo_session (id, workspace_id, status)
    VALUES (${SESSION}, ${WS}, 'active')
  `;
  const rows = await raw<Array<{ id: string }>>`
    INSERT INTO mnemosyne.mnemo_session_turn
      (id, workspace_id, session_id, turn_index, role, content, pinned)
    VALUES
      (gen_random_uuid(), ${WS}, ${SESSION}, 0, 'user', 'primer turno', false),
      (gen_random_uuid(), ${WS}, ${SESSION}, 1, 'assistant', 'segundo turno', false)
    RETURNING id
  `;
  return { first: rows[0]!.id, second: rows[1]!.id };
}

async function pinnedByIndex(): Promise<Map<number, boolean>> {
  const rows = await raw<Array<{ turn_index: number; pinned: boolean }>>`
    SELECT turn_index, pinned FROM mnemosyne.mnemo_session_turn
    WHERE session_id = ${SESSION} ORDER BY turn_index
  `;
  return new Map(rows.map((r) => [r.turn_index, r.pinned]));
}

describe("pinSessionTurn", () => {
  beforeEach(async () => {
    await seedTurns();
  });

  it("pins the turn at the given index without raising on a non-uuid selector", async () => {
    const matched = await adapter.pinSessionTurn({
      sessionId: SESSION,
      workspaceId: WS,
      turnIndex: 1,
      pinned: true,
    });

    expect(matched).toBe(true);
    const pinned = await pinnedByIndex();
    expect(pinned.get(1)).toBe(true);
    expect(pinned.get(0)).toBe(false);
  });

  it("pins index 0 — the falsy index a `??`/`||` selector would drop", async () => {
    const matched = await adapter.pinSessionTurn({
      sessionId: SESSION,
      workspaceId: WS,
      turnIndex: 0,
      pinned: true,
    });

    expect(matched).toBe(true);
    expect((await pinnedByIndex()).get(0)).toBe(true);
  });

  it("still pins by turn id", async () => {
    const { second } = await seedTurns();

    const matched = await adapter.pinSessionTurn({
      sessionId: SESSION,
      workspaceId: WS,
      turnId: second,
      pinned: true,
    });

    expect(matched).toBe(true);
    expect((await pinnedByIndex()).get(1)).toBe(true);
  });

  it("unpins by index", async () => {
    await adapter.pinSessionTurn({
      sessionId: SESSION,
      workspaceId: WS,
      turnIndex: 1,
      pinned: true,
    });

    const matched = await adapter.pinSessionTurn({
      sessionId: SESSION,
      workspaceId: WS,
      turnIndex: 1,
      pinned: false,
    });

    expect(matched).toBe(true);
    expect((await pinnedByIndex()).get(1)).toBe(false);
  });

  it("reports no match for an index that does not exist, instead of silent success", async () => {
    const matched = await adapter.pinSessionTurn({
      sessionId: SESSION,
      workspaceId: WS,
      turnIndex: 99,
      pinned: true,
    });

    expect(matched).toBe(false);
  });

  it("reports no match for a turn id from another session", async () => {
    const matched = await adapter.pinSessionTurn({
      sessionId: SESSION,
      workspaceId: WS,
      turnId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      pinned: true,
    });

    expect(matched).toBe(false);
  });
});
