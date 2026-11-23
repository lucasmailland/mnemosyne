/**
 * Real Postgres, real auth middleware, NOSUPERUSER non-BYPASSRLS app role.
 *
 * 1. With the scoped scheme on (MNEMO_SCOPED_AUTH=1 wires ScopedApiKeyAdapter
 *    over DrizzleApiKeyStore, as index.ts does), the mk_* keys POST /admin/keys
 *    mints still authenticate, and a scoped-scheme key still goes to the adapter.
 * 2. POST /admin/erasure crypto-erases one actor: before it the actor's
 *    confidential fact decrypts with its DEK, after it no key exists to decrypt
 *    it, the row keeps only ciphertext, and both audit entries are written.
 * 3. Reads open encrypted facts: a confidential fact reads back as plaintext by
 *    GET and by recall for a credential whose ceiling allows it, stays hidden
 *    from a lower ceiling, and after erasure reads as `[erased]` (recall drops it).
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import bcrypt from "bcrypt";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decryptEncryptedField } from "../../../../adapter-postgres/src/encryption/fact-cryptor.js";
import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import { hashSecret } from "../../auth/hash.js";
import { ScopedApiKeyAdapter } from "../../auth/ScopedApiKeyAdapter.js";
import type { ServerDeps } from "../../deps.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG_USER = "mnemo_super_authgdpr";
const PG_PASSWORD = "mnemo_super_authgdpr";
const PG_DB = "mnemo_test_authgdpr";
const APP_ROLE = "authgdpr_app";
const APP_PASSWORD = "authgdpr_app_pass";

const TENANT_ID = "tenant-authgdpr";
const WS = "9c1f9c00-0000-4000-8000-0000000000b4";
const KEY_OWNER = "mns_live_authgdprownerkey000000001";
const KEY_OWNER_ID = "key_authgdpr_owner";
const OWNER_SCOPES = [
  "memory:read",
  "memory:write",
  "memory:hard_delete",
  "memory:federation",
  "admin:keys",
  "memory:admin",
];

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
/** Same deps, with the write-time conflict classifier on (see the last describe). */
let appConflicts: ReturnType<typeof createApp>;
const CONFLICT_DIM = 11;
/** Every prompt the stub LLM provider received: what left the process. */
const llmPrompts: string[] = [];
let storage: import("@mnemo-ai/adapter-postgres").DrizzleStorageAdapter;
let vector: import("@mnemo-ai/adapter-vector").PgVectorAdapter;
const savedCeiling = process.env.MNEMO_SENSITIVITY_CEILING;

