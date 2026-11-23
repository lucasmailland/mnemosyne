/**
 * Integration test: DrizzleStorageAdapter.queryDecisions time filters, ordering, keyset and
 * the SQL-side status / ceiling filters the timeline reads with.
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

describe("DrizzleStorageAdapter.queryDecisions — time filters and ordering", () => {
  const WS = "dddddddd-dddd-4ddd-dddd-dddddddddddd";

  it("orders newest first by the chosen instant and filters by createdSince / closedSince", async () => {
    // Raw inserts pin the instants (an UPDATE trigger would restamp updated_at).
    const mk = async (id: string, created: string, updated: string) => {
      await rawSql`
        INSERT INTO mnemosyne.mnemo_decision
          (id, workspace_id, kind, title, body, normalized_hash, created_at, updated_at, valid_from)
        VALUES (${id}, ${WS}, ${"decision"}, ${id}, ${id}, ${"h" + id},
          ${created}::timestamptz, ${updated}::timestamptz, ${created}::timestamptz)`;
      return { id };
    };
    const a = await mk("tf_a", "2026-03-01T08:00:00Z", "2026-03-01T12:00:00Z");
    const b = await mk("tf_b", "2026-03-01T09:00:00Z", "2026-03-01T09:00:00Z");
    const c = await mk("tf_c", "2026-03-01T10:00:00Z", "2026-03-01T10:00:00Z");

    const ids = async (f: object) =>
      (await adapter.queryDecisions({ workspaceId: WS, ...f })).items.map((d) => d.id);

    expect(await ids({ orderBy: "createdAt" })).toEqual([c.id, b.id, a.id]);
    expect(await ids({ orderBy: "closedAt" })).toEqual([a.id, c.id, b.id]);
    expect(
      await ids({ orderBy: "createdAt", createdSince: new Date("2026-03-01T09:00:00Z") })
    ).toEqual([c.id, b.id]);
    // closedSince is exclusive, like queryFactsPage's updatedSince.
    expect(
      await ids({ orderBy: "closedAt", closedSince: new Date("2026-03-01T09:00:00Z") })
    ).toEqual([a.id, c.id]);
  });

  it("closedAt is validTo ?? updatedAt; statuses, ceiling, keyset and skipTotal filter in SQL", async () => {
    const W3 = "ffffffff-ffff-4fff-ffff-ffffffffffff";
    const mk = async (
      id: string,
      created: string,
      updated: string,
      validTo: string | null,
      status: string,
      sensitivity = "internal"
    ) => {
      await rawSql`
        INSERT INTO mnemosyne.mnemo_decision
          (id, workspace_id, kind, title, body, normalized_hash, created_at, updated_at,
           valid_from, valid_to, status, sensitivity)
        VALUES (${id}, ${W3}, ${"decision"}, ${id}, ${id}, ${"h" + id},
          ${created}::timestamptz, ${updated}::timestamptz, ${created}::timestamptz,
          ${validTo}::timestamptz, ${status}, ${sensitivity})`;
    };
    // k_x closed at 11:00 and edited at 13:00; k_y withdrawn at 12:00.
    await mk(
      "k_x",
      "2026-03-03T10:00:00Z",
      "2026-03-03T13:00:00Z",
      "2026-03-03T11:00:00Z",
      "superseded"
    );
    await mk(
      "k_y",
      "2026-03-03T10:00:00Z",
      "2026-03-03T12:00:00Z",
      "2026-03-03T12:00:00Z",
      "withdrawn"
    );
    await mk("k_a", "2026-03-03T10:00:00Z", "2026-03-03T12:30:00Z", null, "active");
    await mk(
      "k_r",
      "2026-03-03T10:00:00Z",
      "2026-03-03T12:45:00Z",
      "2026-03-03T12:45:00Z",
      "withdrawn",
      "restricted"
    );

    const query = (f: object) => adapter.queryDecisions({ workspaceId: W3, ...f });
    const ids = async (f: object) => (await query(f)).items.map((d) => d.id);
    const closing = {
      orderBy: "closedAt",
      statuses: ["superseded", "withdrawn"],
      maxSensitivity: "internal",
    };
    expect(await ids(closing)).toEqual(["k_y", "k_x"]);
    expect(
      await ids({ ...closing, before: { at: new Date("2026-03-03T12:00:00Z"), id: "k_y" } })
    ).toEqual(["k_x"]);
    // Same instant, smaller id comes next (byte order, descending).
    expect(
      await ids({
        orderBy: "createdAt",
        before: { at: new Date("2026-03-03T10:00:00Z"), id: "k_r" },
      })
    ).toEqual(["k_a"]);
    expect(await query({ orderBy: "createdAt", limit: 2, skipTotal: true })).toMatchObject({
      total: 2,
      hasMore: true,
    });
  });

  it("same-millisecond timestamps and case/punctuation ids order by ms then byte-order id", async () => {
    const W2 = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";
    const rows: Array<[string, string]> = [
      ["Zz", "2026-03-02T08:00:00.000900Z"],
      ["a_b", "2026-03-02T08:00:00.000100Z"],
      ["a-b", "2026-03-02T08:00:00.000500Z"],
      ["B", "2026-03-02T08:00:00.000700Z"],
    ];
    for (const [id, at] of rows) {
      await rawSql`
        INSERT INTO mnemosyne.mnemo_decision
          (id, workspace_id, kind, title, body, normalized_hash, created_at, updated_at, valid_from)
        VALUES (${id}, ${W2}, ${"decision"}, ${id}, ${id}, ${"h" + id},
          ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz)`;
    }
    // Same ms: byte order descending is a_b (0x5f) > a-b (0x2d) > Zz (0x5a)? compare to JS.
    const expected = rows.map((r) => r[0]).sort((x, y) => (x < y ? 1 : x > y ? -1 : 0));
    const got = (
      await adapter.queryDecisions({ workspaceId: W2, orderBy: "createdAt", limit: 50 })
    ).items.map((d) => d.id);
    expect(got).toEqual(expected);
  });
});
