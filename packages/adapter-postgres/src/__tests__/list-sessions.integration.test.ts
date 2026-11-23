/**
 * ADP-3 — listSessions() was declared as an optional port method
 * (StorageAdapter.listSessions?) but never implemented on
 * DrizzleStorageAdapter. GET /session/list (packages/server/src/routes/
 * session.ts) feature-detects the method and silently falls back to `[]`
 * when it's missing — so the route existed (closing B2's 404) but always
 * returned an empty list against the real Postgres adapter.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

const WS_A = "12121212-1212-4212-8212-121212121212";
const WS_B = "34343434-3434-4434-8434-343434343434";

let container: StartedTestContainer;
let adapter: DrizzleStorageAdapter;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  await migrate({ databaseUrl, log: () => void 0 });

  const { db, pgClient } = createDrizzleClient(databaseUrl);
  adapter = new DrizzleStorageAdapter(db, pgClient);
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await container?.stop().catch(() => void 0);
});

describe("listSessions() (ADP-3)", () => {
  it("returns sessions scoped to the requested workspace, most recent first", async () => {
    const s1 = await adapter.createSession({ workspaceId: WS_A, agentId: "agent-1" });
    await new Promise((r) => setTimeout(r, 10));
    const s2 = await adapter.createSession({ workspaceId: WS_A, agentId: "agent-2" });
    await adapter.createSession({ workspaceId: WS_B, agentId: "agent-other-workspace" });

    const sessions = await adapter.listSessions!(WS_A);

    expect(sessions.map((s) => s.id)).toEqual([s2.id, s1.id]);
    expect(sessions.every((s) => s.workspaceId === WS_A)).toBe(true);
  });

  it("respects limit and offset", async () => {
    const ws = "56565656-5656-4656-8656-565656565656";
    const created = [];
    for (let i = 0; i < 5; i++) {
      created.push(await adapter.createSession({ workspaceId: ws, agentId: `agent-${i}` }));
    }

    const page1 = await adapter.listSessions!(ws, 2, 0);
    const page2 = await adapter.listSessions!(ws, 2, 2);

    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(page1.map((s) => s.id)).not.toEqual(page2.map((s) => s.id));
  });

  it("returns an empty array for a workspace with no sessions", async () => {
    const sessions = await adapter.listSessions!("78787878-7878-4878-8878-787878787878");
    expect(sessions).toEqual([]);
  });
});
