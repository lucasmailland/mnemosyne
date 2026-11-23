/**
 * RELATE-VERIFY-1 + ENTITY-VERIFY-1 — real-Postgres coverage for
 * `memory_relate` (all 9 locked verbs + traversal) and `memory_entity`
 * (CRUD + the `linked_facts` reachability hypothesis).
 *
 * Both are coverage gaps, no known bug going in — combined into one file
 * per the plan (shared harness, `fileParallelism:false` makes two separate
 * container boots wasteful).
 *
 * RELATE-VERIFY-1 finding: architecturally sound on read (`relate.ts`'s verb
 * enum matches `LOCKED_VERBS`/the SQL CHECK constraint exactly), but the only
 * existing coverage was incidental (`conflicts.integration.test.ts` creates
 * one relation with one verb as scaffolding for `memory_judge`). No test
 * exercised the other 8 verbs or `POST /relations/traverse`.
 *
 * ENTITY-VERIFY-1 finding + hypothesis: zero integration coverage for
 * `/entities` before this file. Hypothesis (confirmed below): `action:
 * "linked_facts"` -> `GET /entities/:id/facts` -> `listFactsForEntity` filters
 * on `mnemo_fact.entity_id`, but `POST /facts` accepts no `entityId` field
 * at all (grepped: zero matches in routes/facts.ts) — and `memory_relate`
 * writes to a completely different table (`mnemo_relation`) that
 * `listFactsForEntity` never reads. So an MCP-only caller cannot make
 * `linked_facts` non-empty by any sequence of tool calls. This is a design
 * gap (a feature ready to be plumbed through, not a bug) — reported below,
 * not fixed here.
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
const APP_ROLE = "graph_app";
const APP_PASSWORD = "graph_app_pass";

const TENANT_ID = "tenant-graph-contract";
const WS = "9b1f9c00-0000-4000-8000-000000000040";
const WS_OTHER = "9b1f9c00-0000-4000-8000-000000000041";

// Well-formed key matching auth.ts API_KEY_PATTERN: mns_(live|test)_[a-z0-9]{20,64}
const API_KEY = "mns_live_graphcontracthasscopeenough01";
const API_KEY_OTHER = "mns_live_graphcontractotherworkspace01";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${API_KEY}`, "content-type": "application/json", ...headers };
}

function authedOther(headers: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${API_KEY_OTHER}`,
    "content-type": "application/json",
    ...headers,
  };
}

async function createFactViaApi(content: string, authHeaders = authed()): Promise<string> {
  // flatten-legacy-dual-core PR8 deleted POST /facts (D2 step 2) — the sole
  // write path is now POST /remember, lossless-remapped {content} -> {statement}.
  const res = await app.request("/remember", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ statement: content, tags: [] }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function relationRowExists(
  sourceId: string,
  targetId: string,
  relation: string
): Promise<boolean> {
  const rows = await admin<Array<{ id: string }>>`
    SELECT id FROM mnemosyne.mnemo_relation
    WHERE workspace_id = ${WS} AND source_id = ${sourceId} AND target_id = ${targetId} AND relation = ${relation}
  `;
  return rows.length > 0;
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

  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);

  await admin`
    INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Graph contract tenant"})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Graph contract workspace"}, ${"graph-contract"}, ${TENANT_ID})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS_OTHER}, ${"Graph contract workspace 2"}, ${"graph-contract-2"}, ${TENANT_ID})
  `;

  const hash = await bcrypt.hash(API_KEY, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_graph_contract"}, ${WS}, ${hash}, ${"graph-contract"}, ${"graph-contract"},
       ARRAY['memory:read','memory:write']::text[])
  `;
  const hashOther = await bcrypt.hash(API_KEY_OTHER, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_graph_contract_other"}, ${WS_OTHER}, ${hashOther}, ${"graph-contract-other"}, ${"graph-contract-other"},
       ARRAY['memory:read','memory:write']::text[])
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
  app = createApp({ deps, version: "graph-contract-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

// ─── Task 13: RELATE-VERIFY-1 ────────────────────────────────────────────

const VERBS_TO_EXERCISE = [
  "related",
  "compatible",
  "scoped",
  "supersedes",
  "not_conflict",
  "derived_from",
  "part_of",
  "member_of",
] as const;

describe("memory_relate — POST /relations across the locked verbs (mirrors relate.ts's exact create payload)", () => {
  it.each(VERBS_TO_EXERCISE)(
    "verb '%s': creates a real row, admin can see it, GET /relations lists it",
    async (verb) => {
      const sourceId = await createFactViaApi(`relate-source-${verb}`);
      const targetId = await createFactViaApi(`relate-target-${verb}`);

      const res = await app.request("/relations", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({
          sourceKind: "fact",
          sourceId,
          targetKind: "fact",
          targetId,
          relation: verb,
          markedByKind: "agent", // exactly what relate.ts hardcodes
        }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string; relation: string; markedByKind: string };
      expect(created.relation).toBe(verb);
      expect(created.markedByKind).toBe("agent");

      expect(await relationRowExists(sourceId, targetId, verb)).toBe(true);

      const listRes = await app.request("/relations?limit=500", { headers: authed() });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { items: Array<{ id: string }> };
      expect(listBody.items.map((i) => i.id)).toContain(created.id);
    }
  );

  it("REGRESSION GUARD (S-invariant, CLAUDE.md locked 9-verb rule): an out-of-set verb gets a real 400 and writes no row", async () => {
    const sourceId = await createFactViaApi("relate-source-invalid-verb");
    const targetId = await createFactViaApi("relate-target-invalid-verb");

    const res = await app.request("/relations", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        sourceKind: "fact",
        sourceId,
        targetKind: "fact",
        targetId,
        relation: "causes",
        markedByKind: "agent",
      }),
    });
    expect(res.status).toBe(400);
    expect(await relationRowExists(sourceId, targetId, "causes")).toBe(false);
  });

  it("proves traversability: POST /relations/traverse follows a 3-node chain A->B->C (same verb, maxDepth:2)", async () => {
    const a = await createFactViaApi("traverse-A");
    const b = await createFactViaApi("traverse-B");
    const c = await createFactViaApi("traverse-C");

    for (const [sourceId, targetId] of [
      [a, b],
      [b, c],
    ]) {
      const res = await app.request("/relations", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({
          sourceKind: "fact",
          sourceId,
          targetKind: "fact",
          targetId,
          relation: "related",
          markedByKind: "agent",
        }),
      });
      expect(res.status).toBe(201);
    }

    const res = await app.request("/relations/traverse", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ rootId: a, rootKind: "fact", maxDepth: 2 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: Array<{ id: string }> };
    const ids = body.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining([a, b, c]));
  });

  it("TRAVERSE-1 REGRESSION: a root with >500 outgoing relations is traversed WITHOUT silent truncation (was: capped at a global 500-row page, oldest edges silently dropped)", async () => {
    const root = await createFactViaApi("traverse-fanout-root");
    const targetCount = 510;
    const targetIds: string[] = [];
    for (let i = 0; i < targetCount; i++) {
      targetIds.push(await createFactViaApi(`traverse-fanout-target-${i}`));
    }

    // Direct admin inserts — 510 HTTP POSTs would work too, but this is the
    // same fan-out shape far faster, and exercises the exact rows the
    // traverse route's listRelations({sourceIds:[root]}) query reads.
    for (let i = 0; i < targetIds.length; i++) {
      await admin`
        INSERT INTO mnemosyne.mnemo_relation
          (id, workspace_id, source_kind, source_id, target_kind, target_id, relation, marked_by_kind)
        VALUES
          (${`rel-fanout-${i}`}, ${WS}, ${"fact"}, ${root}, ${"fact"}, ${targetIds[i]}, ${"related"}, ${"agent"})
      `;
    }

    // verbs:["related"] scopes the traversal to exactly the fan-out relations
    // this test inserted. Without it, POST /remember's real §33
    // contradiction-detection pipeline (which the deleted POST /facts never
    // ran — see design.md D2's own comparison table: "/facts: plain insert"
    // vs "/remember: ...§33 conflict") can auto-create a handful of
    // `conflicts_with` relations sourced at `root` too (the fixed fake
    // embedding used by every fact in this suite makes near-identical
    // vectors look contradictory), which would inflate the edge count for
    // reasons unrelated to what this test actually proves (no silent
    // per-node truncation of a large real fan-out).
    const res = await app.request("/relations/traverse", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        rootId: root,
        rootKind: "fact",
        maxDepth: 1,
        verbs: ["related"],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: Array<{ id: string }>;
      edges: Array<{ sourceId: string; targetId: string; relation: string }>;
      truncated?: boolean;
    };

    // All 510 targets reachable — none silently dropped by an artificial cap.
    const nodeIds = new Set(body.nodes.map((n) => n.id));
    for (const targetId of targetIds) {
      expect(nodeIds.has(targetId)).toBe(true);
    }
    expect(body.edges).toHaveLength(targetCount);
    // Well under TRAVERSE_LAYER_LIMIT (2000) — no truncation flag expected.
    expect(body.truncated).toBeUndefined();
  });

  it("workspace isolation: a relation seeded in WS_OTHER never appears in WS's GET /relations", async () => {
    const sourceOther = await createFactViaApi("other-ws-source", authedOther());
    const targetOther = await createFactViaApi("other-ws-target", authedOther());
    const createRes = await app.request("/relations", {
      method: "POST",
      headers: authedOther(),
      body: JSON.stringify({
        sourceKind: "fact",
        sourceId: sourceOther,
        targetKind: "fact",
        targetId: targetOther,
        relation: "related",
        markedByKind: "agent",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    const listRes = await app.request("/relations?limit=500", { headers: authed() });
    const listBody = (await listRes.json()) as { items: Array<{ id: string }> };
    expect(listBody.items.map((i) => i.id)).not.toContain(created.id);
  });
});

// ─── Task 14: ENTITY-VERIFY-1 ────────────────────────────────────────────

async function createEntityViaApi(
  name: string,
  extra: Record<string, unknown> = {},
  authHeaders = authed()
): Promise<{ id: string; name: string }> {
  const res = await app.request("/entities", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name, kind: "project", ...extra }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; name: string };
  return body;
}

describe("memory_entity — CRUD against real Postgres", () => {
  it("create: writes a real mnemo_entity row with a uuid id", async () => {
    const ent = await createEntityViaApi("Acme Corp Probe");
    // Every adapter mints entity ids with crypto.randomUUID(); `ment_<slug>` is
    // only the legacy seed shape the routes still accept (entity-id.ts).
    expect(ent.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const rows = await admin<Array<{ name: string }>>`
      SELECT name FROM mnemosyne.mnemo_entity WHERE id = ${ent.id} AND workspace_id = ${WS}
    `;
    expect(rows[0]?.name).toBe("Acme Corp Probe");
  });

  it("get: returns the entity plus linkedFactCount", async () => {
    const ent = await createEntityViaApi("GetMe Corp");
    const res = await app.request(`/entities/${ent.id}`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entity: { id: string }; linkedFactCount: number };
    expect(body.entity.id).toBe(ent.id);
    expect(body.linkedFactCount).toBe(0);
  });

  it("list: finds it by kind filter", async () => {
    const ent = await createEntityViaApi("KindFiltered Org", { kind: "organization" });
    const res = await app.request("/entities?kind=organization&limit=200", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toContain(ent.id);
  });

  it("list: finds it by `q` substring across aliases (not just name)", async () => {
    const ent = await createEntityViaApi("Formal Name Co", { aliases: ["QSearchableAlias"] });
    const res = await app.request("/entities?q=qsearchablealias&limit=200", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toContain(ent.id);
  });

  it("list: a row stamped by a database clock ahead of the server's is still current", async () => {
    // valid_from is Postgres now(); the server used to ask "valid at the server clock",
    // so an entity created a moment earlier vanished whenever the database
    // clock ran ahead of the server's. Five seconds ahead makes that certain.
    const ent = await createEntityViaApi("Clock Ahead Org", { kind: "organization" });
    await admin`
      UPDATE mnemosyne.mnemo_entity SET valid_from = now() + interval '5 seconds'
      WHERE id = ${ent.id} AND workspace_id = ${WS}
    `;
    const res = await app.request("/entities?kind=organization&limit=200", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toContain(ent.id);
  });

  it("update: PATCH persists a rename", async () => {
    const ent = await createEntityViaApi("Old Name Inc");
    const res = await app.request(`/entities/${ent.id}`, {
      method: "PATCH",
      headers: authed(),
      body: JSON.stringify({ name: "New Name Inc" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("New Name Inc");
    const rows = await admin<Array<{ name: string }>>`
      SELECT name FROM mnemosyne.mnemo_entity WHERE id = ${ent.id} AND workspace_id = ${WS}
    `;
    expect(rows[0]?.name).toBe("New Name Inc");
  });

  it("an empty PATCH body returns 400 (not a silent no-op updated_at bump)", async () => {
    const ent = await createEntityViaApi("Untouched Inc");
    const res = await app.request(`/entities/${ent.id}`, {
      method: "PATCH",
      headers: authed(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("workspace isolation: an entity created in WS_OTHER never appears in WS's list", async () => {
    const entOther = await createEntityViaApi("Other WS Entity", {}, authedOther());
    const res = await app.request("/entities?limit=200", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).not.toContain(entOther.id);
  });
});

describe("memory_entity action:'linked_facts' — ENTITY-1: memory_relate('part_of'/'member_of', fact->entity) now backfills entity_id", () => {
  it("REGRESSION (was: FINDING, structurally unreachable): a 'part_of' fact->entity relation backfills mnemo_fact.entity_id, and linked_facts picks it up", async () => {
    const ent = await createEntityViaApi("Probe Project");
    const factId = await createFactViaApi("Probe Project uses Postgres 17");

    // Exactly what memory_relate sends.
    const relRes = await app.request("/relations", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        sourceKind: "fact",
        sourceId: factId,
        targetKind: "entity",
        targetId: ent.id,
        relation: "part_of",
        markedByKind: "agent",
      }),
    });
    expect(relRes.status).toBe(201);

    // GROUND TRUTH FIRST.
    const factRow = await admin<Array<{ entity_id: string | null }>>`
      SELECT entity_id FROM mnemosyne.mnemo_fact WHERE id = ${factId} AND workspace_id = ${WS}
    `;
    expect(factRow[0]?.entity_id).toBe(ent.id);

    const res = await app.request(`/entities/${ent.id}/facts`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { facts: Array<{ id: string }> };
    expect(body.facts.map((f) => f.id)).toContain(factId);
  });

  it("'member_of' also backfills entity_id (verb symmetry with part_of)", async () => {
    const ent = await createEntityViaApi("Member Project");
    const factId = await createFactViaApi("A fact that is a member of the project");

    const relRes = await app.request("/relations", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        sourceKind: "fact",
        sourceId: factId,
        targetKind: "entity",
        targetId: ent.id,
        relation: "member_of",
        markedByKind: "agent",
      }),
    });
    expect(relRes.status).toBe(201);

    const factRow = await admin<Array<{ entity_id: string | null }>>`
      SELECT entity_id FROM mnemosyne.mnemo_fact WHERE id = ${factId} AND workspace_id = ${WS}
    `;
    expect(factRow[0]?.entity_id).toBe(ent.id);
  });

  it("FIRST WINS: a second part_of relation to a DIFFERENT entity does NOT overwrite an already-linked fact", async () => {
    const entA = await createEntityViaApi("First Entity");
    const entB = await createEntityViaApi("Second Entity");
    const factId = await createFactViaApi("A fact linked to entA first");

    const first = await app.request("/relations", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        sourceKind: "fact",
        sourceId: factId,
        targetKind: "entity",
        targetId: entA.id,
        relation: "part_of",
        markedByKind: "agent",
      }),
    });
    expect(first.status).toBe(201);

    // Second relation, different entity, different verb — the relation
    // itself still succeeds (memory_relate is unaffected); only the
    // entity_id backfill is a no-op.
    const second = await app.request("/relations", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        sourceKind: "fact",
        sourceId: factId,
        targetKind: "entity",
        targetId: entB.id,
        relation: "member_of",
        markedByKind: "agent",
      }),
    });
    expect(second.status).toBe(201);

    const factRow = await admin<Array<{ entity_id: string | null }>>`
      SELECT entity_id FROM mnemosyne.mnemo_fact WHERE id = ${factId} AND workspace_id = ${WS}
    `;
    expect(factRow[0]?.entity_id).toBe(entA.id);
  });

  it("does NOT backfill for the reverse direction (entity->fact) — only fact->entity is a real 'this fact belongs to this entity' claim", async () => {
    const ent = await createEntityViaApi("Reverse Direction Project");
    const factId = await createFactViaApi("A fact related the other way around");

    const relRes = await app.request("/relations", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        sourceKind: "entity",
        sourceId: ent.id,
        targetKind: "fact",
        targetId: factId,
        relation: "part_of",
        markedByKind: "agent",
      }),
    });
    expect(relRes.status).toBe(201);

    const factRow = await admin<Array<{ entity_id: string | null }>>`
      SELECT entity_id FROM mnemosyne.mnemo_fact WHERE id = ${factId} AND workspace_id = ${WS}
    `;
    expect(factRow[0]?.entity_id).toBeNull();
  });

  it("does NOT backfill for unrelated verbs (e.g. 'related') even in the fact->entity direction", async () => {
    const ent = await createEntityViaApi("Unrelated Verb Project");
    const factId = await createFactViaApi("A fact merely 'related' to the project, not part of it");

    const relRes = await app.request("/relations", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        sourceKind: "fact",
        sourceId: factId,
        targetKind: "entity",
        targetId: ent.id,
        relation: "related",
        markedByKind: "agent",
      }),
    });
    expect(relRes.status).toBe(201);

    const factRow = await admin<Array<{ entity_id: string | null }>>`
      SELECT entity_id FROM mnemosyne.mnemo_fact WHERE id = ${factId} AND workspace_id = ${WS}
    `;
    expect(factRow[0]?.entity_id).toBeNull();
  });

  it("CONTROL: a fact whose entity_id is set DIRECTLY is returned by linked_facts (proves the join itself works)", async () => {
    const ent = await createEntityViaApi("Control Project");
    const factId = await createFactViaApi("Control fact directly linked to entity");

    await admin`
      UPDATE mnemosyne.mnemo_fact SET entity_id = ${ent.id}
      WHERE id = ${factId} AND workspace_id = ${WS}
    `;

    const res = await app.request(`/entities/${ent.id}/facts`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { facts: Array<{ id: string }> };
    expect(body.facts.map((f) => f.id)).toContain(factId);

    const getRes = await app.request(`/entities/${ent.id}`, { headers: authed() });
    const getBody = (await getRes.json()) as { linkedFactCount: number };
    expect(getBody.linkedFactCount).toBeGreaterThanOrEqual(1);
  });
});
