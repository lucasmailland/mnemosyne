/**
 * P74/P111 — the outbox purge cannot delete a write that has not been recovered.
 *
 * `purgeOutbox` was implemented in every adapter and had no caller for months,
 * so `mnemo_outbox` only grew (2308 rows on the dev instance, 1090 of them long
 * past any retention). What kept it unwired was an ordering rule written in a
 * backlog entry: "wire the purge only after running the P74 backfill".
 *
 * The rule was correct. Until P74, a write whose prediction error fell below the
 * surprise threshold was diverted into a `staging_evaluation` queue job instead
 * of being written, and its content still exists ONLY in the outbox row —
 * `scripts/backfill-p74-staged-writes.mjs` replays it through POST /remember.
 *
 * The trap is that those rows look ordinary. The worker claimed them,
 * destructured `{job, data, opts}` out of a flat payload, got `{}`, and stamped
 * `processed_at` anyway. So `processed_at IS NOT NULL` holds for every one of
 * them, and on the dev instance all 201 are past any sane cutoff: a plain purge
 * takes the lot, silently, and the content is gone for good.
 *
 * A rule that lives in a document protects nothing — it is exactly why this
 * method sat caller-less rather than safe. So the rule is now a predicate
 * inside `purgeOutbox`, and this file is what stops someone from "simplifying"
 * it back out.
 */
import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

const HOUR = 60 * 60 * 1000;
const RETENTION = 7 * 24 * HOUR;
// determinism-ok: purgeOutbox derives its cutoff from Date.now(), so "older than any retention" has to be relative too
const LONG_AGO = new Date(Date.now() - 30 * 24 * HOUR); // determinism-ok: relative offset, not a fixed instant

interface SeedEntry {
  eventType: string;
  payload: Record<string, unknown>;
}

/** Seed an outbox row that is processed and far older than any retention window. */
function seedProcessed(storage: InMemoryStorageAdapter, entry: SeedEntry) {
  const state = (storage as unknown as { state: { outbox: unknown[] } }).state;
  const row = {
    id: `ob-${state.outbox.length + 1}`,
    workspaceId: "ws-1",
    eventType: entry.eventType,
    payload: entry.payload,
    createdAt: LONG_AGO,
    attempts: 1,
    processed: true,
    processedAt: LONG_AGO,
  };
  state.outbox.push(row);
  return row.id;
}

function remainingIds(storage: InMemoryStorageAdapter): string[] {
  const state = (storage as unknown as { state: { outbox: Array<{ id: string }> } }).state;
  return state.outbox.map((e) => e.id);
}

describe("P74/P111 — purgeOutbox spares unrecovered discarded writes", () => {
  it("does NOT delete a staging_evaluation job that was never backfilled", async () => {
    // THE test. This row is processed and 30 days old, so every ordinary rule
    // says purge it — and its `content` exists in no other table.
    const storage = new InMemoryStorageAdapter();
    const discarded = seedProcessed(storage, {
      eventType: "queue_job",
      payload: { job: "staging_evaluation", content: "un hecho que nunca se escribió" },
    });

    await storage.purgeOutbox(RETENTION);

    expect(remainingIds(storage)).toContain(discarded);
  });

  it("DOES delete it once the backfill has stamped it", async () => {
    // The other half — otherwise the predicate is a leak, not a guard: these
    // rows would accumulate forever with no way to ever clear them.
    const storage = new InMemoryStorageAdapter();
    const recovered = seedProcessed(storage, {
      eventType: "queue_job",
      payload: {
        job: "staging_evaluation",
        content: "ya replicado",
        p74BackfilledAt: "2026-08-14T00:00:00Z",
      },
    });

    const purged = await storage.purgeOutbox(RETENTION);

    expect(purged).toBe(1);
    expect(remainingIds(storage)).not.toContain(recovered);
  });

  it("still purges ordinary processed rows — the guard is narrow, not a veto", async () => {
    // The purge has to actually do its job. A predicate that spared everything
    // would leave the method wired and useless, which is the shape this whole
    // wiring exercise exists to remove.
    const storage = new InMemoryStorageAdapter();
    const ordinary = seedProcessed(storage, {
      eventType: "vector_upsert",
      payload: { id: "f1", kind: "fact" },
    });
    const otherJob = seedProcessed(storage, {
      eventType: "queue_job",
      payload: { job: "hot_rebuild", workspaceId: "ws-1" },
    });

    const purged = await storage.purgeOutbox(RETENTION);

    expect(purged).toBe(2);
    expect(remainingIds(storage)).not.toContain(ordinary);
    expect(remainingIds(storage)).not.toContain(otherJob);
  });

  it("leaves an unprocessed row alone regardless of age", async () => {
    // Pre-existing behaviour, pinned so the new predicate cannot regress it.
    const storage = new InMemoryStorageAdapter();
    const state = (storage as unknown as { state: { outbox: unknown[] } }).state;
    state.outbox.push({
      id: "ob-pending",
      workspaceId: "ws-1",
      eventType: "vector_upsert",
      payload: { id: "f2", kind: "fact" },
      createdAt: LONG_AGO,
      attempts: 0,
    });

    await storage.purgeOutbox(RETENTION);

    expect(remainingIds(storage)).toContain("ob-pending");
  });

  it("keeps the discarded row while purging its neighbours in the same sweep", async () => {
    // The realistic shape: one sweep, mixed rows. A guard that only works when
    // the row is alone is not a guard.
    const storage = new InMemoryStorageAdapter();
    const discarded = seedProcessed(storage, {
      eventType: "queue_job",
      payload: { job: "staging_evaluation", content: "irrecuperable si se borra" },
    });
    seedProcessed(storage, { eventType: "vector_upsert", payload: { id: "f3", kind: "fact" } });
    seedProcessed(storage, { eventType: "vector_upsert", payload: { id: "f4", kind: "fact" } });

    const purged = await storage.purgeOutbox(RETENTION);

    expect(purged).toBe(2);
    expect(remainingIds(storage)).toEqual([discarded]);
  });
});
