/**
 * Federation behind a real TLS-terminating proxy with mTLS.
 *
 * A real nginx (testcontainers) terminates TLS with a client certificate
 * required and forwards to a stock server (MNEMO_FED_TLS_PROXY=true,
 * MNEMO_TRUSTED_PROXY_IP = the address nginx connects from), setting
 * x-mnemo-tls-protocol from $ssl_protocol and x-mnemo-client-cert from
 * $ssl_client_escaped_cert (the verified certificate as URL-encoded PEM).
 * The test CA, the server certificate and the peer's client certificate are
 * generated inside the container with its openssl; the peer's client
 * certificate carries its Ed25519 federation key, the key the server pins.
 *
 * Listener 8443 is the documented setup (TLS 1.3 only). Listener 8444 also
 * lets TLS 1.2 through, to show the server refuses it on its own.
 *
 * The peer is also a second stock server (larkspur.example, its own database)
 * that pulls through nginx with POST /memory/federation/sync, presenting its
 * client certificate from MNEMO_FED_CLIENT_CERT_FILE / _KEY_FILE and checking
 * nginx against MNEMO_FED_CA_FILE; booted without the certificate, its job fails.
 * Requires Docker.
 */
import { execFile } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type RequestListener, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { federationIdentityFromEnv, pullHeaders } from "../../federation/federationIdentity.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const NGINX_IMAGE = "nginx:1.27.5";
const SELF_ID = "acme.example";
const PEER_ID = "larkspur.example";
const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02";
const ADMIN_KEY = "mns_live_federationtlsproxyacmeadmin1";
const CERTS = "/etc/nginx/certs";

// The test CA, nginx's server certificate, the peer's client certificate and
// a second client certificate from the same CA with a key nobody pinned.
const GENERATE_CERTS = `set -e
mkdir -p ${CERTS} && cd ${CERTS}
openssl genpkey -algorithm ed25519 -out ca.key
openssl req -x509 -new -key ca.key -subj /CN=mnemo-test-ca -days 1 -out ca.crt
printf 'subjectAltName=DNS:localhost' > san.ext
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out server.key
openssl req -new -key server.key -subj /CN=localhost -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 1 -extfile san.ext -out server.crt
for c in client stranger; do
  openssl genpkey -algorithm ed25519 -out $c.key
  openssl req -new -key $c.key -subj /CN=$c -out $c.csr
  openssl x509 -req -in $c.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 1 -out $c.crt
done
exec nginx -g 'daemon off;'`;

function nginxConf(upstreamPort: number): string {
  const location = `
    location / {
      proxy_pass http://host.docker.internal:${upstreamPort};
      proxy_set_header X-Mnemo-Tls-Protocol $ssl_protocol;
      proxy_set_header X-Mnemo-Client-Cert $ssl_client_escaped_cert;
    }`;
  return `events {}
http {
  error_log /dev/stderr notice;
  access_log off;
  ssl_certificate ${CERTS}/server.crt;
  ssl_certificate_key ${CERTS}/server.key;
  ssl_client_certificate ${CERTS}/ca.crt;
  ssl_verify_client on;
  server { listen 8443 ssl; ssl_protocols TLSv1.3; ${location} }
  server { listen 8444 ssl; ssl_protocols TLSv1.2 TLSv1.3; ${location} }
}`;
}

interface Reply {
  status: number;
  body: string;
}

let pg: StartedTestContainer;
let nginx: StartedTestContainer;
let server: Server;
let serverPort: number;
let proxyIp: string;
let close: () => Promise<void>;
let ca: string;
let client: { key: string; cert: string };
let stranger: { key: string; cert: string };
let fedKey: string;

async function readFromNginx(path: string): Promise<string> {
  const { exitCode, stdout } = await nginx.exec(["cat", path]);
  if (exitCode !== 0) throw new Error(`cannot read ${path}`);
  return stdout;
}

/** Migrate a fresh database and give it an admin key. */
async function prepareDatabase(databaseUrl: string) {
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
  await seed`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${"key_admin_tls"}, ${WORKSPACE_ID}, ${await bcrypt.hash(ADMIN_KEY, BCRYPT_COST)},
            ${"admin"}, ${"admin"},
            ${"{memory:read,memory:write,memory:federation,federation:admin,admin:keys}"}::text[])
  `;
  await seed.end();
}

