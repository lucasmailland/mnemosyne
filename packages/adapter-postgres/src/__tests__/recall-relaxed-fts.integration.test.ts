import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

let container: StartedTestContainer;
let adapter: DrizzleStorageAdapter;
const workspaceId = "66666666-6666-4666-8666-666666666666";

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({
      POSTGRES_USER: "mnemo_test",
      POSTGRES_PASSWORD: "mnemo_test",
      POSTGRES_DB: "mnemo_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const databaseUrl = `postgres://mnemo_test:mnemo_test@${container.getHost()}:${container.getMappedPort(5432)}/mnemo_test`;
  await migrate({ databaseUrl, log: () => undefined });
  const { db, pgClient } = createDrizzleClient(databaseUrl);
  adapter = new DrizzleStorageAdapter(db, pgClient);
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await container?.stop();
});

describe("recall-only relaxed FTS", () => {
  it("finds a Spanish deployment fact after a strict miss, without changing strict search", async () => {
    const fact = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "El chatbot de soporte se despliega por GitLab CI",
      subject: "chatbot",
      kind: "other",
    });
    const query = {
      workspaceId,
      // "producción" is not in the fact, so the strict AND of every lexeme misses.
      terms: ["¿cómo", "se", "despliega", "el", "chatbot", "de", "soporte", "en", "producción?"],
      limit: 10,
    };
    expect(await adapter.ftsCandidates(query)).toEqual([]);
    const relaxed = await adapter.ftsCandidates({ ...query, relaxedOnEmpty: true });
    expect(relaxed.map((row) => row.factId)).toContain(fact.id);
  });

  it("returns no rows for stopword-only input", async () => {
    const otherWorkspace = "77777777-7777-4777-8777-777777777777";
    await adapter.createFact({
      workspaceId: otherWorkspace,
      scope: "global",
      statement: "Deploys run on Fridays",
      subject: "deploys",
      kind: "other",
    });
    expect(
      await adapter.ftsCandidates({
        workspaceId: otherWorkspace,
        terms: ["el", "de", "se", "que"],
        limit: 10,
        relaxedOnEmpty: true,
      })
    ).toEqual([]);
  });

  it("requires two matched content terms", async () => {
    const query = {
      workspaceId,
      terms: ["chatbot", "facturación", "nómina", "vacaciones"],
      limit: 10,
      relaxedOnEmpty: true,
    };
    expect(await adapter.ftsCandidates(query)).toEqual([]);
  });

  it("counts stem-equivalent words only once", async () => {
    const isolatedWorkspace = "88888888-8888-4888-8888-888888888888";
    await adapter.createFact({
      workspaceId: isolatedWorkspace,
      scope: "global",
      statement: "The chatbot handles requests",
      subject: "chatbot",
      kind: "other",
    });
    expect(
      await adapter.ftsCandidates({
        workspaceId: isolatedWorkspace,
        terms: ["chatbot", "chatbots", "nómina"],
        limit: 10,
        relaxedOnEmpty: true,
      })
    ).toEqual([]);
  });
});
