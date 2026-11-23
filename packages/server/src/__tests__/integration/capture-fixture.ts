import { OpenAPIHono } from "@hono/zod-openapi";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient, DrizzleStorageAdapter } from "@mnemo-ai/adapter-postgres";
import { migrate } from "@mnemo-ai/adapter-postgres/migrate";
import { SessionBuffer } from "@mnemo-ai/core";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountSession } from "../../routes/session.js";

export const WS = "00000000-0000-4000-8000-000000000138";
export const OTHER_WS = "00000000-0000-4000-8000-000000000139";
export async function createCaptureFixture() {
  const container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({
      POSTGRES_USER: "mnemo_super",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "mnemo_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const base = `${container.getHost()}:${container.getMappedPort(5432)}/mnemo_test`;
  const url = `postgres://mnemo_super:test@${base}`;
  await migrate({ databaseUrl: url, log: () => {} });
  const bootstrap = postgres(url, { max: 1, onnotice: () => {} });
  await bootstrap.unsafe(
    "CREATE ROLE capture_app LOGIN PASSWORD 'test' NOSUPERUSER NOBYPASSRLS; GRANT mnemo_app_role TO capture_app; GRANT CONNECT ON DATABASE mnemo_test TO capture_app; GRANT USAGE ON SCHEMA mnemosyne TO capture_app; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO capture_app;"
  );
  await bootstrap.end();
  const client = createDrizzleClient(`postgres://capture_app:test@${base}`);
  const storage = new DrizzleStorageAdapter(client.db, client.pgClient);
  const buffer = new SessionBuffer(null, storage, storage);
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", c.req.header("X-Test-Workspace") ?? WS);
    c.set("actorId", "capture");
    c.set("actorType", "agent");
    await next();
  });
  app.onError((err, c) => {
    const e = toErrorBody(err);
    return c.json(e.body, e.status as 409);
  });
  mountSession(app, { storage, sessionBuffer: buffer } as unknown as ServerDeps);
  const post = (path: string, body: unknown, workspaceId = WS) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Test-Workspace": workspaceId },
      body: JSON.stringify(body),
    });
  return {
    storage,
    buffer,
    post,
    close: async () => {
      await client.pgClient.end();
      await container.stop();
    },
  };
}
