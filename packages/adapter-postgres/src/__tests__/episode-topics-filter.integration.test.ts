/**
 * flatten-legacy-dual-core Slice 3c pt.1 (PR10) — `EpisodeRepository.
 * queryEpisodes`'s `topics` filter. `EpisodeFilter.topics` was declared in
 * `@mnemo-ai/types` but never wired into the query (pre-existing gap, found
 * while porting `GET /episodes` off `deps.core`). Real Postgres, not
 * mocked — the array-overlap (`&&`) operator against the GIN-indexed
 * `topics` column can only be proven against a real query planner/executor.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

const WS = "67676767-6767-4767-8767-676767676767";

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

describe("EpisodeRepository.queryEpisodes — topics filter", () => {
  it("matches episodes whose topics array overlaps with the filter, ignores non-matching episodes", async () => {
    const roadmap = await adapter.createEpisode({
      workspaceId: WS,
      title: "Roadmap sync",
      narrative: "Discussed Q2 roadmap.",
      occurredAt: new Date(), // determinism-ok: fixture timestamp, not asserted
      topics: ["roadmap", "planning"],
    });
    const unrelated = await adapter.createEpisode({
      workspaceId: WS,
      title: "Standup",
      narrative: "Daily standup notes.",
      occurredAt: new Date(), // determinism-ok: fixture timestamp, not asserted
      topics: ["standup"],
    });

    const page = await adapter.queryEpisodes({ workspaceId: WS, topics: ["roadmap"] });
    const ids = page.items.map((e) => e.id);
    expect(ids).toContain(roadmap.id);
    expect(ids).not.toContain(unrelated.id);
  });

  it("with no topics filter, returns both", async () => {
    const a = await adapter.createEpisode({
      workspaceId: WS,
      title: "A",
      narrative: "n",
      occurredAt: new Date(), // determinism-ok: fixture timestamp, not asserted
      topics: ["alpha"],
    });
    const b = await adapter.createEpisode({
      workspaceId: WS,
      title: "B",
      narrative: "n",
      occurredAt: new Date(), // determinism-ok: fixture timestamp, not asserted
      topics: ["beta"],
    });

    const page = await adapter.queryEpisodes({ workspaceId: WS });
    const ids = page.items.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
  });
});
