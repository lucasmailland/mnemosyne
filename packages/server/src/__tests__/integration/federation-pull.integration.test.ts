/**
 * A federation pull between two stock servers, end to end.
 *
 * Boots TWO real server apps in this process, each on its own Postgres database
 * (one testcontainer), each listening on a real loopback port and wired by the
 * real boot path (wireFederation) with its own federation identity. Then:
 *   - A issues B a federation key (POST /admin/keys, federation: true);
 *   - each registers the other through POST /memory/federation/peers;
 *   - a fact is written on A (POST /remember);
 *   - B pulls (POST /memory/federation/sync) and the item lands in B's
 *     mnemo_federated_item, in the workspace that triggered the sync;
 *   - a later sync walks several pages and starts where the last one stopped,
 *     and an update and a forget on A reach B as a new version and a tombstone;
 *   - a hard delete, a purge and a GDPR erasure on A reach B as tombstones too,
 *     but only for a fact B may hold (created before B's previous sync ended and
 *     before the latest fact A served B), whatever knownCursor B sends;
 *   - the gRPC FederationSync RPC is refused, whatever key calls it;
 *   - a new server over B's database still reads that sync job (0063), and a
 *     job its dead process left running reads as failed;
 *   - B asks A to resolve conflicts (POST /memory/federation/resolve), both the
 *     supermajority and the last-write-wins paths, with peer weights taken
 *     from A's registry, never from the body.
 * And the peer gate on A still refuses an unsigned, forged, replayed or
 * wrongly keyed request, and a peer key cannot make A pull.
 *
 * Plain HTTP between the two, so both run with MNEMO_FED_INSECURE_TRANSPORT
 * (refused in production); every other check of the protocol runs.
 * Requires Docker.
 */
import { execFile } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { getRequestListener } from "@hono/node-server";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { signServiceJwt } from "@mnemo-ai/core";
import bcrypt from "bcrypt";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import { wireFederation } from "../../boot/federation.js";
import type { ServerDeps } from "../../deps.js";
import { pullHeaders, federationIdentityFromEnv } from "../../federation/federationIdentity.js";
import { MnemosyneService } from "../../gen/mnemosyne_pb.js";
import { createAuthInterceptor, createMnemosyneRoutes } from "../../grpc.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const ADMIN_SCOPES = [
  "memory:read",
  "memory:write",
  "memory:delete",
  "memory:hard_delete",
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
  deps: ServerDeps;
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
    deps,
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

let keyForB: string;
let syncJobId: string;

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
    adminKey: "mns_live_federationpullacmeadmin0001",
  });
  b = await bootServer({
    host,
    port,
    db: "mnemo_larkspur",
    peerId: "larkspur.example",
    workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01",
    adminKey: "mns_live_federationpulllarkspuradmin1",
  });

  // A issues the key B pulls with; each registers the other.
  const issued = await call(a, "POST", "/admin/keys", {
    label: "larkspur.example pull",
    scopes: ["memory:federation"],
    federation: true,
  });
  expect(issued.status).toBe(201);
  keyForB = ((await issued.json()) as { key: string }).key;
  expect(keyForB).toMatch(/^mk_fed_/);

  const onA = await call(a, "POST", "/memory/federation/peers", {
    peerId: b.peerId,
    pinnedCertDer: b.spkiB64,
    trustWeight: 1,
  });
  expect(onA.status).toBe(201);
  const onB = await call(b, "POST", "/memory/federation/peers", {
    peerId: a.peerId,
    pinnedCertDer: a.spkiB64,
    trustWeight: 1,
    url: a.baseUrl,
    apiKey: keyForB,
  });
  expect(onB.status).toBe(201);
}, 300_000);

afterAll(async () => {
  await a?.close();
  await b?.close();
  await container?.stop().catch(() => void 0);
});