/** Boot one stock server over a prepared database, wired by the real boot path. */
async function bootServer(databaseUrl: string, env: Record<string, string>) {
  const coreMod = await import("@mnemo-ai/core");
  const adapterPgMod = await import("@mnemo-ai/adapter-postgres");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl });
  const { db, pgClient } = adapterPgMod.createDrizzleClient(databaseUrl);
  const storage = new adapterPgMod.DrizzleStorageAdapter(db, pgClient, undefined);
  const span = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const telemetry = {
    startSpan: () => span,
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
  const metricsPgClient = postgres(databaseUrl, { max: 5, onnotice: () => void 0 });
  const deps = {
    apiKeys,
    storage,
    llm: undefined,
    embedModel: "fake-model",
    telemetry,
    metricsPgClient,
  } as unknown as ServerDeps;
  await wireFederation({ databaseUrl, deps, env });
  expect(deps.federation).toBeDefined();
  if (env.MNEMO_TRUSTED_PROXY_IP) {
    expect(deps.federation?.transport?.trustedProxyIp).toBe(env.MNEMO_TRUSTED_PROXY_IP);
  }
  const app = createApp({ deps, version: "federation-tls-proxy" });
  return {
    listener: getRequestListener(app.fetch),
    async close() {
      await apiKeys.close?.().catch(() => void 0);
      await metricsPgClient.end({ timeout: 2 }).catch(() => void 0);
    },
  };
}

function admin(method: string, path: string, body?: unknown, port = serverPort) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** A signed pull of /memory/federation/items as the peer. */
function peerHeaders(): Record<string, string> {
  const identity = federationIdentityFromEnv({
    MNEMO_FED_PEER_ID: PEER_ID,
    MNEMO_FEDERATION_PRIVATE_KEY: client.key,
  })!;
  return { authorization: `Bearer ${fedKey}`, ...pullHeaders(identity, SELF_ID) };
}

function viaProxy(opts: {
  listener: 8443 | 8444;
  tls: "TLSv1.2" | "TLSv1.3";
  as?: { key: string; cert: string };
  headers: Record<string, string>;
}): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = httpsRequest(
      {
        host: nginx.getHost(),
        port: nginx.getMappedPort(opts.listener),
        servername: "localhost",
        path: "/memory/federation/items",
        ca,
        ...(opts.as ? { key: opts.as.key, cert: opts.as.cert } : {}),
        minVersion: opts.tls,
        maxVersion: opts.tls,
        agent: false,
        headers: opts.headers,
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => done({ status: res.statusCode!, body }));
      }
    );
    req.on("error", fail);
    req.end();
  });
}

/** A local address that is not the proxy's, so a direct call is told apart. */
function directAddress(): string {
  if (proxyIp !== "127.0.0.1") return "127.0.0.1";
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal);
  if (!lan) throw new Error("no non-loopback IPv4 address to call the server directly from");
  return lan.address;
}

beforeAll(async () => {
  // The server listens first, so nginx can be pointed at its port; until the
  // app is attached it answers with the caller's address (the probe below).
  let handler: RequestListener = (req, res) =>
    res.end(req.socket.remoteAddress?.replace(/^::ffff:/, ""));
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((res) => server.listen(0, "0.0.0.0", res));
  serverPort = (server.address() as { port: number }).port;

  [pg, nginx] = await Promise.all([
    new GenericContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_USER: "mnemo", POSTGRES_PASSWORD: "mnemo", POSTGRES_DB: "mnemo" })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start(),
    new GenericContainer(NGINX_IMAGE)
      .withExtraHosts([{ host: "host.docker.internal", ipAddress: "host-gateway" }])
      .withCopyContentToContainer([
        { content: nginxConf(serverPort), target: "/etc/nginx/nginx.conf" },
      ])
      .withEntrypoint(["sh", "-c", GENERATE_CERTS])
      .withExposedPorts(8443, 8444)
      .start(),
  ]);

  const probe = await nginx.exec(["curl", "-sf", `http://host.docker.internal:${serverPort}/`]);
  expect(probe.exitCode).toBe(0);
  proxyIp = probe.stdout.trim();

  ca = await readFromNginx(`${CERTS}/ca.crt`);
  client = {
    key: await readFromNginx(`${CERTS}/client.key`),
    cert: await readFromNginx(`${CERTS}/client.crt`),
  };
  stranger = {
    key: await readFromNginx(`${CERTS}/stranger.key`),
    cert: await readFromNginx(`${CERTS}/stranger.crt`),
  };

  const acmeDb = `postgres://mnemo:mnemo@${pg.getHost()}:${pg.getMappedPort(5432)}/mnemo`;
  await prepareDatabase(acmeDb);
  const booted = await bootServer(acmeDb, {
    MNEMO_FED_PEER_ID: SELF_ID,
    MNEMO_FED_TLS_PROXY: "true",
    MNEMO_TRUSTED_PROXY_IP: proxyIp,
  });
  handler = booted.listener;
  close = booted.close;

  // Acme issues the peer a federation key and pins the key in its client cert.
  const issued = await admin("POST", "/admin/keys", {
    label: `${PEER_ID} pull`,
    scopes: ["memory:federation"],
    federation: true,
  });
  expect(issued.status).toBe(201);
  fedKey = ((await issued.json()) as { key: string }).key;
  const pinned = createPublicKey(client.key).export({ format: "der", type: "spki" });
  const peer = await admin("POST", "/memory/federation/peers", {
    peerId: PEER_ID,
    pinnedCertDer: pinned.toString("base64"),
    trustWeight: 1,
  });
  expect(peer.status).toBe(201);
}, 300_000);

