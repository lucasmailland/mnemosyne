/**
 * Scoped-key issuance end to end (SECURITY.md §2.2), on a real Postgres and a
 * NOSUPERUSER / NOBYPASSRLS application role, the way production connects.
 *
 * - A key POST /admin/scoped-keys issues authenticates through the scoped
 *   scheme (MNEMO_SCOPED_AUTH=1: ScopedApiKeyAdapter over DrizzleApiKeyStore)
 *   with the app role, which needs migration 0069's grants.
 * - A rotated key works through its grace and is refused past the sunset; a
 *   revoked key is refused on the next request.
 * - An mk_admin_ key is refused without the right TOTP code, and with it
 *   reaches the existing two-person gate as its user: one admin alone is
 *   refused, a second admin's approval lets the privileged operation through.
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
import { generateTotp } from "@mnemo-ai/core";

import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import { ScopedApiKeyAdapter } from "../../auth/ScopedApiKeyAdapter.js";
import type { ServerDeps } from "../../deps.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG_USER = "mnemo_super_scoped";
const PG_PASSWORD = "mnemo_super_scoped";
const PG_DB = "mnemo_test_scoped";
const APP_ROLE = "scoped_app";
const APP_PASSWORD = "scoped_app_pass";

const TENANT_ID = "tenant-scoped";
const WS = "5c0bed00-0000-4000-8000-0000000000a1";
const USER_A = "user-larkspur-a";
const USER_B = "user-larkspur-b";
// User-bound mns_* keys of two workspace admins.
const KEY_A = "mns_live_scopedissueadmina000000001";
const KEY_B = "mns_live_scopedissueadminb000000002";
const ADMIN_SCOPES = ["memory:read", "memory:write", "admin:keys"];

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let closers: Array<() => Promise<unknown>> = [];
let app: ReturnType<typeof createApp>;

function call(method: string, path: string, key: string, body?: object, mfa?: string) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(mfa ? { "x-mnemo-mfa": mfa } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function issue(key: string, body: object): Promise<Record<string, string>> {
  const res = await call("POST", "/admin/scoped-keys", key, body);
  expect(res.status).toBe(201);
  return (await res.json()) as Record<string, string>;
}

beforeAll(async () => {
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
  await admin`INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Larkspur Robotics"})`;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Larkspur ops"}, ${"larkspur-ops"}, ${TENANT_ID})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id)
    VALUES (${USER_A}, ${"ops-a@larkspur.example"}, ${TENANT_ID}),
           (${USER_B}, ${"ops-b@larkspur.example"}, ${TENANT_ID})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
    VALUES (${WS}, ${USER_A}, 'owner'), (${WS}, ${USER_B}, 'admin')
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, user_id, key_hash, name, label, scopes)
    VALUES
      ('key_scoped_a', ${WS}, ${USER_A}, ${await bcrypt.hash(KEY_A, BCRYPT_COST)}, 'a', 'a',
       ${admin.array(ADMIN_SCOPES)}),
      ('key_scoped_b', ${WS}, ${USER_B}, ${await bcrypt.hash(KEY_B, BCRYPT_COST)}, 'b', 'b',
       ${admin.array(ADMIN_SCOPES)})
  `;

  // Everything the server reads goes over the application role.
  const appUrl = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${PG_DB}`;
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: appUrl });
  const pgMod = await import("@mnemo-ai/adapter-postgres");
  const { db, pgClient } = pgMod.createDrizzleClient(appUrl);
  const dek = () => {
    const k = randomBytes(32);
    return { dek: k, wrapped: k.toString("base64") };
  };
  const storage = new pgMod.DrizzleStorageAdapter(
    db,
    pgClient,
    (_w, _a, w) => Buffer.from(w, "base64"),
    dek
  );
  const scopedKeyStore = new pgMod.DrizzleApiKeyStore(db);
  const metricsPgClient = postgres(appUrl, { max: 3, onnotice: () => void 0 });
  closers = [
    () => apiKeys.close(),
    () => (pgClient as unknown as { end: () => Promise<void> }).end(),
    () => metricsPgClient.end(),
  ];

  const deps = {
    storage,
    apiKeys,
    scopedAuthAdapter: new ScopedApiKeyAdapter({ store: scopedKeyStore }),
    scopedKeyStore,
    accessPolicies: new pgMod.DrizzleAccessPolicyStore(db),
    approvals: new pgMod.DrizzleApprovalStore(db),
    breakGlass: new pgMod.DrizzleBreakGlassStore(db),
    llm: undefined,
    embedModel: "fake-model",
    metricsPgClient,
  } as unknown as ServerDeps;
  app = createApp({ deps, version: "scoped-issuance-test" });
}, 180_000);

afterAll(async () => {
  for (const close of closers) await close().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("POST /admin/scoped-keys on Postgres, app role", () => {
  it("an issued key authenticates with MNEMO_SCOPED_AUTH=1 and is stored hashed, bound and audited", async () => {
    const issued = await issue(KEY_A, { scopes: ["memory:read"], expiresIn: "30d" });
    const me = await call("GET", "/me", issued.key);
    expect(me.status).toBe(200);
    expect(((await me.json()) as { scopes: string[] }).scopes).toEqual(["memory:read"]);

    const keyId = issued.id!.slice("mk_live_".length);
    const rows = await admin<Array<{ hashed_secret: string; user_id: string; scopes: string[] }>>`
      SELECT hashed_secret, user_id, scopes FROM mnemosyne.mnemo_scoped_api_keys WHERE key_id = ${keyId}
    `;
    expect(rows[0]!.hashed_secret.startsWith("$argon2id$")).toBe(true);
    expect(rows[0]!.hashed_secret).not.toContain(issued.key!.split("_").pop()!);
    expect(rows[0]!.user_id).toBe(USER_A);
    const audit = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_audit_log
      WHERE workspace_id = ${WS} AND action = 'key_create' AND resource_id = ${issued.id!}
    `;
    expect(audit[0]!.n).toBe(1);
  });

  it("a rotated key works through its grace and not past the sunset; a revoked key stops at once", async () => {
    const old = await issue(KEY_A, { scopes: ["memory:read"] });
    const rot = await call("POST", `/admin/scoped-keys/${old.id}/rotate`, KEY_A, {});
    expect(rot.status).toBe(201);
    const { newKey, newId } = (await rot.json()) as { newKey: string; newId: string };
    expect((await call("GET", "/me", newKey)).status).toBe(200);
    expect((await call("GET", "/me", old.key!)).status).toBe(200);

    // Eight days later for the old key: past the 7-day sunset.
    await admin`
      UPDATE mnemosyne.mnemo_scoped_api_keys SET deprecated_at = now() - interval '8 days'
      WHERE key_id = ${old.id!.slice("mk_live_".length)}
    `;
    expect((await call("GET", "/me", old.key!)).status).toBe(401);

    expect((await call("DELETE", `/admin/scoped-keys/${newId}`, KEY_A)).status).toBe(200);
    expect((await call("GET", "/me", newKey)).status).toBe(401);
    const escrow = await admin<Array<{ action: string }>>`
      SELECT action FROM mnemosyne.mnemo_scoped_key_escrow
      WHERE key_id IN (${old.id!.slice(8)}, ${newId.slice(8)}) ORDER BY id
    `;
    expect(escrow.map((r) => r.action)).toEqual(["rotate", "revoke"]);
  });

  it("an mk_admin_ key needs its TOTP code, and its privileged operations need a second admin", async () => {
    const a = await issue(KEY_A, { type: "admin", scopes: ADMIN_SCOPES, expiresIn: "8h" });
    const b = await issue(KEY_B, { type: "admin", scopes: ADMIN_SCOPES, expiresIn: "8h" });
    expect(a.mfaSecret).toMatch(/^[A-Z2-7]{32}$/);

    // No code, a wrong code: refused before anything else.
    expect((await call("GET", "/me", a.key!)).status).toBe(403);
    const codeA = generateTotp(a.mfaSecret!);
    const wrong = codeA === "000000" ? "111111" : "000000";
    expect((await call("GET", "/me", a.key!, undefined, wrong)).status).toBe(403);
    expect((await call("GET", "/me", a.key!, undefined, codeA)).status).toBe(200);

    // A privileged operation (issuing a key) alone: the two-person gate refuses.
    const op = { scopes: ["memory:read"] };
    const alone = await call("POST", "/admin/scoped-keys", a.key!, op, codeA);
    expect(alone.status).toBe(403);
    expect(JSON.stringify(await alone.json())).toContain("second admin");

    // A files a break-glass request as USER_A; B approves as USER_B.
    const filed = await call(
      "POST",
      "/break-glass",
      a.key!,
      { reason: "rotate a leaked key", requestedScopes: ["admin:keys"] },
      codeA
    );
    expect(filed.status).toBe(201);
    const { id: requestId } = (await filed.json()) as { id: string };
    const status = await call("GET", `/break-glass/${requestId}`, a.key!, undefined, codeA);
    expect(((await status.json()) as { requestedBy: string }).requestedBy).toBe(USER_A);
    // A cannot approve their own request.
    expect(
      (await call("POST", `/break-glass/${requestId}/approve`, a.key!, {}, codeA)).status
    ).toBe(403);
    const approved = await call(
      "POST",
      `/break-glass/${requestId}/approve`,
      b.key!,
      {},
      generateTotp(b.mfaSecret!)
    );
    expect(approved.status).toBe(200);

    expect((await call("POST", "/admin/scoped-keys", a.key!, op, codeA)).status).toBe(201);
  });

  it("an mk_admin_ key is not issued to a caller with no user, and not rotated by another user", async () => {
    const a = await issue(KEY_A, { type: "admin", scopes: ["memory:read"] });
    expect((await call("POST", `/admin/scoped-keys/${a.id}/rotate`, KEY_B, {})).status).toBe(403);
    const live = await issue(KEY_A, { scopes: ["memory:read", "admin:keys"] });
    // A scoped key issued by a user carries that user: it may issue an mk_admin_.
    expect(
      (
        await call("POST", "/admin/scoped-keys", live.key!, {
          type: "admin",
          scopes: ["memory:read"],
        })
      ).status
    ).toBe(201);
    await admin`UPDATE mnemosyne.mnemo_scoped_api_keys SET user_id = NULL WHERE key_id = ${live.id!.slice(8)}`;
    expect(
      (
        await call("POST", "/admin/scoped-keys", live.key!, {
          type: "admin",
          scopes: ["memory:read"],
        })
      ).status
    ).toBe(403);
  });
});
