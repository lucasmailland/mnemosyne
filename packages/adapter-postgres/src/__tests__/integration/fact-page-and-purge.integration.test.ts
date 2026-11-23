/**
 * flatten-legacy-dual-core PR9b (D6.3) — real-Postgres proof for
 * `FactRepository.queryFactsPage`/`purgeForgottenFacts`, the two new
 * additive `StorageAdapter` methods backing `GET /facts` (list) and
 * `DELETE /facts/purge`. The Tier A parity suite
 * (`facts.parity.test.ts`) only proves query-param FORWARDING against a
 * mock; this file proves the real BEHAVIOR these params control:
 *
 *   - keyset cursor pagination walks every row exactly once, no
 *     duplicates/gaps, across multiple pages
 *   - every `sortBy` option orders rows correctly
 *   - `q` (FTS/ILIKE) actually filters
 *   - `purgeForgottenFacts` hard-deletes forgotten rows but skips rows
 *     carrying the `__mnemoConsolidationPending` marker and never touches
 *     active rows — the exact guard ported 1:1 from legacy
 *     `purgeClosedFacts` (factory.ts)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../../DrizzleStorageAdapter.js";
import { migrate } from "../../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

describe("FactRepository.queryFactsPage / purgeForgottenFacts", () => {
  let container: StartedTestContainer;
  let sql: ReturnType<typeof postgres>;
  let adapter: DrizzleStorageAdapter;
  let adapterClient: ReturnType<typeof createDrizzleClient>;

  beforeAll(async () => {
    container = await new GenericContainer(PG_IMAGE)
      .withEnvironment({
        POSTGRES_USER: PG_USER,
        POSTGRES_PASSWORD: PG_PASSWORD,
        POSTGRES_DB: PG_DB,
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .start();
    const databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${PG_DB}`;
    await migrate({ databaseUrl, log: () => undefined });
    sql = postgres(databaseUrl, { max: 5 });
    adapterClient = createDrizzleClient(databaseUrl);
    adapter = new DrizzleStorageAdapter(adapterClient.db, adapterClient.pgClient);
  }, 120_000);

  afterAll(async () => {
    await adapterClient?.pgClient.end();
    await sql?.end();
    await container?.stop();
  });

  /** Force a fact's created_at/updated_at to an exact instant — bypasses
   * defaultNow() so ordering tests are deterministic regardless of
   * insertion order or wall-clock jitter. `mnemo_fact_updated_at` (a real
   * BEFORE UPDATE trigger, 0001_v3_complete_baseline.sql) unconditionally
   * sets `NEW.updated_at = NOW()` on every UPDATE — it must be disabled for
   * the duration of this stamp or it silently overwrites the value being
   * set here. */
  async function stampTimestamps(id: string, createdAt: Date, updatedAt: Date): Promise<void> {
    await sql`ALTER TABLE mnemosyne.mnemo_fact DISABLE TRIGGER mnemo_fact_updated_at`;
    try {
      await sql`
        UPDATE mnemosyne.mnemo_fact
        SET created_at = ${createdAt}, updated_at = ${updatedAt}
        WHERE id = ${id}
      `;
    } finally {
      await sql`ALTER TABLE mnemosyne.mnemo_fact ENABLE TRIGGER mnemo_fact_updated_at`;
    }
  }

  async function stampRelevanceAndHits(id: string, relevance: number, hitCount: number) {
    await sql`
      UPDATE mnemosyne.mnemo_fact
      SET relevance = ${relevance}, hit_count = ${hitCount}
      WHERE id = ${id}
    `;
  }

  it("keyset-paginates every fact exactly once, no duplicates/gaps (default: updated_at desc)", async () => {
    const workspaceId = crypto.randomUUID();
    // Deliberately out-of-insertion-order timestamps so a passing test
    // proves the SORT works, not just that insertion order happened to
    // match.
    const stamps = [
      { key: "f1", updatedAt: "2026-01-01T00:00:00Z" },
      { key: "f2", updatedAt: "2026-01-05T00:00:00Z" },
      { key: "f3", updatedAt: "2026-01-03T00:00:00Z" },
      { key: "f4", updatedAt: "2026-01-04T00:00:00Z" },
      { key: "f5", updatedAt: "2026-01-02T00:00:00Z" },
    ];
    const idByKey = new Map<string, string>();
    for (const s of stamps) {
      const fact = await adapter.createFact({
        workspaceId,
        scope: "global",
        statement: `pagination fixture ${s.key}`,
        subject: "pagination",
        kind: "other",
        sensitivity: "internal",
      });
      idByKey.set(s.key, fact.id);
      const d = new Date(s.updatedAt);
      await stampTimestamps(fact.id, d, d);
    }
    // Expected order: updated_at DESC → f2(01-05), f4(01-04), f3(01-03), f5(01-02), f1(01-01)
    const expectedOrder = ["f2", "f4", "f3", "f5", "f1"].map((k) => idByKey.get(k)!);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await adapter.queryFactsPage({
        workspaceId,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.total).toBe(5);
      seen.push(...page.items.map((f) => f.id));
      pages += 1;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(10); // guard against an infinite loop bug
    }

    expect(pages).toBe(3); // ceil(5/2)
    expect(seen).toEqual(expectedOrder);
    expect(new Set(seen).size).toBe(5); // no duplicates
  });

  it.each([{ sortBy: "created_at" as const }, { sortBy: "updated_at" as const }])(
    "orders correctly by $sortBy",
    async ({ sortBy }) => {
      const workspaceId = crypto.randomUUID();
      const stamps = ["2026-02-01T00:00:00Z", "2026-02-03T00:00:00Z", "2026-02-02T00:00:00Z"];
      const ids: string[] = [];
      for (const [i, iso] of stamps.entries()) {
        const fact = await adapter.createFact({
          workspaceId,
          scope: "global",
          statement: `sortBy fixture #${i}`,
          subject: "sort",
          kind: "other",
          sensitivity: "internal",
        });
        ids.push(fact.id);
        const d = new Date(iso);
        await stampTimestamps(fact.id, d, d);
      }
      const [id0, id1, id2] = ids as [string, string, string];

      const desc = await adapter.queryFactsPage({ workspaceId, sortBy, order: "desc", limit: 10 });
      expect(desc.items.map((f) => f.id)).toEqual([id1, id2, id0]);

      const asc = await adapter.queryFactsPage({ workspaceId, sortBy, order: "asc", limit: 10 });
      expect(asc.items.map((f) => f.id)).toEqual([id0, id2, id1]);
    }
  );

  it("orders correctly by relevance and hit_count", async () => {
    const workspaceId = crypto.randomUUID();
    const specs = [
      { relevance: 0.2, hitCount: 5 },
      { relevance: 0.9, hitCount: 1 },
      { relevance: 0.5, hitCount: 10 },
    ];
    const ids: string[] = [];
    for (const [i, spec] of specs.entries()) {
      const fact = await adapter.createFact({
        workspaceId,
        scope: "global",
        statement: `relevance/hit_count fixture #${i}`,
        subject: "sort",
        kind: "other",
        sensitivity: "internal",
      });
      ids.push(fact.id);
      await stampRelevanceAndHits(fact.id, spec.relevance, spec.hitCount);
    }
    const [lowRel, highRel, midRel] = ids as [string, string, string];

    const byRelevanceDesc = await adapter.queryFactsPage({
      workspaceId,
      sortBy: "relevance",
      order: "desc",
      limit: 10,
    });
    expect(byRelevanceDesc.items.map((f) => f.id)).toEqual([highRel, midRel, lowRel]);

    const byHitCountAsc = await adapter.queryFactsPage({
      workspaceId,
      sortBy: "hit_count",
      order: "asc",
      limit: 10,
    });
    expect(byHitCountAsc.items.map((f) => f.id)).toEqual([highRel, lowRel, midRel]);
  });

  it("filters via q — matches the ILIKE fallback when the FTS config misses", async () => {
    const workspaceId = crypto.randomUUID();
    const target = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "the deploy runs at midnight in production",
      subject: "deploy",
      kind: "other",
      sensitivity: "internal",
    });
    await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "completely unrelated statement about lunch",
      subject: "lunch",
      kind: "other",
      sensitivity: "internal",
    });

    const page = await adapter.queryFactsPage({ workspaceId, q: "midnight", limit: 10 });
    expect(page.items.map((f) => f.id)).toEqual([target.id]);
    expect(page.total).toBe(1);
  });

  it("respects kind/scopeRef/pinned/sensitivity/status filters", async () => {
    // sensitivity: "internal" throughout — "confidential"/"restricted" fail
    // closed without an actorId to derive a DEK (unrelated to this filter
    // test; C1 fail-closed behavior).
    const workspaceId = crypto.randomUUID();
    const wanted = await adapter.createFact({
      workspaceId,
      scope: "global",
      scopeRef: "proj-x",
      statement: "wanted fact",
      subject: "filter-target",
      kind: "preference",
      sensitivity: "internal",
    });
    await adapter.updateFact(wanted.id, workspaceId, { pinned: true });
    await adapter.createFact({
      workspaceId,
      scope: "global",
      scopeRef: "proj-y",
      statement: "unwanted fact — different scopeRef",
      subject: "filter-noise",
      kind: "preference",
      sensitivity: "internal",
    });
    const noiseKind = await adapter.createFact({
      workspaceId,
      scope: "global",
      scopeRef: "proj-x",
      statement: "unwanted fact — different kind",
      subject: "filter-noise",
      kind: "trait",
      sensitivity: "internal",
    });
    await adapter.updateFact(noiseKind.id, workspaceId, { pinned: true });
    const noiseSensitivity = await adapter.createFact({
      workspaceId,
      scope: "global",
      scopeRef: "proj-x",
      statement: "unwanted fact — different sensitivity",
      subject: "filter-noise",
      kind: "preference",
      sensitivity: "public",
    });
    await adapter.updateFact(noiseSensitivity.id, workspaceId, { pinned: true });
    const noiseUnpinned = await adapter.createFact({
      workspaceId,
      scope: "global",
      scopeRef: "proj-x",
      statement: "unwanted fact — not pinned",
      subject: "filter-noise",
      kind: "preference",
      sensitivity: "internal",
    });
    await adapter.archiveFact(noiseUnpinned.id, workspaceId); // status: forgotten

    const page = await adapter.queryFactsPage({
      workspaceId,
      kind: "preference",
      scopeRef: "proj-x",
      pinned: true,
      sensitivity: "internal",
      limit: 10,
    });
    expect(page.items.map((f) => f.id)).toEqual([wanted.id]);

    const allStatuses = await adapter.queryFactsPage({
      workspaceId,
      status: "all",
      limit: 10,
    });
    expect(allStatuses.total).toBe(5);
  });

  it("purgeForgottenFacts hard-deletes forgotten rows, skips consolidation-pending rows, leaves active rows untouched", async () => {
    const workspaceId = crypto.randomUUID();

    const active = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "still active",
      subject: "purge",
      kind: "other",
      sensitivity: "internal",
    });
    const forgotten = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "forgotten, purgeable",
      subject: "purge",
      kind: "other",
      sensitivity: "internal",
    });
    const forgottenPending = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "forgotten but mid-consolidation",
      subject: "purge",
      kind: "other",
      sensitivity: "internal",
    });

    await sql`UPDATE mnemosyne.mnemo_fact SET status = 'forgotten' WHERE id IN (${forgotten.id}, ${forgottenPending.id})`;
    await sql`
      UPDATE mnemosyne.mnemo_fact
      SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{__mnemoConsolidationPending}',
                               ${sql.json({ operationId: "op-1", survivorId: active.id })})
      WHERE id = ${forgottenPending.id}
    `;

    const deletedCount = await adapter.purgeForgottenFacts(workspaceId, "key:test-purge");
    expect(deletedCount).toBe(1);

    const rows = await sql<Array<{ id: string; status: string }>>`
      SELECT id, status FROM mnemosyne.mnemo_fact WHERE workspace_id = ${workspaceId}
    `;
    const idsRemaining = rows.map((r) => r.id);
    expect(idsRemaining).toContain(active.id);
    expect(idsRemaining).toContain(forgottenPending.id);
    expect(idsRemaining).not.toContain(forgotten.id);
    expect(rows).toHaveLength(2);
  });

  it("purgeForgottenFacts is workspace-scoped — never touches another workspace's forgotten rows", async () => {
    const workspaceA = crypto.randomUUID();
    const workspaceB = crypto.randomUUID();
    const factA = await adapter.createFact({
      workspaceId: workspaceA,
      scope: "global",
      statement: "workspace A forgotten fact",
      subject: "purge-isolation",
      kind: "other",
      sensitivity: "internal",
    });
    const factB = await adapter.createFact({
      workspaceId: workspaceB,
      scope: "global",
      statement: "workspace B forgotten fact",
      subject: "purge-isolation",
      kind: "other",
      sensitivity: "internal",
    });
    await sql`UPDATE mnemosyne.mnemo_fact SET status = 'forgotten' WHERE id IN (${factA.id}, ${factB.id})`;

    const deletedCount = await adapter.purgeForgottenFacts(workspaceA, "key:test-purge");
    expect(deletedCount).toBe(1);

    const [remainingB] = await sql<Array<{ id: string }>>`
      SELECT id FROM mnemosyne.mnemo_fact WHERE id = ${factB.id}
    `;
    expect(remainingB?.id).toBe(factB.id);
  });

  // ── P114 ──────────────────────────────────────────────────────────────────
  // This route was the ONE physical-delete path that left no trace: it appended
  // nothing to mnemo_deletion_log while forget(mode:'hard') and the retention
  // cron both did, and no path cleaned mnemo_fact_hash. Found by noticing a
  // workspace with 7 fact_hash rows against 1 fact.

  it("appends one mnemo_deletion_log row per purged fact, with the caller's actor", async () => {
    const workspaceId = crypto.randomUUID();
    const a = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "audited purge one",
      subject: "p114",
      kind: "other",
      sensitivity: "internal",
    });
    const b = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "audited purge two",
      subject: "p114",
      kind: "other",
      sensitivity: "internal",
    });
    await sql`UPDATE mnemosyne.mnemo_fact SET status = 'forgotten' WHERE id IN (${a.id}, ${b.id})`;

    expect(await adapter.purgeForgottenFacts(workspaceId, "key:auditor-1")).toBe(2);

    const log = await sql<
      Array<{
        deleted_item_id: string;
        deleted_item_type: string;
        deletion_type: string;
        actor_id: string;
      }>
    >`
      SELECT deleted_item_id::text, deleted_item_type, deletion_type, actor_id
        FROM mnemosyne.mnemo_deletion_log
       WHERE workspace_id = ${workspaceId}
       ORDER BY deleted_item_id
    `;
    expect(log).toHaveLength(2);
    expect(log.map((r) => r.deleted_item_id).sort()).toEqual([a.id, b.id].sort());
    for (const row of log) {
      expect(row.deleted_item_type).toBe("fact");
      expect(row.deletion_type).toBe("hard");
      // A namespaced ActorRef (S11), never a bare id and never apiKeyPrefix.
      expect(row.actor_id).toBe("key:auditor-1");
    }
  });

  it("does NOT log a row it refused to delete", async () => {
    const workspaceId = crypto.randomUUID();
    const pending = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "forgotten but mid-consolidation",
      subject: "p114",
      kind: "other",
      sensitivity: "internal",
    });
    await sql`UPDATE mnemosyne.mnemo_fact SET status = 'forgotten' WHERE id = ${pending.id}`;
    await sql`
      UPDATE mnemosyne.mnemo_fact
      SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{__mnemoConsolidationPending}',
                               ${sql.json({ operationId: "op-2" })})
      WHERE id = ${pending.id}
    `;

    expect(await adapter.purgeForgottenFacts(workspaceId, "key:auditor-2")).toBe(0);

    // The consolidation guard skips the row; an audit entry for a deletion that
    // did not happen is worse than none — a rollback would leave the ledger
    // asserting an erasure of a row that is still there, and the ledger is
    // append-only, so the false entry could never be corrected.
    const [{ n }] = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM mnemosyne.mnemo_deletion_log WHERE workspace_id = ${workspaceId}
    `;
    expect(n).toBe(0);
  });

  it("drops the mnemo_fact_hash fingerprint of every purged fact", async () => {
    const workspaceId = crypto.randomUUID();
    const doomed = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "erase me completely",
      subject: "p114",
      kind: "other",
      sensitivity: "internal",
    });
    const survivor = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "keep me",
      subject: "p114",
      kind: "other",
      sensitivity: "internal",
    });
    await adapter.upsertFactHash({
      workspaceId,
      statementHash: "hash-doomed",
      factId: doomed.id,
    });
    await adapter.upsertFactHash({
      workspaceId,
      statementHash: "hash-survivor",
      factId: survivor.id,
    });
    await sql`UPDATE mnemosyne.mnemo_fact SET status = 'forgotten' WHERE id = ${doomed.id}`;

    expect(await adapter.purgeForgottenFacts(workspaceId, "key:auditor-3")).toBe(1);

    // The hash is SHA-256(statement|subject|kind) plus seen_count and
    // timestamps. Leaving it behind erases the statement and preserves a
    // confirmable fingerprint of it: not reversible, but anyone who guesses the
    // statement can verify it existed and how often it was written.
    expect(await adapter.lookupFactHash(workspaceId, "hash-doomed")).toBeNull();
    // Scoped: the surviving fact keeps its own dedup entry, or P85.3's
    // content-hash idempotency would silently stop working after any purge.
    expect(await adapter.lookupFactHash(workspaceId, "hash-survivor")).not.toBeNull();
  });

  it("hardDeleteFact drops the fingerprint too — all physical-delete paths agree", async () => {
    const workspaceId = crypto.randomUUID();
    const fact = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "single hard delete",
      subject: "p114",
      kind: "other",
      sensitivity: "internal",
    });
    await adapter.upsertFactHash({ workspaceId, statementHash: "hash-single", factId: fact.id });

    await adapter.hardDeleteFact!(fact.id, workspaceId);

    expect(await adapter.lookupFactHash(workspaceId, "hash-single")).toBeNull();
  });

  it("hardDeleteFact keeps the fingerprint when the consolidation guard blocks the delete", async () => {
    const workspaceId = crypto.randomUUID();
    const fact = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "blocked hard delete",
      subject: "p114",
      kind: "other",
      sensitivity: "internal",
    });
    await adapter.upsertFactHash({ workspaceId, statementHash: "hash-blocked", factId: fact.id });
    await sql`
      UPDATE mnemosyne.mnemo_fact
      SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{__mnemoConsolidationPending}',
                               ${sql.json({ operationId: "op-3" })})
      WHERE id = ${fact.id}
    `;

    await adapter.hardDeleteFact!(fact.id, workspaceId);

    // The row survived the guard, so its dedup entry must survive too —
    // wiping the hash for a fact that still exists would break the P85.3
    // lookup and silently reintroduce duplicate writes.
    const [{ n }] = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM mnemosyne.mnemo_fact WHERE id = ${fact.id}
    `;
    expect(n).toBe(1);
    expect(await adapter.lookupFactHash(workspaceId, "hash-blocked")).not.toBeNull();
  });
});
