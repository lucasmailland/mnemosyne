/**
 * Federated items reach recall (POST /recall, and memory_recall through it).
 *
 * Two stock servers on one Postgres testcontainer, wired by the real boot path
 * as in federation-pull.integration.test.ts: Acme remembers a fact, Larkspur
 * pulls it (POST /memory/federation/sync) into its mnemo_federated_item, and
 * then Larkspur's recall:
 *   - returns it, marked as federated with the peer it came from and trust 20;
 *   - does not return it to a key of another Larkspur workspace;
 *   - does not return it to a key whose sensitivity ceiling is below the item's;
 *   - does not return it in strict semantic mode (it has no embedding).
 * Requires Docker.
 */
import { execFile } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { getRequestListener } from "@hono/node-server";
import bcrypt from "bcrypt";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import { wireFederation } from "../../boot/federation.js";
import type { ServerDeps } from "../../deps.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const ADMIN_SCOPES = [
  "memory:read",
  "memory:write",
  "memory:federation",
  "federation:admin",
  "admin:keys",
];

interface Booted {
  peerId: string;
  baseUrl: string;
  databaseUrl: string;
  workspaceId: string;
  adminKey: string;
  spkiB64: string;
  privatePem: string;
  close(): Promise<void>;
}

let container: StartedTestContainer;
let a: Booted;
let b: Booted;

async function bootServer(opts: {
  host: string;
  port: number;
  db: string;
  peerId: string;
  workspaceId: string;
  adminKey: string;
  /** Boot over the database an earlier server left (a restart). */
  restart?: boolean;
  privatePem?: string;
}): Promise<Booted> {
  const databaseUrl = `postgres://mnemo:mnemo@${opts.host}:${opts.port}/${opts.db}`;
  if (!opts.restart) await createDatabase(opts, databaseUrl);
  return startApp({ ...opts, databaseUrl });
}

async function createDatabase(
  opts: { host: string; port: number; db: string; workspaceId: string; adminKey: string },
  databaseUrl: string
): Promise<void> {
  const root = postgres(`postgres://mnemo:mnemo@${opts.host}:${opts.port}/mnemo`, {
    max: 1,
    onnotice: () => void 0,
  });
  await root.unsafe(`CREATE DATABASE ${opts.db}`);
  await root.end();

  const seed = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
  await seed.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", databaseUrl],
    { timeout: 90_000 }
  );
  await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  const keyHash = await bcrypt.hash(opts.adminKey, BCRYPT_COST);
  await seed`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${`key_admin_${opts.db}`}, ${opts.workspaceId}, ${keyHash}, ${"admin"}, ${"admin"},
            ${`{${ADMIN_SCOPES.join(",")}}`}::text[])
  `;
  await seed.end();
}

async function startApp(opts: {
  peerId: string;
  databaseUrl: string;
  workspaceId: string;
  adminKey: string;
  privatePem?: string;
}): Promise<Booted> {
  const { databaseUrl } = opts;
  const [coreMod, adapterPgMod, adapterVectorMod, v3CoreMod] = await Promise.all([
    import("@mnemo-ai/core"),
    import("@mnemo-ai/adapter-postgres"),
    import("@mnemo-ai/adapter-vector"),
    import("@mnemo-ai/core/cognitive"),
  ]);
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl });
  const DIMS = 1536;
  const embed: import("@mnemo-ai/types").EmbedAdapter = {
    id: "fake-embed",
    model: "fake-model",
    dimensions: DIMS,
    async embed(texts) {
      return texts.map(() => new Float32Array(DIMS).fill(0.1));
    },
    async embedSingle() {
      return new Float32Array(DIMS).fill(0.1);
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };
  const { db, pgClient } = adapterPgMod.createDrizzleClient(databaseUrl);
  const storage = new adapterPgMod.DrizzleStorageAdapter(db, pgClient, undefined);
  const vector = new adapterVectorMod.PgVectorAdapter({ connectionString: databaseUrl });
  const noopLogger: import("@mnemo-ai/types").Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child() {
      return this;
    },
  };
  const span = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const telemetry = {
    startSpan: () => span,
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
  const cognitive = v3CoreMod.createCore({
    storage,
    vector,
    embed,
    outbox: {
      append: (e) => storage.appendOutbox(e),
      claimBatch: (n) => storage.claimOutbox(n),
      markProcessed: (ids) => storage.markOutboxProcessed(ids),
      markFailed: (id, err) => storage.markOutboxFailed(id, err),
      getStats: async () => ({ pending: 0, failed: 0, oldestPendingMs: 0 }),
    },
    logger: noopLogger,
    telemetry,
  });
  const metricsPgClient = postgres(databaseUrl, { max: 5, onnotice: () => void 0 });
  const deps = {
    apiKeys,
    cognitive,
    storage,
    llm: undefined,
    embedModel: "fake-model",
    telemetry,
    metricsPgClient,
  } as unknown as ServerDeps;

  const privatePem =
    opts.privatePem ??
    generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKey = createPublicKey(privatePem);
  // The real boot path, with this server's own env (two servers, one process).
  await wireFederation({
    databaseUrl,
    deps,
    env: {
      MNEMO_FED_PEER_ID: opts.peerId,
      MNEMO_FEDERATION_PRIVATE_KEY: privatePem,
      MNEMO_FED_INSECURE_TRANSPORT: "true",
    },
  });
  expect(deps.federation?.identity?.peerId).toBe(opts.peerId);

  const app = createApp({ deps, version: `federation-pull-${opts.peerId}` });
  const server: Server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP port");

  return {
    peerId: opts.peerId,
    baseUrl: `http://127.0.0.1:${address.port}`,
    databaseUrl,
    workspaceId: opts.workspaceId,
    adminKey: opts.adminKey,
    spkiB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privatePem,
    async close() {
      await new Promise<void>((res) => server.close(() => res()));
      await apiKeys.close?.().catch(() => void 0);
      await metricsPgClient.end({ timeout: 2 }).catch(() => void 0);
      await vector.close?.().catch(() => void 0);
    },
  };
}

