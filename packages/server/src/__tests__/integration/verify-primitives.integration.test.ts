/**
 * Verification fixes V-4, V-5, V-6 and V-10 against REAL Postgres, through the
 * real HTTP routes, as a non-superuser FORCE-RLS role:
 *
 *   V-4 / PRIM-18  two identical POST /decisions are one row (also when sent
 *                  concurrently); an explicit topicKey keeps its own semantics.
 *   V-5 / PRIM-14  a create above the key's read ceiling answers 404
 *                  `sensitivity_above_ceiling` and stores nothing.
 *   V-6 / PRIM-16  forgotten tasks and reasoning chains leave the default list;
 *                  includeClosed / an explicit status bring them back; the
 *                  filter runs before LIMIT and total.
 *   V-10 / PRIM-19 GET /timeline pages with a cursor; walking every page, with
 *                  rows that share the same microsecond, loses and duplicates
 *                  nothing.
 *
 * Hermetic: fresh throwaway pgvector container. Requires Docker and Node 22.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import bcrypt from "bcrypt";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG_USER = "mnemo_super";
const PG_PASSWORD = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_ROLE = "verify_app";
const APP_PASSWORD = "verify_app_pass";

const TENANT_ID = "tenant-verify-prim";
const WS = "9b1f9c00-0000-4000-8000-0000000000d7";
const KEY = "mns_live_verifyprimitiveskey000001";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
let storage: import("@mnemo-ai/adapter-postgres").DrizzleStorageAdapter;

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers };
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DB,
    })
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

  const { stdout: coreOut } = await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", superUrl],
    { timeout: 120_000 }
  );
  expect(coreOut).toContain("done");
  const { stdout: v3Out } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: superUrl },
  });
  expect(v3Out).toContain("Done. Applied:");

  admin = postgres(superUrl, { max: 1, onnotice: () => void 0 });

  // Real non-superuser, non-BYPASSRLS application role — same discipline as
  // purge-facts-hard-delete.integration.test.ts / doctor-nonsuperuser. This
  // is the connecting role withMnemoTx's `SET LOCAL ROLE app_user` runs
  // under in production, never a Postgres superuser.
  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT app_user TO ${APP_ROLE};
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);

  await admin`
    INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Verify primitives tenant"})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Verify primitives workspace"}, ${"verify-prim"}, ${TENANT_ID})
  `;

  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${"key_verify_prim"}, ${WS}, ${keyHash}, ${"verify-prim"}, ${"verify-prim"},
            ARRAY['memory:read', 'memory:write', 'memory:delete', 'memory:task', 'memory:reasoning', 'memory:event']::text[])
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
  const { db: v3Db, pgClient: v3Pg } = adapterPgMod.createDrizzleClient(appUrl);
  const v3Storage = new adapterPgMod.DrizzleStorageAdapter(v3Db, v3Pg, undefined);
  storage = v3Storage;
  const v3Vector = new adapterVectorMod.PgVectorAdapter({ connectionString: appUrl });
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
  const noopTelemetry = {
    startSpan: () => ({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
  const outboxAdapter: import("@mnemo-ai/types").OutboxAdapter = {
    async append(e) {
      return v3Storage.appendOutbox(e);
    },
    async claimBatch(n) {
      return v3Storage.claimOutbox(n);
    },
    async markProcessed(ids) {
      return v3Storage.markOutboxProcessed(ids);
    },
    async markFailed(id, err) {
      return v3Storage.markOutboxFailed(id, err);
    },
    async getStats() {
      return { pending: 0, failed: 0, oldestPendingMs: 0 };
    },
  };
  const cognitive = v3CoreMod.createCore({
    storage: v3Storage,
    vector: v3Vector,
    embed: fakeEmbed,
    outbox: outboxAdapter,
    logger: noopLogger,
    telemetry: noopTelemetry,
  });

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps: ServerDeps = {
    apiKeys,
    cognitive,
    storage: v3Storage,
    llm: undefined,
    embedModel: "fake-model",
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  };
  app = createApp({ deps, version: "2.0.0-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

const json = async (res: Response) => (await res.json()) as Record<string, any>;

async function post(path: string, body: unknown): Promise<Response> {
  return app.request(path, { method: "POST", headers: authed(), body: JSON.stringify(body) });
}
async function getJson(path: string): Promise<{ status: number; body: Record<string, any> }> {
  const res = await app.request(path, { headers: authed() });
  return { status: res.status, body: await json(res) };
}
const count = async (table: string, where: string): Promise<number> => {
  const rows = await admin.unsafe(
    `SELECT count(*)::int AS n FROM mnemosyne.${table} WHERE workspace_id = '${WS}' AND ${where}`
  );
  return rows[0]!.n as number;
};

describe("V-4 / PRIM-18 — POST /decisions dedups an exact repeat", () => {
  const decision = { kind: "decision", title: "Dedup me", body: "Same words every time." };

  it("two identical decisions are one row, the second answers with the first id", async () => {
    const a = await post("/decisions", decision);
    const b = await post("/decisions", decision);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((await json(a)).id).toBe((await json(b)).id);
    expect(await count("mnemo_decision", `title = 'Dedup me'`)).toBe(1);
  });

  it("eight concurrent identical POSTs make one row", async () => {
    const body = { kind: "decision", title: "Dedup race", body: "Eight at once." };
    const res = await Promise.all(Array.from({ length: 8 }, () => post("/decisions", body)));
    const ids = new Set(await Promise.all(res.map(async (r) => (await json(r)).id as string)));
    expect(ids.size).toBe(1);
    expect(await count("mnemo_decision", `title = 'Dedup race'`)).toBe(1);
  });

  it("a different body, kind or sensitivity is another decision", async () => {
    await post("/decisions", decision);
    const other = await post("/decisions", { ...decision, body: "Other words." });
    const otherKind = await post("/decisions", { ...decision, kind: "architecture" });
    const otherTier = await post("/decisions", { ...decision, sensitivity: "public" });
    const ids = new Set(
      await Promise.all([other, otherKind, otherTier].map(async (r) => (await json(r)).id))
    );
    expect(ids.size).toBe(3);
    expect(await count("mnemo_decision", `title = 'Dedup me'`)).toBe(4);
  });

  it("an explicit topicKey keeps its own semantics: same slot updates in place, never the content dedup", async () => {
    const first = await json(
      await post("/decisions", { ...decision, title: "Keyed", topicKey: "k-1" })
    );
    const second = await json(
      await post("/decisions", { ...decision, title: "Keyed", topicKey: "k-1" })
    );
    expect(second.id).toBe(first.id);
    expect(second.revisionCount).toBe(2);
    // An unkeyed repeat of the same words is the same decision: it gets the keyed row back.
    const repeat = await json(await post("/decisions", { ...decision, title: "Keyed" }));
    expect(repeat.id).toBe(first.id);
    // A write that names a NEW key has named its own slot: it is not folded into
    // an unkeyed row that happens to hold the same words.
    const unkeyed = await json(await post("/decisions", { ...decision, title: "Unkeyed twin" }));
    const keyed = await json(
      await post("/decisions", { ...decision, title: "Unkeyed twin", topicKey: "k-2" })
    );
    expect(keyed.id).not.toBe(unkeyed.id);
  });
});

describe("V-5 / PRIM-14 — creates above the read ceiling are refused", () => {
  it("POST /decisions restricted -> 404 sensitivity_above_ceiling, nothing stored", async () => {
    const res = await post("/decisions", {
      kind: "decision",
      title: "Too secret",
      body: "Nobody could read this back.",
      sensitivity: "restricted",
    });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await json(res))).toContain("sensitivity_above_ceiling");
    expect(await count("mnemo_decision", `title = 'Too secret'`)).toBe(0);
  });

  it("the same status and code as POST /remember on a fact", async () => {
    const res = await post("/remember", {
      statement: "A restricted fact",
      sensitivity: "restricted",
    });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await json(res))).toContain("sensitivity_above_ceiling");
  });

  it("task, entity, reasoning, strategy and workflow creates are refused too", async () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ["/tasks", { title: "secret task", assignedTo: "a" }, "mnemo_task", "title = 'secret task'"],
      [
        "/entities",
        { name: "Secret Co", kind: "organization" },
        "mnemo_entity",
        "name = 'Secret Co'",
      ],
      [
        "/reasoning",
        { question: "secret?", chain: [{ step: 1, reasoning: "x" }], conclusion: "c" },
        "mnemo_reasoning",
        "question = 'secret?'",
      ],
      [
        "/strategies",
        { trigger: "secret trigger", action: "a" },
        "mnemo_strategy",
        "trigger = 'secret trigger'",
      ],
      [
        "/workflows",
        { name: "secret flow", steps: [{ order: 1, action: "a", expectedDurationMs: 0 }] },
        "mnemo_workflow",
        "name = 'secret flow'",
      ],
    ];
    for (const [path, body, table, where] of cases) {
      const res = await post(path, { ...body, sensitivity: "restricted" });
      expect(res.status, path).toBe(404);
      expect(JSON.stringify(await json(res)), path).toContain("sensitivity_above_ceiling");
      expect(await count(table, where), path).toBe(0);
    }
  });

  it("a tier at or below the ceiling is still written and readable", async () => {
    const res = await post("/decisions", {
      kind: "decision",
      title: "Readable",
      body: "Internal tier.",
      sensitivity: "internal",
    });
    expect(res.status).toBe(201);
    expect((await getJson(`/decisions/${(await json(res)).id}`)).status).toBe(200);
  });
});

describe("V-6 / PRIM-16 — task and reasoning lists show current rows by default", () => {
  it("tasks: a forgotten task is history, filtered before LIMIT and total", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(
        (await json(await post("/tasks", { title: `list task ${i}`, assignedTo: "agent" }))).id
      );
    }
    for (const id of ids.slice(0, 4)) {
      const del = await app.request(`/tasks/${id}`, { method: "DELETE", headers: authed() });
      expect(del.status).toBe(204);
    }
    const mine = (b: Record<string, any>) =>
      (b.items as Array<{ id: string }>).map((t) => t.id).filter((id) => ids.includes(id));

    const current = await getJson("/tasks?limit=200");
    expect(mine(current.body).sort()).toEqual(ids.slice(4).sort());

    // LIMIT applies to current rows: 2 of them exist, so a page of 2 is full and final.
    const only = await getJson("/tasks?limit=2&assignedTo=agent");
    expect(only.body.items).toHaveLength(2);
    expect(only.body.total).toBe(2);
    expect(only.body.hasMore).toBe(false);

    const history = await getJson("/tasks?limit=200&includeClosed=true");
    expect(mine(history.body).sort()).toEqual([...ids].sort());

    const cancelled = await getJson("/tasks?limit=200&status=cancelled");
    expect(mine(cancelled.body).sort()).toEqual(ids.slice(0, 4).sort());
  });

  it("reasoning: an archived chain is history, filtered before LIMIT and total", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        (
          await json(
            await post("/reasoning", {
              question: `list q ${i}`,
              chain: [{ step: 1, reasoning: "x" }],
              conclusion: `c ${i}`,
            })
          )
        ).id
      );
    }
    for (const id of ids.slice(0, 3)) {
      const del = await app.request(`/reasoning/${id}`, { method: "DELETE", headers: authed() });
      expect(del.status).toBe(204);
    }
    const mine = (b: Record<string, any>) =>
      (b.items as Array<{ id: string }>).map((t) => t.id).filter((id) => ids.includes(id));

    expect(mine((await getJson("/reasoning?limit=200")).body).sort()).toEqual(ids.slice(3).sort());
    const page = await getJson("/reasoning?limit=1");
    expect(page.body.items).toHaveLength(1);
    expect(page.body.total).toBe(2);
    expect(page.body.hasMore).toBe(true);
    expect(mine((await getJson("/reasoning?limit=200&includeClosed=true")).body).sort()).toEqual(
      [...ids].sort()
    );
    expect(mine((await getJson("/reasoning?limit=200&status=archived")).body).sort()).toEqual(
      ids.slice(0, 3).sort()
    );
  });
});

describe("V-10 / PRIM-19 — GET /timeline pages with a cursor", () => {
  it("walking every page loses and duplicates nothing, with rows that share a microsecond", async () => {
    const TL = "11111111-0000-4000-8000-0000000000d7";
    await admin`INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
      VALUES (${TL}, ${"Timeline workspace"}, ${"verify-timeline"}, ${TENANT_ID})`;
    const keyHash = await bcrypt.hash("mns_live_verifytimelinekey000001", BCRYPT_COST);
    await admin`INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
      VALUES (${"key_verify_tl"}, ${TL}, ${keyHash}, ${"tl"}, ${"tl"}, ARRAY['memory:read','memory:write']::text[])`;
    const tlAuth = { authorization: "Bearer mns_live_verifytimelinekey000001" };

    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const f = await storage.createFact({
        workspaceId: TL,
        statement: `timeline row ${i}`,
        subject: "timeline",
        kind: "other",
        scope: "global",
      });
      ids.push(f.id);
    }
    // Triples that share created_at AND updated_at to the microsecond; every
    // third fact is later edited, pinned or forgotten so both streams carry rows.
    await admin.unsafe(`
      WITH numbered AS (
        SELECT id, row_number() OVER (ORDER BY id) AS n FROM mnemosyne.mnemo_fact WHERE workspace_id = '${TL}'
      )
      UPDATE mnemosyne.mnemo_fact f
         SET created_at = timestamptz '2026-10-01 10:00:00.123456+00' + ((n / 3) || ' seconds')::interval,
             updated_at = timestamptz '2026-10-01 10:00:00.123456+00' + ((n / 3) || ' seconds')::interval
                          + (CASE WHEN n % 3 = 0 THEN interval '1 minute' ELSE interval '0' END)
        FROM numbered WHERE f.id = numbered.id`);
    await admin.unsafe(
      `UPDATE mnemosyne.mnemo_fact SET pinned = true WHERE workspace_id = '${TL}' AND updated_at <> created_at AND id::text < '8'`
    );

    const since = "2026-09-01T00:00:00.000Z";
    const page = async (qs: string) => {
      const res = await app.request(`/timeline?since=${since}${qs}`, { headers: tlAuth });
      expect(res.status).toBe(200);
      return (await res.json()) as {
        events: Array<{ id: string; at: string }>;
        nextCursor: string | null;
      };
    };

    const whole = await page("&limit=500");
    expect(whole.nextCursor).toBeNull();
    expect(whole.events.length).toBeGreaterThanOrEqual(30);

    for (const limit of [1, 4, 7]) {
      const walked: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 200; guard++) {
        const p = await page(`&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
        expect(p.events.length).toBeLessThanOrEqual(limit);
        walked.push(...p.events.map((e) => e.id));
        if (!p.nextCursor) break;
        expect(p.events).toHaveLength(limit);
        cursor = p.nextCursor;
      }
      expect(new Set(walked).size, `limit ${limit}: duplicates`).toBe(walked.length);
      expect([...walked].sort(), `limit ${limit}: lost`).toEqual(
        whole.events.map((e) => e.id).sort()
      );
    }
    // every fact appears as exactly one "created" event
    for (const id of ids) expect(whole.events.some((e) => e.id === `${id}:created`)).toBe(true);
  });

  it("an internal-ceiling key never sees restricted or confidential rows, and paging stays exact", async () => {
    const CW = "22222222-0000-4000-8000-0000000000d7";
    await admin`INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
      VALUES (${CW}, ${"Ceiling workspace"}, ${"verify-ceiling"}, ${TENANT_ID})`;
    const keyHash = await bcrypt.hash("mns_live_verifyceilingkey0000001", BCRYPT_COST);
    await admin`INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
      VALUES (${"key_verify_ceil"}, ${CW}, ${keyHash}, ${"c"}, ${"c"}, ARRAY['memory:read','memory:write','memory:event']::text[])`;
    const auth = { authorization: "Bearer mns_live_verifyceilingkey0000001" };
    const readable: string[] = [];
    for (let i = 0; i < 12; i++) {
      const tier = (["restricted", "confidential", "internal", "public"] as const)[i % 4]!;
      const f = await storage.createFact({
        workspaceId: CW,
        statement: `LEAK-CHECK ${tier} ${i}`,
        subject: "ceiling",
        kind: "other",
        scope: "global",
      });
      // tier set in SQL: createFact encrypts restricted text and needs an actor
      await admin.unsafe(
        `UPDATE mnemosyne.mnemo_fact SET sensitivity = '${tier}' WHERE id = '${f.id}'`
      );
      if (tier === "internal" || tier === "public") readable.push(f.id);
      // pinned rows are edited rows: they also sit in the update stream
      if (i % 2 === 0) await storage.updateFact(f.id, CW, { pinned: true });
    }
    // other kinds at a restricted tier must never reach the timeline
    await post("/decisions", { kind: "decision", title: "LEAK-CHECK decision", body: "b" });
    await admin.unsafe(
      `UPDATE mnemosyne.mnemo_decision SET sensitivity = 'restricted' WHERE title = 'LEAK-CHECK decision'`
    );

    const walk = async (limit: number) => {
      const events: Array<{ id: string; factId: string; summary: string }> = [];
      let cursor: string | null = null;
      for (let g = 0; g < 100; g++) {
        const res = await app.request(
          `/timeline?since=2020-01-01T00:00:00.000Z&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
          { headers: auth }
        );
        expect(res.status).toBe(200);
        const b = (await res.json()) as { events: typeof events; nextCursor: string | null };
        events.push(...b.events);
        if (!b.nextCursor) break;
        expect(b.events).toHaveLength(limit);
        cursor = b.nextCursor;
      }
      return events;
    };
    for (const limit of [1, 3, 500]) {
      const events = await walk(limit);
      const text = JSON.stringify(events);
      expect(text, `limit ${limit}`).not.toContain("restricted");
      expect(text, `limit ${limit}`).not.toContain("confidential");
      expect(text, `limit ${limit}`).not.toContain("decision");
      expect(new Set(events.map((e) => e.factId)), `limit ${limit}`).toEqual(new Set(readable));
      expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    }
  });

  it("a malformed cursor is a 400", async () => {
    const res = await app.request("/timeline?cursor=nope", { headers: authed() });
    expect(res.status).toBe(400);
  });
});