function authed(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

async function mint(body: object): Promise<{ id: string; key: string }> {
  const res = await app.request("/admin/keys", {
    method: "POST",
    headers: authed(KEY_OWNER),
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; key: string };
}

beforeAll(async () => {
  // The suite writes a confidential fact; the default ceiling would refuse it.
  process.env.MNEMO_SENSITIVITY_CEILING = "restricted";
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  const bootstrap = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await bootstrap.end();
  }
  await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", superUrl],
    { timeout: 120_000 }
  );
  const { stdout: v3Out } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: superUrl },
  });
  expect(v3Out).toContain("Done. Applied:");

  admin = postgres(superUrl, { max: 2, onnotice: () => void 0 });
  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT app_user       TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);
  await admin`INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Acme"})`;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Acme workspace"}, ${"acme-authgdpr"}, ${TENANT_ID})
  `;
  const ownerHash = await bcrypt.hash(KEY_OWNER, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${KEY_OWNER_ID}, ${WS}, ${ownerHash}, ${"owner"}, ${"owner"}, ${admin.array(OWNER_SCOPES)})
  `;

  const appUrl = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${PG_DB}`;
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  apiKeyLookupClose = apiKeys.close;

  const [adapterPgMod, adapterVectorMod, v3CoreMod] = await Promise.all([
    import("@mnemo-ai/adapter-postgres"),
    import("@mnemo-ai/adapter-vector"),
    import("@mnemo-ai/core/cognitive"),
  ]);
  const DIMS = 1536;
  const fakeEmbed: import("@mnemo-ai/types").EmbedAdapter = {
    id: "fake-embed",
    model: "fake-model",
    dimensions: DIMS,
    async embed(texts) {
      return texts.map(() => new Float32Array(DIMS));
    },
    async embedSingle() {
      return new Float32Array(DIMS);
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };
  // Trivial base64 "wrap": this suite proves which key is destroyed, not the
  // wrap crypto (see actor-dek-user-id.integration).
  const dekProvisioner = () => {
    const dek = randomBytes(32);
    return { dek, wrapped: dek.toString("base64") };
  };
  const dekUnwrapper = (_ws: string, _actor: string, wrapped: string) =>
    Buffer.from(wrapped, "base64");
  const { db: v3Db, pgClient: v3Pg } = adapterPgMod.createDrizzleClient(appUrl);
  storage = new adapterPgMod.DrizzleStorageAdapter(v3Db, v3Pg, dekUnwrapper, dekProvisioner);
  vector = new adapterVectorMod.PgVectorAdapter({ connectionString: appUrl });
  const noopLogger: import("@mnemo-ai/types").Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: function () {
      return this;
    },
  };
  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const noopTelemetry = {
    startSpan: () => noopSpan,
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
  const outbox: import("@mnemo-ai/types").OutboxAdapter = {
    append: (e) => storage.appendOutbox(e),
    claimBatch: (n) => storage.claimOutbox(n),
    markProcessed: (ids) => storage.markOutboxProcessed(ids),
    markFailed: (id, err) => storage.markOutboxFailed(id, err),
    getStats: async () => ({ pending: 0, failed: 0, oldestPendingMs: 0 }),
  };
  const cognitive = v3CoreMod.createCore({
    storage,
    vector,
    embed: fakeEmbed,
    outbox,
    logger: noopLogger,
    telemetry: noopTelemetry,
  });
  // As index.ts builds it under MNEMO_SCOPED_AUTH=1.
  const { db: scopedDb } = adapterPgMod.createDrizzleClient(superUrl);
  const scopedAuthAdapter = new ScopedApiKeyAdapter({
    store: new adapterPgMod.DrizzleApiKeyStore(scopedDb),
  });

  const deps: ServerDeps = {
    storage,
    apiKeys,
    scopedAuthAdapter,
    cognitive,
    llm: undefined,
    embedModel: "fake-model",
    telemetry: noopTelemetry,
    metricsPgClient: postgres(appUrl, { max: 5, onnotice: () => void 0 }),
  } as unknown as ServerDeps;
  app = createApp({ deps, version: "authgdpr-test" });

  // Every text embeds to the same unit vector, so every stored fact with that
  // vector is a semantic candidate; the stub classifier calls two "Acme vault
  // opens at" statements a contradiction. It only can when it gets plaintext.
  const unit = () => {
    const v = new Float32Array(DIMS);
    v[CONFLICT_DIM] = 1;
    return v;
  };
  const unitEmbed: import("@mnemo-ai/types").EmbedAdapter = {
    ...fakeEmbed,
    async embed(texts) {
      return texts.map(unit);
    },
    async embedSingle() {
      return unit();
    },
  };
  const classifyingLlm: import("@mnemo-ai/types").LLMAdapter = {
    id: "stub-classifier",
    model: "stub-classifier",
    async generate(input) {
      const prompt = input.messages[0]?.content ?? "";
      llmPrompts.push(prompt);
      const contradicts = (prompt.match(/Acme vault opens at/g) ?? []).length >= 2;
      return {
        content: contradicts ? "CONTRADICTION" : "COMPATIBLE",
        tokensUsed: { input: 1, output: 1 },
        model: "stub-classifier",
        finishReason: "stop" as const,
      };
    },
    async generateStructured() {
      throw new Error("unused");
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };
  appConflicts = createApp({
    deps: {
      ...deps,
      cognitive: v3CoreMod.createCore(
        {
          storage,
          vector,
          embed: unitEmbed,
          outbox,
          logger: noopLogger,
          telemetry: noopTelemetry,
          llm: classifyingLlm,
        },
        { surpriseThreshold: 0, writeConflictClassification: true }
      ),
    },
    version: "authgdpr-conflicts-test",
  });
}, 180_000);

afterAll(async () => {
  if (savedCeiling === undefined) delete process.env.MNEMO_SENSITIVITY_CEILING;
  else process.env.MNEMO_SENSITIVITY_CEILING = savedCeiling;
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("MNEMO_SCOPED_AUTH=1 with keys from /admin/keys", () => {
  it("a minted mk_live_ key authenticates", async () => {
    const minted = await mint({ label: "reader", scopes: ["memory:read"] });
    expect(minted.key.startsWith("mk_live_")).toBe(true);
    const me = await app.request("/me", { headers: authed(minted.key) });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { scopes: string[] }).scopes).toEqual(["memory:read"]);
  });

  it("a minted mk_fed_ key authenticates (refused on scope, not on identity)", async () => {
    const minted = await mint({
      label: "peer",
      scopes: ["memory:federation"],
      federation: true,
    });
    expect(minted.key.startsWith("mk_fed_")).toBe(true);
    const me = await app.request("/me", { headers: authed(minted.key) });
    expect(me.status).toBe(403);
  });

  it("a scoped-scheme key verifies against mnemo_scoped_api_keys, and a wrong secret does not", async () => {
    const keyId = "authgdprscop";
    const secret = "s3cretAcmeLarkspur000000000000000000000000x";
    await admin`
      INSERT INTO mnemosyne.mnemo_scoped_api_keys (key_id, prefix, hashed_secret, workspace_id, scopes)
      VALUES (${keyId}, ${"mk_live_"}, ${await hashSecret(secret)}, ${WS},
              ${admin.json(["memory:read"])})
    `;
    const ok = await app.request("/me", { headers: authed(`mk_live_${keyId}_${secret}`) });
    expect(ok.status).toBe(200);
    const bad = await app.request("/me", { headers: authed(`mk_live_${keyId}_${secret}y`) });
    expect(bad.status).toBe(401);
  });
});

describe("POST /admin/erasure", () => {
  async function dekOf(actorId: string) {
    const rows = await admin<Array<{ status: string; encrypted_key: Buffer | null }>>`
      SELECT status, encrypted_key FROM mnemosyne.mnemo_actor_dek
      WHERE workspace_id = ${WS} AND actor_id = ${actorId}
    `;
    return rows[0];
  }

  it("after erasure the actor's confidential memory has no key left to decrypt it", async () => {
    const subject = await mint({ label: "subject", scopes: ["memory:read", "memory:write"] });
    const bystander = await mint({ label: "bystander", scopes: ["memory:read", "memory:write"] });
    const statement = "Larkspur Robotics payroll account ends in 4417";
    for (const [key, text] of [
      [subject.key, statement],
      [bystander.key, "Acme quarterly audit is booked with the Lisbon office"],
    ] as const) {
      const res = await app.request("/remember", {
        method: "POST",
        headers: authed(key),
        body: JSON.stringify({ statement: text, sensitivity: "confidential" }),
      });
      expect(res.status).toBe(201);
    }
    const actorId = `key:${subject.id}`;
    const [row] = await admin<Array<{ statement: string }>>`
      SELECT statement FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${WS} AND actor_id = ${actorId}
    `;
    expect(row!.statement.startsWith("enc:v1:")).toBe(true);

    // Before: the actor's DEK opens its ciphertext.
    const wrapped = await storage.getActorDek(WS, actorId);
    expect(wrapped).not.toBeNull();
    expect(decryptEncryptedField(Buffer.from(wrapped!, "base64"), row!.statement)).toBe(statement);

    const unconfirmed = await app.request("/admin/erasure", {
      method: "POST",
      headers: authed(KEY_OWNER),
      body: JSON.stringify({ actorId, confirm: "yes" }),
    });
    expect(unconfirmed.status).toBe(400);
    expect((await dekOf(actorId))!.status).toBe("active");

    const res = await app.request("/admin/erasure", {
      method: "POST",
      headers: authed(KEY_OWNER),
      body: JSON.stringify({ actorId, confirm: actorId }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subject: { kind: "actor", id: actorId }, keysDestroyed: 1 });

    // After: no key material anywhere, the row is still only ciphertext.
    expect(await storage.getActorDek(WS, actorId)).toBeNull();
    const dek = await dekOf(actorId);
    expect(dek!.status).toBe("destroyed");
    expect(dek!.encrypted_key).toBeNull();
    const [after] = await admin<Array<{ statement: string }>>`
      SELECT statement FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${WS} AND actor_id = ${actorId}
    `;
    expect(after!.statement).toBe(row!.statement);
    expect(after!.statement).not.toContain("4417");
    // Another actor's key is untouched.
    expect((await dekOf(`key:${bystander.id}`))!.status).toBe("active");

    const audit = await admin<Array<{ action: string; is_terminal: boolean }>>`
      SELECT action, is_terminal FROM mnemosyne.mnemo_audit_log
      WHERE workspace_id = ${WS} AND resource_id = ${actorId} ORDER BY id
    `;
    expect(audit.map((a) => [a.action, a.is_terminal])).toEqual([
      ["erasure_initiated", false],
      ["erasure_complete", true],
    ]);

    // Erasing again finds no live key.
    const again = await app.request("/admin/erasure", {
      method: "POST",
      headers: authed(KEY_OWNER),
      body: JSON.stringify({ actorId, confirm: actorId }),
    });
    expect(again.status).toBe(404);
  });

  it("a key without memory:hard_delete cannot erase", async () => {
    const writer = await mint({ label: "writer", scopes: ["memory:read", "memory:write"] });
    const res = await app.request("/admin/erasure", {
      method: "POST",
      headers: authed(writer.key),
      body: JSON.stringify({ actorId: `key:${writer.id}`, confirm: `key:${writer.id}` }),
    });
    expect(res.status).toBe(403);
  });
});

describe("reading encrypted facts", () => {
  // No outbox worker runs here: the test stores the fact's vector itself, as
  // the worker would from the vector remember() computed on the plaintext.
  const DIMS = 1536;
  const oneHot = Array.from({ length: DIMS }, (_, i) => (i === 7 ? 1 : 0));

  async function recallIds(key: string): Promise<Array<{ id: string; content: string }>> {
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(key),
      body: JSON.stringify({ query: "Larkspur Robotics bank", topK: 10, vector: oneHot }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { hits: Array<{ id: string; content: string }> }).hits;
  }

  it("plaintext for a confidential ceiling, hidden below it, [erased] after erasure", async () => {
    // Recall reads above `internal` only with memory:admin (effectiveCeiling).
    const writer = await mint({
      label: "conf-writer",
      scopes: ["memory:read", "memory:write", "memory:admin"],
      maxSensitivity: "confidential",
    });
    const low = await mint({
      label: "internal-reader",
      scopes: ["memory:read"],
      maxSensitivity: "internal",
    });
    const statement = "Larkspur Robotics wires payroll from the Acme bank branch on Fridays";
    const created = await app.request("/remember", {
      method: "POST",
      headers: authed(writer.key),
      body: JSON.stringify({ statement, sensitivity: "confidential" }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const [row] = await admin<Array<{ statement: string }>>`
      SELECT statement FROM mnemosyne.mnemo_fact WHERE id = ${id}
    `;
    expect(row!.statement.startsWith("enc:v1:")).toBe(true);
    await vector.upsert(id, new Float32Array(oneHot), { workspaceId: WS });

    const got = await app.request(`/facts/${id}`, { headers: authed(writer.key) });
    expect(got.status).toBe(200);
    const fact = (await got.json()) as { content: string; redacted?: string };
    expect(fact.content).toBe(statement);
    expect(fact.redacted).toBeUndefined();
    expect((await recallIds(writer.key)).find((h) => h.id === id)?.content).toBe(statement);

    // An edit and a topic-key update stay sealed under the writer's key.
    const edited = "Larkspur Robotics wires payroll from the Acme bank branch on Mondays";
    const patch = await app.request(`/facts/${id}`, {
      method: "PATCH",
      headers: authed(writer.key),
      body: JSON.stringify({ statement: edited }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { statement: string }).statement).toBe(edited);
    for (const text of ["Acme vault code rotates weekly", "Acme vault code rotates daily"]) {
      const res = await app.request("/remember", {
        method: "POST",
        headers: authed(writer.key),
        body: JSON.stringify({
          statement: text,
          sensitivity: "confidential",
          topicKey: "acme-vault",
        }),
      });
      expect(res.status).toBe(201);
    }
    const sealedRows = await admin<Array<{ statement: string; subject: string }>>`
      SELECT statement, subject FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${WS} AND actor_id = ${`key:${writer.id}`}
    `;
    expect(sealedRows).toHaveLength(3);
    for (const r of sealedRows) {
      expect(r.statement.startsWith("enc:v1:")).toBe(true);
      expect(r.subject.startsWith("enc:v1:")).toBe(true);
    }
    const listed = await app.request("/facts?status=all&limit=50", {
      headers: authed(writer.key),
    });
    const items = ((await listed.json()) as { items: Array<{ id: string; statement: string }> })
      .items;
    expect(items.find((f) => f.id === id)?.statement).toBe(edited);
    expect(items.map((f) => f.statement)).toEqual(
      expect.arrayContaining(["Acme vault code rotates weekly", "Acme vault code rotates daily"])
    );

    // A lower ceiling: not found, not recalled.
    expect((await app.request(`/facts/${id}`, { headers: authed(low.key) })).status).toBe(404);
    expect((await recallIds(low.key)).some((h) => h.id === id)).toBe(false);

    const actorId = `key:${writer.id}`;
    const erased = await app.request("/admin/erasure", {
      method: "POST",
      headers: authed(KEY_OWNER),
      body: JSON.stringify({ actorId, confirm: actorId }),
    });
    expect(erased.status).toBe(200);

    const after = await app.request(`/facts/${id}`, { headers: authed(writer.key) });
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({
      content: "[erased]",
      subject: "[erased]",
      redacted: "erased",
    });
    expect((await recallIds(writer.key)).some((h) => h.id === id)).toBe(false);
    expect((await app.request(`/facts/${id}`, { headers: authed(low.key) })).status).toBe(404);
  });
});

describe("write-time conflict candidates", () => {
  type Conflict = { candidates: Array<{ id: string; statement: string }> } | undefined;
  async function remember(key: string, body: Record<string, unknown>) {
    const res = await appConflicts.request("/remember", {
      method: "POST",
      headers: authed(key),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; conflict?: Conflict };
  }

  it("never send confidential text to the LLM, and stay within the write's context", async () => {
    // A confidential ceiling and memory:admin: the most this caller may read.
    const conf = await mint({
      label: "conflict-conf",
      scopes: ["memory:read", "memory:write", "memory:admin"],
      maxSensitivity: "confidential",
    });
    const secret = "The Acme vault opens at 9 for Larkspur Robotics";
    const a = await remember(conf.key, { statement: secret, sensitivity: "confidential" });
    const unit = Array.from({ length: 1536 }, (_, i) => (i === CONFLICT_DIM ? 1 : 0));
    await vector.upsert(a.id, new Float32Array(unit), { workspaceId: WS });
    const shared = "The Acme vault opens at 10 for Larkspur Robotics";
    const b = await remember(conf.key, { statement: shared, sensitivity: "internal" });

    // An internal write: the internal contradiction is found and shown, the
    // confidential one is not a candidate, and its text never reaches the LLM.
    llmPrompts.length = 0;
    const c = await remember(conf.key, {
      statement: "The Acme vault opens at 11 for Larkspur Robotics",
      sensitivity: "internal",
    });
    expect(c.conflict?.candidates.find((x) => x.id === b.id)?.statement).toBe(shared);
    expect(c.conflict?.candidates.some((x) => x.id === a.id)).toBe(false);
    expect(llmPrompts.length).toBeGreaterThan(0);
    expect(llmPrompts.join("\n")).not.toContain(secret);

    // A confidential write is not screened at all: its own text stays too.
    llmPrompts.length = 0;
    const d = await remember(conf.key, {
      statement: "The Acme vault opens at 12 for Larkspur Robotics",
      sensitivity: "confidential",
    });
    expect(d.conflict).toBeUndefined();
    expect(llmPrompts).toEqual([]);

    // A write in a conversation scope does not see the workspace-wide facts.
    const e = await remember(conf.key, {
      statement: "The Acme vault opens at 13 for Larkspur Robotics",
      sensitivity: "internal",
      scope: "conversation",
      scopeRef: "acme-chat-1",
    });
    expect(e.conflict).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain(shared);
  });
});
