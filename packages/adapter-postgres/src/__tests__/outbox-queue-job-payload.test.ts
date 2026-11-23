import { describe, expect, it, vi } from "vitest";
import { OutboxWorker } from "../OutboxWorker.js";
import type { OutboxEntry } from "@mnemo-ai/types";

// P74 — the outbox→queue boundary silently dropped job arguments.
//
// The canonical `queue_job` payload nests its arguments under `data`, which is
// what this worker destructures. Two producers (`staging_evaluation` and
// `anomaly_review`) wrote them FLAT alongside `job`, so `data` came back
// undefined and `{}` was enqueued — the content never travelled, and nothing
// anywhere raised an error. Both producers are fixed at the source, but rows
// written before the fix are still sitting in `mnemo_outbox` (purge_outbox()
// has never had a TS caller), so the flat form must stay readable for those
// rows to be recoverable.

function makeEntry(payload: unknown): OutboxEntry {
  return {
    id: "outbox-1",
    workspaceId: "ws-1",
    eventType: "queue_job",
    payload,
    createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    claimedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    processedAt: null,
    attempts: 0,
    lastError: null,
  } as unknown as OutboxEntry;
}

function makeWorker(entry: OutboxEntry) {
  const enqueue = vi.fn(async () => "job-1");
  const warn = vi.fn();
  const storage = {
    claimOutbox: vi.fn(async () => [entry]),
    markOutboxProcessed: vi.fn(async () => {}),
    markOutboxFailed: vi.fn(async () => {}),
    reapDeadLetters: vi.fn(async () => 0),
  };
  const worker = new OutboxWorker(
    storage as never,
    {} as never,
    {} as never,
    { enqueue } as never,
    { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() } as never
  );
  return { worker, enqueue, warn, storage };
}

describe("OutboxWorker: queue_job payload shapes (P74)", () => {
  it("passes nested `data` straight through — the canonical shape", async () => {
    const { worker, enqueue } = makeWorker(
      makeEntry({ job: "scoped_semantic_conflict_check", data: { factId: "f-1" } })
    );

    await worker.runBatch();

    expect(enqueue).toHaveBeenCalledWith(
      "scoped_semantic_conflict_check",
      { factId: "f-1" },
      undefined
    );
  });

  it("recovers a legacy flat payload instead of enqueuing an empty object", async () => {
    const { worker, enqueue, warn } = makeWorker(
      makeEntry({
        job: "staging_evaluation",
        kind: "fact",
        content: "we use Postgres",
        subject: "workspace",
        pe: 0.02,
      })
    );

    await worker.runBatch();

    // The whole bug in one assertion: this used to be `{}`.
    expect(enqueue).toHaveBeenCalledWith(
      "staging_evaluation",
      { kind: "fact", content: "we use Postgres", subject: "workspace", pe: 0.02 },
      undefined
    );
    expect(warn).toHaveBeenCalled();
  });

  it("does not invent arguments for a job that genuinely carries none", async () => {
    const { worker, enqueue, warn } = makeWorker(makeEntry({ job: "reaper_tick" }));

    await worker.runBatch();

    expect(enqueue).toHaveBeenCalledWith("reaper_tick", {}, undefined);
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves `opts` and keeps it out of the promoted arguments", async () => {
    const { worker, enqueue } = makeWorker(
      makeEntry({ job: "anomaly_review", id: "f-9", opts: { priority: 5 } })
    );

    await worker.runBatch();

    expect(enqueue).toHaveBeenCalledWith("anomaly_review", { id: "f-9" }, { priority: 5 });
  });
});

// APP-010 (audit 2026-11-22): an entry was marked processed when the queue
// accepted the job, not when the job ran. The production queue sheds low
// priority jobs under load (returning a sentinel), drops jobs with no handler
// and runs handlers detached, so a shed, orphaned or failing
// scoped_semantic_conflict_check vanished while the outbox said "done".
describe("OutboxWorker: an entry is done only when its work is (APP-010)", () => {
  it("a queue that refuses the job leaves the entry failed, to be retried", async () => {
    const { worker, enqueue, storage } = makeWorker(
      makeEntry({ job: "scoped_semantic_conflict_check", data: { factId: "f-1" } })
    );
    enqueue.mockRejectedValueOnce(new Error("shed under load"));

    expect(await worker.runBatch()).toBe(0);
    expect(storage.markOutboxProcessed).not.toHaveBeenCalled();
    expect(storage.markOutboxFailed).toHaveBeenCalledWith("outbox-1", expect.stringContaining("shed"));
  });

  it("an event type this build does not know is left for one that does", async () => {
    const entry = { ...makeEntry({}), eventType: "from_a_newer_release" } as unknown as OutboxEntry;
    const { worker, storage } = makeWorker(entry);

    expect(await worker.runBatch()).toBe(0);
    expect(storage.markOutboxProcessed).not.toHaveBeenCalled();
    expect(storage.markOutboxFailed).toHaveBeenCalledWith(
      "outbox-1",
      expect.stringContaining("from_a_newer_release")
    );
  });
});
