/**
 * Integration test for the P19 Setup Wizard flow.
 *
 * Verifies end-to-end:
 *   1. GET /setup/token → returns { token, expiresAt, setupUrl } when unbootstrapped
 *   2. POST /setup/complete (valid token) → creates mnemo_workspace + mnemo_api_keys rows
 *   3. POST /setup/complete (second call) → 403 (already bootstrapped)
 *   4. GET /setup/token → 404 after bootstrap
 *
 * Requires Docker. Runs under pnpm test:integration.
 * Uses a throwaway pgvector container for full isolation.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Hono } from "hono";
import { mountBootstrap, generateSetupToken } from "../../routes/bootstrap.js";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG_USER = "mnemo";
const PG_PASSWORD = "mnemo";
const PG_DB = "mnemo";

let container: StartedTestContainer;
let pgUrl: string;
let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    // pg_isready already answers during initdb's temporary server, which then restarts
    // ("the database system is starting up"): wait for the second ready line instead.
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  pgUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;
  process.env["DATABASE_URL"] = pgUrl;

  // Run v3 migrations to create mnemosyne schema + mnemo_workspace/mnemo_api_keys
  await execFileAsync("node", [V3_MIGRATE_CLI], {
    env: { ...process.env, DATABASE_URL: pgUrl },
    timeout: 60_000,
  });

  sql = postgres(pgUrl, {
    max: 1,
    connection: { search_path: "mnemosyne,public" },
  });

  // Mount the bootstrap routes
  app = new Hono();
  mountBootstrap(app);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop();
});

describe("Setup wizard integration", () => {
  let activeToken: string;

  it("GET /setup/token returns 200 + token when unbootstrapped", async () => {
    activeToken = generateSetupToken();
    // APP-004: the token is given only to a caller on the server's own
    // loopback (a shell on the host); an in-process request has no socket.
    const res = await app.request("/setup/token", {}, {
      incoming: { socket: { remoteAddress: "127.0.0.1" } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: string; setupUrl: string };
    expect(body.token).toBe(activeToken);
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.setupUrl).toContain(activeToken);
  });

  it("POST /setup/complete creates workspace + api_key rows", async () => {
    // Generate a fresh token (previous one was peeked but not consumed)
    activeToken = generateSetupToken();

    const res = await app.request("/setup/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: activeToken,
        workspaceName: "Integration Test WS",
        llmProvider: "local",
        llmApiKey: "",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: boolean;
      workspaceId: string;
      apiKey: string;
      envSnippet: string;
    };
    expect(body.ok).toBe(true);
    expect(body.apiKey).toMatch(/^mns_live_/);
    expect(body.workspaceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.envSnippet).toContain("MNEMO_KEY=");

    // Verify DB rows
    const workspaceRows = await sql`
      SELECT id FROM mnemosyne.mnemo_workspace WHERE id = ${body.workspaceId}
    `;
    expect(workspaceRows.length).toBe(1);

    const keyRows = await sql`
      SELECT id FROM mnemosyne.mnemo_api_keys WHERE workspace_id = ${body.workspaceId}
    `;
    expect(keyRows.length).toBe(1);
  });

  it("POST /setup/complete second call returns 403 (already bootstrapped)", async () => {
    const newToken = generateSetupToken();
    const res = await app.request("/setup/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: newToken,
        workspaceName: "Another WS",
        llmProvider: "local",
        llmApiKey: "",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("GET /setup/token returns 404 after bootstrap", async () => {
    generateSetupToken(); // put a token in the store
    const res = await app.request("/setup/token");
    expect(res.status).toBe(404);
  });
});