async function waitForJob(server: Booted, jobId: string) {
  for (let i = 0; i < 50; i++) {
    const res = await call(server, "GET", `/memory/federation/sync/${jobId}`);
    const job = (await res.json()) as { status: string; outcome?: unknown; error?: string };
    if (job.status === "done" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("sync job did not finish");
}

describe("federation pull between two servers", () => {
  it("B pulls a fact written on A into the workspace that triggered the sync", async () => {
    const statement = "Acme ships its larkspur orders on Fridays.";
    const remembered = await call(a, "POST", "/remember", { statement });
    expect(remembered.status).toBe(201);

    const sync = await call(b, "POST", "/memory/federation/sync", { peerId: a.peerId });
    expect(sync.status).toBe(202);
    const { jobId } = (await sync.json()) as { jobId: string };
    syncJobId = jobId;
    const job = await waitForJob(b, jobId);
    expect(job).toMatchObject({ status: "done" });
    expect((job.outcome as { itemsProcessed: number }).itemsProcessed).toBeGreaterThanOrEqual(1);

    const dbB = postgres(b.databaseUrl, { max: 1, onnotice: () => void 0 });
    try {
      const rows = await dbB<{ workspace_id: string; statement: string; attribution: string }[]>`
        SELECT workspace_id::text, payload->>'statement' AS statement, attribution
        FROM mnemosyne.mnemo_federated_item`;
      expect(rows).toContainEqual({
        workspace_id: b.workspaceId,
        statement,
        attribution: "federation_received",
      });
    } finally {
      await dbB.end();
    }
  });

  describe("incremental sync over several pages", () => {
    type Job = {
      status: string;
      outcome?: { itemsProcessed: number; cursor?: string; results: unknown[] };
    };
    async function syncB(): Promise<Job> {
      const res = await call(b, "POST", "/memory/federation/sync", { peerId: a.peerId });
      expect(res.status).toBe(202);
      return (await waitForJob(b, ((await res.json()) as { jobId: string }).jobId)) as Job;
    }
    async function onB<T>(q: (db: postgres.Sql) => Promise<T>): Promise<T> {
      const db = postgres(b.databaseUrl, { max: 1, onnotice: () => void 0 });
      try {
        return await q(db);
      } finally {
        await db.end();
      }
    }
    let ids: string[];

    it("pulls only what is new since the last sync, across pages", async () => {
      const dbA = postgres(a.databaseUrl, { max: 1, onnotice: () => void 0 });
      try {
        // 250 facts: more than the 200 a page holds.
        const rows = await dbA<{ id: string }[]>`
          INSERT INTO mnemosyne.mnemo_fact (id, workspace_id, scope, kind, subject, statement)
          SELECT gen_random_uuid()::text, ${a.workspaceId}, 'global', 'other', 'orders',
                 'Larkspur order ' || g
          FROM generate_series(1, 250) g
          RETURNING id`;
        ids = rows.map((r) => r.id);
      } finally {
        await dbA.end();
      }

      const job = await syncB();
      expect(job.status).toBe("done");
      // The fact of the first sync is not pulled again.
      expect(job.outcome?.itemsProcessed).toBe(250);
      expect(job.outcome?.cursor).toEqual(expect.any(String));
      const [{ n }] = await onB(
        (db) => db<{ n: number }[]>`
          SELECT count(*)::int AS n FROM mnemosyne.mnemo_federated_item
          WHERE workspace_id::text = ${b.workspaceId} AND NOT archived`
      );
      expect(n).toBe(251);
    });

    it("an update and a forget on A reach B as a new version and a tombstone", async () => {
      const [updated, forgotten] = [ids[0]!, ids[1]!];
      const patched = await call(a, "PATCH", `/facts/${updated}`, {
        statement: "Larkspur order 1 ships on Mondays.",
      });
      expect(patched.status).toBe(200);
      expect((await call(a, "DELETE", `/facts/${forgotten}`)).status).toBe(204);

      const job = await syncB();
      expect(job.status).toBe("done");
      expect(job.outcome?.results).toEqual([
        { remoteId: updated, outcome: "upserted" },
        { remoteId: forgotten, outcome: "tombstoned" },
      ]);
      const rows = await onB(
        (db) => db<{ remote_id: string; version: number; statement: string; archived: boolean }[]>`
          SELECT remote_id, version::int, payload->>'statement' AS statement, archived
          FROM mnemosyne.mnemo_federated_item
          WHERE remote_id IN (${updated}, ${forgotten}) ORDER BY version DESC`
      );
      expect(rows).toEqual([
        {
          remote_id: updated,
          version: 2,
          statement: "Larkspur order 1 ships on Mondays.",
          archived: false,
        },
        { remote_id: forgotten, version: 1, statement: "Larkspur order 2", archived: true },
      ]);
    });

    it("a hard delete on A reaches B as a tombstone, only for a fact B may hold", async () => {
      const pulled = ids[2]!;
      // Created after B's last sync and deleted before the next: B never saw it,
      // and must not learn it existed.
      const dbA = postgres(a.databaseUrl, { max: 1, onnotice: () => void 0 });
      const [{ id: unseen }] = await dbA<{ id: string }[]>`
        INSERT INTO mnemosyne.mnemo_fact (id, workspace_id, scope, kind, subject, statement)
        VALUES (gen_random_uuid()::text, ${a.workspaceId}, 'global', 'other', 'orders',
                'Larkspur order 999')
        RETURNING id`;
      await dbA.end();
      for (const id of [pulled, unseen]) {
        expect((await call(a, "DELETE", `/facts/${id}/hard`)).status).toBe(200);
      }

      const job = await syncB();
      expect(job.status).toBe("done");
      expect(job.outcome?.results).toEqual([{ remoteId: pulled, outcome: "tombstoned" }]);
      // The tombstone of a fact deleted outright carries version 0, below the
      // copy's 1: a tombstone from the origin archives whatever the version.
      const rows = await onB(
        (db) => db<{ version: number; archived: boolean }[]>`
          SELECT version::int, archived FROM mnemosyne.mnemo_federated_item
          WHERE remote_id = ${pulled}`
      );
      expect(rows).toEqual([{ version: 1, archived: true }]);
    });

    it("a purge and a GDPR erasure on A reach B as tombstones", async () => {
      const [purged, erased] = [ids[3]!, ids[4]!];
      expect((await call(a, "DELETE", `/facts/${purged}`)).status).toBe(204);
      expect((await call(a, "DELETE", "/facts/purge")).status).toBe(200);

      // The hard mode of forget(), through A's own core, with a key to destroy.
      const actorId = "key:acme-dpo";
      const dbA = postgres(a.databaseUrl, { max: 1, onnotice: () => void 0 });
      await dbA`
        INSERT INTO mnemosyne.mnemo_actor_dek (id, workspace_id, actor_id, encrypted_key)
        VALUES ('dek-acme-dpo', ${a.workspaceId}, ${actorId}, '\\x00'::bytea)`;
      await dbA.end();
      await a.deps.cognitive.forget(erased, "fact", "hard", {
        workspaceId: a.workspaceId,
        actorId,
        actorType: "agent",
        scopes: ["memory:hard_delete"],
      });

      const job = await syncB();
      expect(job.status).toBe("done");
      // The purge also deletes the fact forgotten earlier, whose tombstone B
      // already applied: B refuses it again (resurrection guard).
      expect(job.outcome?.results).toEqual(
        expect.arrayContaining([
          { remoteId: purged, outcome: "tombstoned" },
          { remoteId: erased, outcome: "tombstoned" },
        ])
      );
      const rows = await onB(
        (db) => db<{ archived: boolean }[]>`
          SELECT archived FROM mnemosyne.mnemo_federated_item
          WHERE remote_id IN (${purged}, ${erased})`
      );
      expect(rows).toEqual([{ archived: true }, { archived: true }]);
    });

    it("a sync with nothing new on A applies nothing", async () => {
      const job = await syncB();
      expect(job).toMatchObject({ status: "done", outcome: { itemsProcessed: 0 } });
    });
  });

  describe("gRPC FederationSync", () => {
    async function federationSync(key?: string): Promise<Code | "ok"> {
      const transport = createRouterTransport((r) => createMnemosyneRoutes(r, a.deps), {
        router: { interceptors: [createAuthInterceptor(a.deps)] },
      });
      const headers: Record<string, string> = {
        ...pullHeaders(
          federationIdentityFromEnv({
            MNEMO_FED_PEER_ID: b.peerId,
            MNEMO_FEDERATION_PRIVATE_KEY: b.privatePem,
          })!,
          a.peerId
        ),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      };
      const items = [
        {
          remoteId: "aaaaaaaa-0000-4000-8000-000000000001",
          version: 1,
          peerDomain: b.peerId,
          payload: { statement: "pushed" },
        },
      ];
      async function* one() {
        yield { peerId: b.peerId, delta: new TextEncoder().encode(JSON.stringify(items)) };
      }
      try {
        for await (const _ of createClient(MnemosyneService, transport).federationSync(one(), {
          headers,
        })) {
          /* drain */
        }
        return "ok";
      } catch (err) {
        return ConnectError.from(err).code;
      }
    }

    it("is refused without credentials, with B's peer key and with A's own admin key", async () => {
      expect(await federationSync()).toBe(Code.Unauthenticated);
      expect(await federationSync(keyForB)).not.toBe("ok");
      expect(await federationSync(a.adminKey)).toBe(Code.Unimplemented);

      const db = postgres(a.databaseUrl, { max: 1, onnotice: () => void 0 });
      try {
        const rows = await db`SELECT 1 FROM mnemosyne.mnemo_federated_item`;
        expect(rows).toHaveLength(0);
      } finally {
        await db.end();
      }
    });
  });

  describe("A's peer gate still refuses", () => {
    const identityB = () =>
      federationIdentityFromEnv({
        MNEMO_FED_PEER_ID: b.peerId,
        MNEMO_FEDERATION_PRIVATE_KEY: b.privatePem,
      })!;

    function items(headers: Record<string, string>, key = keyForB) {
      return fetch(`${a.baseUrl}/memory/federation/items`, {
        headers: { authorization: `Bearer ${key}`, ...headers },
      });
    }

    it("a request signed correctly is served (control)", async () => {
      expect((await items(pullHeaders(identityB(), a.peerId))).status).toBe(200);
    });

    it("a forged cursor reads from the start instead of failing", async () => {
      const forged = Buffer.from(JSON.stringify({ v: "not a time", id: "x" })).toString(
        "base64url"
      );
      const res = await fetch(`${a.baseUrl}/memory/federation/items?limit=1&cursor=${forged}`, {
        headers: { authorization: `Bearer ${keyForB}`, ...pullHeaders(identityB(), a.peerId) },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1);
    });

    it("a knownCursor in the future reveals only facts A served B", async () => {
      const get = async (query: string) => {
        const res = await fetch(`${a.baseUrl}/memory/federation/items?${query}`, {
          headers: { authorization: `Bearer ${keyForB}`, ...pullHeaders(identityB(), a.peerId) },
        });
        expect(res.status).toBe(200);
        return ((await res.json()) as { items: { remoteId: string; deletedAt?: string }[] }).items;
      };
      const insert = async (statement: string) => {
        const dbA = postgres(a.databaseUrl, { max: 1, onnotice: () => void 0 });
        try {
          const [{ id, at }] = await dbA<{ id: string; at: Date }[]>`
            INSERT INTO mnemosyne.mnemo_fact (id, workspace_id, scope, kind, subject, statement)
            VALUES (gen_random_uuid()::text, ${a.workspaceId}, 'global', 'other', 'orders',
                    ${statement})
            RETURNING id, created_at AS at`;
          return { id, at };
        } finally {
          await dbA.end();
        }
      };
      const seen = await insert("Larkspur order 1001");
      const since = new Date(seen.at.getTime() - 1).toISOString();
      // A serves B the first one; B never sees the second.
      expect((await get(`since=${since}`)).map((i) => i.remoteId)).toEqual([seen.id]);
      const unseen = await insert("Larkspur order 1002");
      for (const { id } of [seen, unseen]) {
        expect((await call(a, "DELETE", `/facts/${id}`)).status).toBe(204);
      }

      const future = Buffer.from(
        JSON.stringify({ v: "2099-01-01T00:00:00.000000Z", id: "z" })
      ).toString("base64url");
      const served = await get(`since=${since}&knownCursor=${future}`);
      expect(served).toEqual([
        expect.objectContaining({ remoteId: seen.id, deletedAt: expect.any(String) }),
      ]);
    });

    it("an unsigned request, even with B's key and B's public key", async () => {
      const { "x-mnemo-service-jwt": _jwt, ...unsigned } = pullHeaders(identityB(), a.peerId);
      expect((await items(unsigned)).status).toBe(403);
    });

    it("a JWT signed by someone else claiming to be B", async () => {
      const intruder = generateKeyPairSync("ed25519").privateKey;
      const headers = {
        ...pullHeaders(identityB(), a.peerId),
        "x-mnemo-service-jwt": signServiceJwt(intruder, {
          iss: b.peerId,
          aud: a.peerId,
          workspaceScope: [],
        }),
      };
      expect((await items(headers)).status).toBe(403);
    });

    it("a replayed JWT", async () => {
      const headers = pullHeaders(identityB(), a.peerId);
      expect((await items(headers)).status).toBe(200);
      expect((await items(headers)).status).toBe(403);
    });

    it("a JWT made for another server", async () => {
      expect((await items(pullHeaders(identityB(), "other.example"))).status).toBe(403);
    });

    it("a valid signature with a key that is not an mk_fed_ key", async () => {
      expect((await items(pullHeaders(identityB(), a.peerId), a.adminKey)).status).toBe(403);
    });

    it("B's federation key cannot make A pull", async () => {
      const res = await call(a, "POST", "/memory/federation/sync", { peerId: b.peerId }, keyForB);
      expect(res.status).toBe(403);
    });
  });
});

describe("sync jobs survive a restart (0063)", () => {
  let restarted: Booted;

  beforeAll(async () => {
    // A new server over B's database, as after a restart of B.
    restarted = await startApp({
      peerId: b.peerId,
      databaseUrl: b.databaseUrl,
      workspaceId: b.workspaceId,
      adminKey: b.adminKey,
      privatePem: b.privatePem,
    });
  }, 120_000);

  afterAll(async () => {
    await restarted?.close();
  });

  it("the new server reads the finished sync job", async () => {
    expect(syncJobId).toBeDefined();
    const res = await call(restarted, "GET", `/memory/federation/sync/${syncJobId}`);
    expect(res.status).toBe(200);
    const job = (await res.json()) as { status: string; outcome?: { itemsProcessed: number } };
    expect(job).toMatchObject({ id: syncJobId, peerId: a.peerId, status: "done" });
    expect(job.outcome?.itemsProcessed).toBeGreaterThanOrEqual(1);
  });

  it("a job left running by the dead process reads as failed, with the reason", async () => {
    const db = postgres(b.databaseUrl, { max: 1, onnotice: () => void 0 });
    try {
      await db`
        INSERT INTO mnemosyne.mnemo_federation_sync_job
          (id, workspace_id, peer_id, status, started_at, heartbeat_at)
        VALUES ('orphaned-sync-job', ${b.workspaceId}, ${a.peerId}, 'running',
                '2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z')`;
    } finally {
      await db.end();
    }
    const res = await call(restarted, "GET", "/memory/federation/sync/orphaned-sync-job");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/server stopped before this sync finished/),
    });
  });
});