afterAll(async () => {
  for (const p of pullers) await p.close();
  await close?.();
  await new Promise<void>((res) => (server ? server.close(() => res()) : res()));
  await nginx?.stop().catch(() => void 0);
  await pg?.stop().catch(() => void 0);
});

describe("federation behind nginx with mTLS", () => {
  it("a signed pull with the peer's client certificate goes through", async () => {
    // The client sends no cert or TLS header of its own: the 200 rests on
    // what nginx forwarded (TLS 1.3 and the certificate as URL-encoded PEM).
    const {
      "x-mnemo-client-cert": _own,
      "x-mnemo-tls-protocol": _none,
      ...headers
    } = peerHeaders() as Record<string, string>;
    const res = await viaProxy({ listener: 8443, tls: "TLSv1.3", as: client, headers });
    expect(res.status).toBe(200);
  });

  it("without a client certificate the proxy cuts the request", async () => {
    const res = await viaProxy({ listener: 8443, tls: "TLSv1.3", headers: peerHeaders() });
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/No required SSL certificate/);
  });

  it("a certificate from the same CA whose key is not the pinned one is refused", async () => {
    const res = await viaProxy({
      listener: 8443,
      tls: "TLSv1.3",
      as: stranger,
      headers: peerHeaders(),
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/cert pin mismatch/);
  });

  it("forcing TLS 1.2 fails the handshake on the TLS 1.3 listener", async () => {
    await expect(
      viaProxy({ listener: 8443, tls: "TLSv1.2", as: client, headers: peerHeaders() })
    ).rejects.toThrow();
  });

  it("TLS 1.2 through a proxy that lets it through is refused by the server", async () => {
    // The client claims TLS 1.3 itself; nginx overwrites the header with TLSv1.2.
    const res = await viaProxy({
      listener: 8444,
      tls: "TLSv1.2",
      as: client,
      headers: { ...peerHeaders(), "x-mnemo-tls-protocol": "TLSv1.3" },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/TLS 1\.3 is mandatory .*got TLSv1\.2/);
  });

  it("a client that skips the proxy and writes its headers by hand does not get in", async () => {
    const from = directAddress();
    const res = await new Promise<Reply>((done, fail) => {
      const req = httpRequest(
        {
          host: from,
          localAddress: from,
          port: serverPort,
          path: "/memory/federation/items",
          agent: false,
          headers: {
            ...peerHeaders(),
            "x-mnemo-tls-protocol": "TLSv1.3",
            "x-forwarded-for": proxyIp,
          },
        },
        (r) => {
          let body = "";
          r.on("data", (d) => (body += d));
          r.on("end", () => done({ status: r.statusCode!, body }));
        }
      );
      req.on("error", fail);
      req.end();
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/no client certificate/);
  });
});

interface Puller {
  port: number;
  databaseUrl: string;
  close(): Promise<void>;
}
const pullers: Puller[] = [];

/** larkspur.example as a stock server listening on loopback, booted with `env`. */
async function bootPuller(databaseUrl: string, env: Record<string, string>): Promise<Puller> {
  const booted = await bootServer(databaseUrl, {
    MNEMO_FED_PEER_ID: PEER_ID,
    MNEMO_FEDERATION_PRIVATE_KEY: client.key,
    ...env,
  });
  const listening = createServer(booted.listener);
  await new Promise<void>((res) => listening.listen(0, "127.0.0.1", res));
  const puller = {
    port: (listening.address() as { port: number }).port,
    databaseUrl,
    async close() {
      await new Promise<void>((res) => listening.close(() => res()));
      await booted.close();
    },
  };
  pullers.push(puller);
  return puller;
}

async function syncFromAcme(puller: Puller) {
  const sync = await admin("POST", "/memory/federation/sync", { peerId: SELF_ID }, puller.port);
  expect(sync.status).toBe(202);
  const { jobId } = (await sync.json()) as { jobId: string };
  for (let i = 0; i < 50; i++) {
    const res = await admin("GET", `/memory/federation/sync/${jobId}`, undefined, puller.port);
    const job = (await res.json()) as {
      status: string;
      error?: string;
      outcome?: { itemsProcessed: number };
    };
    if (job.status === "done" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("sync job did not finish");
}

describe("larkspur's own server pulls from acme through nginx", () => {
  const statement = "Larkspur Robotics restocks Acme every Tuesday.";
  let withCert: Puller;
  let withoutCert: Puller;

  beforeAll(async () => {
    const root = postgres(
      `postgres://mnemo:mnemo@${pg.getHost()}:${pg.getMappedPort(5432)}/mnemo`,
      { max: 1, onnotice: () => void 0 }
    );
    await root`
      INSERT INTO mnemosyne.mnemo_fact (id, workspace_id, scope, kind, subject, statement, status)
      VALUES ('fact_tls_pull', ${WORKSPACE_ID}, 'global', 'preference', 'restock', ${statement},
              'active')`;
    await root.unsafe("CREATE DATABASE mnemo_larkspur");
    await root.end();
    const larkspurDb = `postgres://mnemo:mnemo@${pg.getHost()}:${pg.getMappedPort(5432)}/mnemo_larkspur`;
    await prepareDatabase(larkspurDb);

    const dir = mkdtempSync(join(tmpdir(), "mnemo-fed-tls-"));
    const file = (name: string, content: string) => {
      writeFileSync(join(dir, name), content);
      return join(dir, name);
    };
    const caFile = file("ca.crt", ca);
    withCert = await bootPuller(larkspurDb, {
      MNEMO_FED_CLIENT_CERT_FILE: file("client.crt", client.cert),
      MNEMO_FED_CLIENT_KEY_FILE: file("client.key", client.key),
      MNEMO_FED_CA_FILE: caFile,
    });
    // Trusts nginx's certificate, so the only thing missing is its own.
    withoutCert = await bootPuller(larkspurDb, { MNEMO_FED_CA_FILE: caFile });

    // Larkspur registers acme at nginx's TLS 1.3 listener with the key acme
    // issued it. Acme never pulls from larkspur here, so any pinned key does.
    const acmeKey = generateKeyPairSync("ed25519").publicKey.export({
      format: "der",
      type: "spki",
    });
    const peer = await admin(
      "POST",
      "/memory/federation/peers",
      {
        peerId: SELF_ID,
        pinnedCertDer: acmeKey.toString("base64"),
        trustWeight: 1,
        url: `https://localhost:${nginx.getMappedPort(8443)}`,
        apiKey: fedKey,
      },
      withCert.port
    );
    expect(peer.status).toBe(201);
  }, 300_000);

  it("with its client certificate the sync job is done and the fact lands", async () => {
    const job = await syncFromAcme(withCert);
    expect(job).toMatchObject({ status: "done" });
    expect(job.outcome!.itemsProcessed).toBeGreaterThanOrEqual(1);

    const db = postgres(withCert.databaseUrl, { max: 1, onnotice: () => void 0 });
    try {
      const rows = await db<{ statement: string }[]>`
        SELECT payload->>'statement' AS statement FROM mnemosyne.mnemo_federated_item`;
      expect(rows.map((r) => r.statement)).toContain(statement);
    } finally {
      await db.end();
    }
  });

  it("without it nginx cuts the pull and the job fails", async () => {
    const job = await syncFromAcme(withoutCert);
    expect(job).toMatchObject({ status: "failed" });
    expect(job.error).toMatch(/Federation pull failed: 400/);
  });
});
