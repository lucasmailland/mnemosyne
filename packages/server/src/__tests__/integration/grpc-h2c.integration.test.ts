/**
 * The bidirectional gRPC RPCs over the h2c listener (MNEMO_GRPC_PORT).
 *
 * The main listener is node:http (HTTP/1.1): a bidi stream cannot cross it. The
 * server opens a second, cleartext HTTP/2 listener with the same Connect handler
 * (index.ts: `createH2cServer(connectHandler)`). This test builds that listener
 * over a real Postgres (testcontainer, real migrations, a real API key) and opens
 * `Session` with real clients over a real socket: the gRPC protocol and the
 * Connect protocol on HTTP/2. The session and its turn land in the database, and
 * the listener refuses a call without a key (same interceptor as HTTP/1.1).
 * Requires Docker.
 */
import { execFile } from "node:child_process";
import { createServer, type Http2Server } from "node:http2";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport, createGrpcTransport } from "@connectrpc/connect-node";
import bcrypt from "bcrypt";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BCRYPT_COST } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { MnemosyneService } from "../../gen/mnemosyne_pb.js";
import { createConnectHandler } from "../../grpc.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const WS = "cccccccc-cccc-4ccc-8ccc-cccccccccc01";
const KEY = "mns_live_grpch2cacmesessionkey0001";

let container: StartedTestContainer;
let sql: postgres.Sql;
let server: Http2Server;
let baseUrl: string;
let closeDeps: () => Promise<void>;

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: "mnemo", POSTGRES_PASSWORD: "mnemo", POSTGRES_DB: "mnemo" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const databaseUrl = `postgres://mnemo:mnemo@${container.getHost()}:${container.getMappedPort(5432)}/mnemo`;

  sql = postgres(databaseUrl, { max: 2, onnotice: () => void 0 });
  await sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", databaseUrl],
    { timeout: 90_000 }
  );
  await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  await sql`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES ('key_grpc_h2c', ${WS}, ${keyHash}, 'grpc', 'grpc', '{memory:write,memory:read}'::text[])
  `;

  const [coreMod, adapterPgMod] = await Promise.all([
    import("@mnemo-ai/core"),
    import("@mnemo-ai/adapter-postgres"),
  ]);
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl });
  const { db, pgClient } = adapterPgMod.createDrizzleClient(databaseUrl);
  const storage = new adapterPgMod.DrizzleStorageAdapter(db, pgClient, undefined);
  const deps = { apiKeys, storage } as unknown as ServerDeps;
  closeDeps = async () => {
    await apiKeys.close?.().catch(() => void 0);
    await pgClient.end({ timeout: 2 }).catch(() => void 0);
  };

  // The listener index.ts opens on MNEMO_GRPC_PORT.
  server = createServer(createConnectHandler(deps));
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 300_000);

afterAll(async () => {
  // Not awaited: close() waits for the clients' idle HTTP/2 sessions to end.
  server?.close();
  await closeDeps?.();
  await sql?.end({ timeout: 2 });
  await container?.stop();
});

async function* frames(turn: string) {
  yield { payload: { case: "controlFrame" as const, value: 'start {"agentId":"acme-agent"}' } };
  yield { payload: { case: "userTurn" as const, value: turn } };
}

async function openSession(transport: Transport, turn: string, key?: string): Promise<string[]> {
  const client = createClient(MnemosyneService, transport);
  const out: string[] = [];
  const headers = key ? { authorization: `Bearer ${key}` } : {};
  for await (const resp of client.session(frames(turn), { headers })) {
    if (resp.payload.case === "assistantTurn") out.push(resp.payload.value);
    if (resp.payload.case === "error") throw new Error(resp.payload.value.message);
  }
  return out;
}

describe("Session over the h2c listener", () => {
  it.each([
    ["gRPC", () => createGrpcTransport({ baseUrl })],
    ["Connect on HTTP/2", () => createConnectTransport({ baseUrl, httpVersion: "2" })],
  ])("%s opens a session and persists its turn", async (_name, transport) => {
    const turn = `Larkspur Robotics ships on Fridays (${_name})`;
    const replies = await openSession(transport(), turn, KEY);

    expect(replies).toHaveLength(2);
    const sessionId = replies[0]!.replace(/^started:/, "");
    expect(replies[0]).toBe(`started:${sessionId}`);
    expect(replies[1]).toBe(`ack:${turn.length}`);

    const [session] = await sql`
      SELECT workspace_id, agent_id FROM mnemosyne.mnemo_session WHERE id = ${sessionId}`;
    expect(session).toMatchObject({ workspace_id: WS, agent_id: "acme-agent" });
    const turns = await sql`
      SELECT content FROM mnemosyne.mnemo_session_turn WHERE session_id = ${sessionId}`;
    expect(turns.map((t) => t.content)).toEqual([turn]);
  });

  it("refuses a call without a key", async () => {
    const err = await openSession(createGrpcTransport({ baseUrl }), "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.Unauthenticated);
  });
});
