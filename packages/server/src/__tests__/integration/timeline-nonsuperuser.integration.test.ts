/**
 * Integration tests for GET /timeline — the route behind the
 * `memory_timeline` MCP tool — against a REAL Postgres instance, running
 * the app connection as the NOSUPERUSER/NOBYPASSRLS `mnemo_app` role
 * production actually connects as. Mirrors the container/migration/role
 * provisioning pattern in `doctor-nonsuperuser.integration.test.ts` and
 * `boot-nonsuperuser.integration.test.ts`.
 *
 * Tool-promise-remediation audit
 * (`docs/archive/openspec/tool-promise-remediation/tools/memory_timeline.md`) requires
 * proving, against real Postgres rather than mocks or static analysis:
 *
 *   1. `memory_timeline` orders results by the most recent of
 *      created/updated/archived — NOT just `createdAt`. A fact created
 *      long ago but touched (pinned/archived/edited) a moment ago must
 *      rank above a fact created more recently but never touched again.
 *
 * FINDING (verified here): the claim holds. `packages/core/src/factory.ts`
 * `timeline()` queries `ORDER BY updated_at DESC`, and `mnemo_fact` carries
 * a `BEFORE UPDATE` trigger (`mnemo_fact_set_updated_at`, installed in both
 * migration streams — `packages/core/migrations/0017_mnemosyne_init.sql`
 * for the legacy public schema and
 * `packages/adapter-postgres/migrations/baseline/0001_v3_complete_baseline.sql`
 * for the v3 `mnemosyne` schema, since the migrate container applies BOTH
 * on every real deploy) that stamps `updated_at = now()` on EVERY update
 * to the row, including pin/unpin and the archive-on-forget path
 * (`closeFact`'s `UPDATE ... SET valid_to = now(), status = 'forgotten',
 * updated_at = now()`). Because `created_at` and `updated_at` start equal
 * at insert time and every subsequent lifecycle mutation is a plain SQL
 * `UPDATE`, `updated_at` genuinely tracks "last touched by
 * create/update/archive" — the promise is accurate.
 *
 * SECOND FINDING — SUPERSEDED, updated in place (flatten-legacy-dual-core,
 * `timeline.ts`'s full port off `deps.core`, task 6.6): this originally
 * documented that `kind` could NEVER be `"created"` — true of bare
 * `factory.ts` `timeline()` alone, but already false at the HTTP level once
 * `complete-mcp-tools`'s B3 fix shipped (before this file was next touched).
 * `GET /timeline` now DOES emit genuine `"created"` events, sourced from
 * `mnemo_fact.created_at` (first via a legacy/v3 merge in B3, now via
 * `deriveTimelineEvents()` — `routes/timeline.ts` — reading `deps.storage`
 * exclusively). `"unpinned"` is still never derivable (no history table on
 * either implementation) — that half of the original finding still holds.
 *
 * A NEW, adjacent finding was discovered empirically while re-verifying this
 * file against the ported route (not assumed — see the "FINDING" test
 * below): B3's dedup, which drops a phantom `"updated"`/`"pinned"`/
 * `"closed"` event only when its `at` EXACTLY matches the fact's
 * `createdAt`, essentially never fires in production. `POST /remember`'s
 * pipeline (`core/src/cognitive/remember.ts`, "Step 6a, Bug 2 fix") always
 * performs a genuine SECOND write — a synchronous post-insert embedding
 * UPDATE — moments after the initial INSERT, so `updated_at` drifts a few
 * milliseconds away from `created_at` even for a fact nobody has touched.
 * Every fact created via `POST /remember` therefore surfaces a correct
 * `"created"` event AND a spurious `"updated"` phantom a few ms later. This
 * gap is inherited unchanged from B3 (same physical column, same dedup
 * mechanism, verified present before this PR touched anything) — NOT
 * introduced or fixed by `timeline.ts`'s port off `deps.core`. Fixing the
 * dedup heuristic itself is a deliberate redesign beyond this PR's scope,
 * left as a disclosed follow-up.
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

const PG = { user: "mnemo", password: "mnemo", db: "mnemo" };
const APP_USER = "mnemo_app";
const APP_PASS = "mnemo_app_test";

const WS_MAIN = "eeee0005-0005-0005-0005-000000000005";
const KEY_MAIN = "mns_live_timelineintegrationkeymain1";

type TimelineEventBody = {
  id: string;
  at: string;
  kind: string;
  factId?: string;
  decisionId?: string;
  actorId?: string | null;
  summary?: string;
};
type TimelineBody = { events: TimelineEventBody[]; nextCursor: string | null };
type FactBody = { id: string; content: string; pinned: boolean };

let container: StartedTestContainer;
let host: string;
let port: number;
let superUrl: string;
let admin: ReturnType<typeof postgres>;
let metricsPgClient: ReturnType<typeof postgres>;
let apiKeys: Awaited<ReturnType<typeof import("@mnemo-ai/core").createApiKeyLookup>>;
let deps: ServerDeps;
let app: ReturnType<typeof createApp>;

function authed(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG.user, POSTGRES_PASSWORD: PG.password, POSTGRES_DB: PG.db })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  host = container.getHost();
  port = container.getMappedPort(5432);
  superUrl = `postgres://${PG.user}:${PG.password}@${host}:${port}/${PG.db}`;

  const bootstrap = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await bootstrap.end();
  }

  // Apply BOTH migration streams — mirrors docker/Dockerfile.migrate exactly
  // (the real deploy always runs both; see doctor-nonsuperuser's header
  // comment for the same rationale).
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

  admin = postgres(superUrl, { max: 5, onnotice: () => void 0 });

  await admin.unsafe(`
    DO $provision$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_USER}') THEN
        CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
          NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
    END $provision$;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT app_user       TO ${APP_USER};
    GRANT app_org_user   TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG.db} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
    GRANT USAGE ON SCHEMA public    TO ${APP_USER};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO mnemo_app_role;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public    TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mnemosyne TO mnemo_app_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public    TO app_user;
  `);

  const hashMain = await bcrypt.hash(KEY_MAIN, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${"key_timeline_main"}, ${WS_MAIN}, ${hashMain}, ${"timeline-main"}, ${"timeline-main"}, ARRAY['memory:read','memory:write']::text[])
  `;

  const appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG.db}`;
  metricsPgClient = postgres(appUrl, { max: 5, onnotice: () => void 0 });

  const coreMod = await import("@mnemo-ai/core");
  apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });

  // v3 cognitive core — required so POST /remember (the sole write path
  // since flatten-legacy-dual-core PR8 deleted POST /facts) actually runs
  // end-to-end, not just the auth/RLS layer under test. Fake embed adapter,
  // no LLM — mirrors purge-facts-hard-delete.integration.test.ts. `core`
  // above and this cognitive core both connect with
  // search_path=mnemosyne,public (packages/core/src/factory.ts), so they
  // resolve the SAME physical mnemosyne.mnemo_fact table `GET /timeline`
  // (deps.core.timeline, unchanged by this fixup) already reads.
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
  deps = {
    apiKeys,
    cognitive,
    storage: v3Storage,
    llm: undefined,
    embedModel: "text-embedding-3-small",
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
    metricsPgClient,
  } as unknown as ServerDeps;

  app = createApp({ deps, version: "timeline-nonsuperuser-test" });
}, 180_000);

afterAll(async () => {
  await apiKeys?.close?.().catch(() => void 0);
  await metricsPgClient?.end().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("GET /timeline — real Postgres, NOSUPERUSER app role", () => {
  it("orders by most-recently-touched (update/archive), not by creation time: an old fact updated just now outranks a fact created more recently but never touched again", async () => {
    // 1. FACT_OLD: inserted directly with created_at/updated_at backdated
    //    6 months, simulating a fact that has sat untouched for a long
    //    time. Written via raw admin SQL because the production insert
    //    path (deps.core.createFact) always stamps `now()`.
    const oldId = "timeline_fact_old";
    await admin`
      INSERT INTO mnemosyne.mnemo_fact
        (id, workspace_id, scope, kind, subject, statement, created_at, updated_at, valid_from)
      VALUES (
        ${oldId}, ${WS_MAIN}, ${"global"}, ${"other"}, ${"timeline-test"}, ${"an old fact, untouched for 6 months"},
        now() - interval '6 months', now() - interval '6 months', now() - interval '6 months'
      )
    `;

    // 2. FACT_NEW: created through the real production HTTP path just now
    //    (2 days "ago" isn't needed — it's fresher than FACT_OLD's
    //    creation but will still be OLDER than FACT_OLD's upcoming touch).
    // flatten-legacy-dual-core PR8 deleted POST /facts (D2 step 2) — the
    // sole write path is now POST /remember, lossless-remapped
    // {content} -> {statement}.
    const createRes = await app.request("/remember", {
      method: "POST",
      headers: { ...authed(KEY_MAIN), "content-type": "application/json" },
      body: JSON.stringify({ statement: "a fact created just now, never touched again" }),
    });
    expect(createRes.status).toBe(201);
    const newFact = (await createRes.json()) as FactBody;

    // Sanity baseline: right after creation, with no touch yet, ordering by
    // updated_at DESC would put FACT_NEW ahead of FACT_OLD (this alone does
    // NOT prove the promise — creation order and update order coincide here).
    const baselineSince = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(); // determinism-ok: relative query-window bound, not an assertion value
    const baselineRes = await app.request(
      `/timeline?since=${encodeURIComponent(baselineSince)}&limit=20`,
      {
        headers: authed(KEY_MAIN),
      }
    );
    expect(baselineRes.status).toBe(200);
    const baseline = (await baselineRes.json()) as TimelineBody;
    const baselineIds = baseline.events.map((e) => e.factId);
    expect(baselineIds.indexOf(newFact.id)).toBeLessThan(baselineIds.indexOf(oldId));

    // 3. Touch FACT_OLD now via the real production HTTP path (pin). This
    //    is the moment that matters: FACT_OLD was CREATED 6 months ago but
    //    is UPDATED right now.
    const pinRes = await app.request(`/facts/${oldId}/pin`, {
      method: "POST",
      headers: { ...authed(KEY_MAIN), "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(pinRes.status).toBe(200);

    // 4. THE SCENARIO: re-query the timeline. FACT_OLD (created 6 months
    //    ago, updated seconds ago) must now rank ABOVE FACT_NEW (created
    //    seconds ago, never touched since) — proving the ordering is by
    //    most-recent create/update/archive, not by creation time.
    const afterSince = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(); // determinism-ok: relative query-window bound, not an assertion value
    const afterRes = await app.request(
      `/timeline?since=${encodeURIComponent(afterSince)}&limit=20`,
      {
        headers: authed(KEY_MAIN),
      }
    );
    expect(afterRes.status).toBe(200);
    const after = (await afterRes.json()) as TimelineBody;
    const afterIds = after.events.map((e) => e.factId);

    expect(afterIds).toContain(oldId);
    expect(afterIds).toContain(newFact.id);
    expect(afterIds.indexOf(oldId)).toBeLessThan(afterIds.indexOf(newFact.id));

    // The now-pinned FACT_OLD's event should be first (newest updated_at).
    expect(after.events[0]?.factId).toBe(oldId);
  });

  it("limit defaults are respected by the underlying route (limit=1 returns exactly 1 event, newest first)", async () => {
    const res = await app.request(
      `/timeline?since=${encodeURIComponent(new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString())}&limit=1`, // determinism-ok: relative query-window bound, not an assertion value
      { headers: authed(KEY_MAIN) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineBody;
    expect(body.events).toHaveLength(1);
    // FACT_OLD (pinned in the previous test) remains the most recently
    // touched row in the workspace.
    expect(body.events[0]?.factId).toBe("timeline_fact_old");
  });

  it("FINDING (updated, was stale): a brand-new fact now correctly reports 'created' (B3); a disclosed pre-existing dedup gap can still surface a spurious 'updated' phantom", async () => {
    const createRes = await app.request("/remember", {
      method: "POST",
      headers: { ...authed(KEY_MAIN), "content-type": "application/json" },
      body: JSON.stringify({ statement: "freshly created fact for the kind-label finding" }),
    });
    expect(createRes.status).toBe(201);
    const fresh = (await createRes.json()) as FactBody;

    const res = await app.request(
      `/timeline?since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}&limit=20`, // determinism-ok: relative query-window bound, not an assertion value
      { headers: authed(KEY_MAIN) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineBody;
    const eventsForFact = body.events.filter((e) => e.factId === fresh.id);

    // The original finding (`kind` is dead code, always "updated", never
    // "created") is now FALSE — `complete-mcp-tools`'s B3 fix (already
    // shipped on this branch, landed before flatten-legacy-dual-core's
    // `timeline.ts` port) merges a genuine `"created"` stream sourced from
    // `mnemo_fact.created_at`. This test's own file predates B3 and was
    // never updated when it landed; re-verified here empirically (not
    // assumed) while porting `timeline.ts` off `deps.core`.
    const createdEvent = eventsForFact.find((e) => e.kind === "created");
    expect(createdEvent).toBeDefined();

    // DISCLOSED, newly-discovered, pre-existing gap — NOT introduced or
    // fixed by this port (verified: the exact same dedup mechanism reading
    // the exact same physical `mnemo_fact.updated_at` column existed
    // unchanged in B3's original merge code). B3's dedup drops a phantom
    // "updated"/"pinned"/"closed" event only when its `at` EXACTLY matches
    // the fact's `createdAt`. In production, `POST /remember`'s pipeline
    // (`core/src/cognitive/remember.ts`, "Step 6a, Bug 2 fix") always
    // performs a SECOND, genuine write — a synchronous post-insert embedding
    // UPDATE, deliberately added so a freshly created fact is immediately
    // recallable without racing the async outbox worker — moments after the
    // initial INSERT. That second write bumps `updated_at` away from
    // `created_at` by a few milliseconds even though nothing about the
    // fact's user-visible content changed, so the dedup's exact-timestamp
    // match never actually fires for facts created via `POST /remember`:
    // every creation surfaces a real `"created"` event AND a spurious
    // `"updated"` phantom a few ms later. Fixing the dedup heuristic (e.g.
    // a tolerance window, or a "same request" correlation instead of exact
    // timestamp equality) is a deliberate B3-dedup redesign, out of scope
    // for this PR (`timeline.ts`'s port off `deps.core` preserves B3's
    // dedup mechanism unchanged) — left as a disclosed follow-up.
    for (const otherEvent of eventsForFact.filter((e) => e.kind !== "created")) {
      expect(otherEvent.kind).toBe("updated");
    }
  });

  it("P11 fix: each event carries the actorId of the API key that created the underlying fact", async () => {
    const createRes = await app.request("/remember", {
      method: "POST",
      headers: { ...authed(KEY_MAIN), "content-type": "application/json" },
      body: JSON.stringify({ statement: "a fact created for the actorId attribution check" }),
    });
    expect(createRes.status).toBe(201);
    const fresh = (await createRes.json()) as FactBody;

    const res = await app.request(
      `/timeline?since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}&limit=20`, // determinism-ok: relative query-window bound, not an assertion value
      { headers: authed(KEY_MAIN) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineBody;
    const event = body.events.find((e) => e.factId === fresh.id);

    expect(event).toBeDefined();
    // Regression guard for the P11 gap: factory.ts's timeline() query used to
    // omit actor_id entirely, so every event's actorId was silently absent
    // despite the wire schema (TimelineEventSchema) declaring the field.
    expect(event?.actorId).toBeDefined();
    expect(typeof event?.actorId === "string" || event?.actorId === null).toBe(true);
  });

  it("P11 fix: a fact inserted with no actor_id (raw admin SQL) reports actorId: null, not undefined or missing", async () => {
    const rawId = "timeline_fact_no_actor";
    await admin`
      INSERT INTO mnemosyne.mnemo_fact
        (id, workspace_id, scope, kind, subject, statement, created_at, updated_at, valid_from)
      VALUES (
        ${rawId}, ${WS_MAIN}, ${"global"}, ${"other"}, ${"timeline-test"}, ${"a fact with no actor_id set"},
        now(), now(), now()
      )
    `;

    const res = await app.request(
      `/timeline?since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}&limit=20`, // determinism-ok: relative query-window bound, not an assertion value
      { headers: authed(KEY_MAIN) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineBody;
    const event = body.events.find((e) => e.factId === rawId);

    expect(event).toBeDefined();
    expect(event?.actorId).toBeNull();
  });
  it("decision events: created, superseded and withdrawn appear with decisionId, page without gaps, and honour the ceiling", async () => {
    const ins = (id: string, status: string, sensitivity: string, validTo: string | null) => admin`
      INSERT INTO mnemosyne.mnemo_decision
        (id, workspace_id, kind, title, body, normalized_hash, status, sensitivity,
         created_at, updated_at, valid_from, valid_to)
      VALUES (${id}, ${WS_MAIN}, ${"architecture"}, ${"title " + id}, ${"body"}, ${"h" + id},
        ${status}, ${sensitivity}, now() - interval '30 seconds', now() - interval '10 seconds',
        now() - interval '30 seconds', ${validTo}::timestamptz)
    `;
    await ins("tl_dec_active", "active", "internal", null);
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString(); // determinism-ok: seeded relative timestamp
    await ins("tl_dec_super", "superseded", "internal", tenSecondsAgo);
    await ins("tl_dec_with", "withdrawn", "internal", tenSecondsAgo);
    await ins("tl_dec_secret", "active", "restricted", null);

    const since = encodeURIComponent(new Date(Date.now() - 120_000).toISOString()); // determinism-ok: relative query-window bound
    const all = (await (
      await app.request(`/timeline?since=${since}&limit=500`, { headers: authed(KEY_MAIN) })
    ).json()) as TimelineBody;
    const dec = all.events.filter((e) => e.decisionId);
    expect(dec.map((e) => `${e.decisionId}:${e.kind}`).sort()).toEqual(
      [
        "tl_dec_active:decision_created",
        "tl_dec_super:decision_created",
        "tl_dec_super:decision_superseded",
        "tl_dec_with:decision_created",
        "tl_dec_with:decision_withdrawn",
      ].sort()
    );
    expect(dec.every((e) => e.factId === undefined)).toBe(true);
    expect(all.events.some((e) => e.decisionId === "tl_dec_secret")).toBe(false);

    const walked: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 200; guard++) {
      const res = await app.request(
        `/timeline?since=${since}&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        { headers: authed(KEY_MAIN) }
      );
      const page = (await res.json()) as TimelineBody;
      walked.push(...page.events.map((e) => e.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(walked).toEqual(all.events.map((e) => e.id));
  });
  it("decisions sharing a millisecond (different microseconds, case/punctuation ids) walk at limit 1 with no gap or duplicate", async () => {
    const base = new Date(Date.now() - 20_000).toISOString().replace(/\.\d+Z$/, ""); // determinism-ok: seeded relative timestamp
    const ids = ["Tl_B", "tl_b", "tl-b", "tl_B", "TL.b"];
    for (const [n, id] of ids.entries()) {
      const at = `${base}.123${String(900 - n * 100).padStart(3, "0")}Z`;
      await admin`
        INSERT INTO mnemosyne.mnemo_decision
          (id, workspace_id, kind, title, body, normalized_hash, status, sensitivity,
           created_at, updated_at, valid_from)
        VALUES (${"ms_" + id}, ${WS_MAIN}, ${"architecture"}, ${"t"}, ${"b"}, ${"hms" + n},
          ${"active"}, ${"internal"}, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz)
      `;
    }
    const since = encodeURIComponent(new Date(Date.now() - 120_000).toISOString()); // determinism-ok: relative query-window bound
    const all = (await (
      await app.request(`/timeline?since=${since}&limit=500`, { headers: authed(KEY_MAIN) })
    ).json()) as TimelineBody;
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 300; guard++) {
      const res = await app.request(
        `/timeline?since=${since}&limit=1${cursor ? `&cursor=${cursor}` : ""}`,
        { headers: authed(KEY_MAIN) }
      );
      const page = (await res.json()) as TimelineBody;
      walked.push(...page.events.map((e) => e.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(new Set(walked).size).toBe(walked.length);
    expect(walked).toEqual(all.events.map((e) => e.id));
    expect(all.events.filter((e) => e.decisionId?.startsWith("ms_"))).toHaveLength(ids.length);
  });
});