describe("conflict resolution between two servers (POST /memory/federation/resolve)", () => {
  const identityB = () =>
    federationIdentityFromEnv({
      MNEMO_FED_PEER_ID: b.peerId,
      MNEMO_FEDERATION_PRIVATE_KEY: b.privatePem,
    })!;

  // B asks A, signed as B with the key A issued it.
  function resolveOnA(body: unknown, headers = pullHeaders(identityB(), a.peerId)) {
    return fetch(`${a.baseUrl}/memory/federation/resolve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${keyForB}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    // A trusts this peer with weight 0.
    const untrusted = generateKeyPairSync("ed25519")
      .publicKey.export({ format: "der", type: "spki" })
      .toString("base64");
    const res = await call(a, "POST", "/memory/federation/peers", {
      peerId: "untrusted.example",
      pinnedCertDer: untrusted,
      trustWeight: 0,
    });
    expect(res.status).toBe(201);
  });

  it("refuses an unsigned request", async () => {
    const { "x-mnemo-service-jwt": _jwt, ...unsigned } = pullHeaders(identityB(), a.peerId);
    const res = await resolveOnA({ items: [{ version: "v1", peerId: b.peerId }] }, unsigned);
    expect(res.status).toBe(403);
  });

  it("supermajority: weights come from A's registry, not from the body", async () => {
    // Registered weights: larkspur 1, untrusted 0. Were the body's trustWeight
    // used, v2 would tie v1 and there would be no consensus.
    const res = await resolveOnA({
      items: [
        { version: "v1", peerId: b.peerId, trustWeight: 0 },
        { version: "v2", peerId: "untrusted.example", trustWeight: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      strategy: "supermajority",
      outcome: { status: "winner", version: "v1", confidence: 1 },
    });
  });

  it("supermajority: a peer A gives weight 0 cannot win by claiming more", async () => {
    const res = await resolveOnA({
      items: [{ version: "v2", peerId: "untrusted.example", trustWeight: 1 }],
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome: unknown }).outcome).toEqual({
      status: "rejected",
      reason: "all claims have zero weight",
    });
  });

  it("last write wins, and a federated winner's trust score is capped at 20", async () => {
    const itemA = {
      id: "fact-1",
      version: 1,
      updatedAt: "2026-01-02T00:00:00.000Z",
      attribution: "federation_received",
      trustScore: 90,
    };
    const itemB = { ...itemA, version: 2, updatedAt: "2026-01-01T00:00:00.000Z" };
    const res = await resolveOnA({ itemA, itemB });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      strategy: "last_write_wins",
      winner: { ...itemA, trustScore: 20 },
      loser: itemB,
    });
  });
});