function call(server: Booted, method: string, path: string, body?: unknown, key?: string) {
  return fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key ?? server.adminKey}`,
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const OTHER_WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02";
const OTHER_KEY = "mns_live_federationrecallotherworkspace";
const PUBLIC_KEY = "mns_live_federationrecallpubliconlykey1";
const STATEMENT = "Acme ships its larkspur orders on Fridays.";

/** A key straight into Larkspur's database, as createDatabase seeds the admin's. */
async function seedKey(
  server: Booted,
  id: string,
  key: string,
  workspaceId: string,
  maxSensitivity: string | null
) {
  const db = postgres(server.databaseUrl, { max: 1, onnotice: () => void 0 });
  try {
    await db`
      INSERT INTO mnemosyne.mnemo_api_keys
        (id, workspace_id, key_hash, name, label, scopes, max_sensitivity)
      VALUES (${id}, ${workspaceId}, ${await bcrypt.hash(key, BCRYPT_COST)}, ${id}, ${id},
              '{memory:read}'::text[], ${maxSensitivity})`;
  } finally {
    await db.end();
  }
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: "mnemo", POSTGRES_PASSWORD: "mnemo", POSTGRES_DB: "mnemo" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  a = await bootServer({
    host,
    port,
    db: "mnemo_acme",
    peerId: "acme.example",
    workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
    adminKey: "mns_live_federationrecallacmeadmin001",
  });
  b = await bootServer({
    host,
    port,
    db: "mnemo_larkspur",
    peerId: "larkspur.example",
    workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01",
    adminKey: "mns_live_federationrecalllarkspuradmin",
  });
  await seedKey(b, "key_other_ws", OTHER_KEY, OTHER_WORKSPACE, null);
  await seedKey(b, "key_public_only", PUBLIC_KEY, b.workspaceId, "public");

  const issued = await call(a, "POST", "/admin/keys", {
    label: "larkspur.example pull",
    scopes: ["memory:federation"],
    federation: true,
  });
  expect(issued.status).toBe(201);
  const keyForB = ((await issued.json()) as { key: string }).key;
  expect(
    (
      await call(a, "POST", "/memory/federation/peers", {
        peerId: b.peerId,
        pinnedCertDer: b.spkiB64,
        trustWeight: 1,
      })
    ).status
  ).toBe(201);
  expect(
    (
      await call(b, "POST", "/memory/federation/peers", {
        peerId: a.peerId,
        pinnedCertDer: a.spkiB64,
        trustWeight: 1,
        url: a.baseUrl,
        apiKey: keyForB,
      })
    ).status
  ).toBe(201);

  // The fact, written on Acme at the internal tier and pulled by Larkspur.
  const remembered = await call(a, "POST", "/remember", {
    statement: STATEMENT,
    sensitivity: "internal",
  });
  expect(remembered.status).toBe(201);
  const sync = await call(b, "POST", "/memory/federation/sync", { peerId: a.peerId });
  expect(sync.status).toBe(202);
  const { jobId } = (await sync.json()) as { jobId: string };
  for (let i = 0; i < 50; i++) {
    const job = (await (await call(b, "GET", `/memory/federation/sync/${jobId}`)).json()) as {
      status: string;
    };
    if (job.status === "done") break;
    if (job.status === "failed") throw new Error(`sync failed: ${JSON.stringify(job)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}, 300_000);

afterAll(async () => {
  await a?.close();
  await b?.close();
  await container?.stop().catch(() => void 0);
});

type Hit = { id: string; kind: string; content: string; federation?: unknown };

async function recall(key: string, body: Record<string, unknown> = {}) {
  const res = await call(b, "POST", "/recall", { query: "larkspur orders", ...body }, key);
  expect(res.status).toBe(200);
  return (await res.json()) as { hits: Hit[]; nothingRelevant: boolean };
}

describe("federated items in recall", () => {
  it("the receiver's recall returns the pulled item, marked with its peer and trust 20", async () => {
    const { hits, nothingRelevant } = await recall(b.adminKey);
    const federated = hits.filter((h) => h.federation !== undefined);
    expect(federated).toHaveLength(1);
    expect(federated[0]).toMatchObject({
      kind: "fact",
      content: STATEMENT,
      // The id the receiver registered the peer under, whatever the items claim.
      federation: { peer: "acme.example", trustScore: 20 },
      trust: "untrusted",
    });
    expect(nothingRelevant).toBe(false);
  });

  it("another workspace of the receiver does not see it", async () => {
    const { hits } = await recall(OTHER_KEY);
    expect(hits.filter((h) => h.content === STATEMENT)).toEqual([]);
  });

  it("a key whose ceiling is below the item's tier does not see it", async () => {
    const { hits } = await recall(PUBLIC_KEY);
    expect(hits.filter((h) => h.content === STATEMENT)).toEqual([]);
  });

  it("strict semantic mode does not return it (it has no embedding)", async () => {
    const { hits } = await recall(b.adminKey, { mode: "semantic" });
    expect(hits.filter((h) => h.federation !== undefined)).toEqual([]);
  });
});
