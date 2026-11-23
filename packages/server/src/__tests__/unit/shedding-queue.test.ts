import { describe, it, expect, vi } from "vitest";
import { createSheddingQueue } from "../../resilience/sheddingQueue.js";
import type { QueueAdapter } from "@mnemo-ai/types";

function fakeQueue(): QueueAdapter & { enqueued: string[] } {
  const enqueued: string[] = [];
  return {
    id: "fake",
    enqueued,
    async enqueue(job) { enqueued.push(job); return "job_" + job; },
    async schedule() {},
    async process() {},
    async healthCheck() { return { status: "ok", latencyMs: 0 }; },
    async close() {},
  };
}

describe("§34.8 shedding queue gate", () => {
  it("passes critical jobs even at stage 3 (95%+)", async () => {
    const inner = fakeQueue();
    const q = createSheddingQueue(inner, { poolUtil: () => 0.97 });
    expect(await q.enqueue("session.collapse", {})).toMatch(/^job_/);
    expect(inner.enqueued).toContain("session.collapse");
  });

  it("sheds a low-priority job at stage 1 (70%+)", async () => {
    const inner = fakeQueue();
    const q = createSheddingQueue(inner, { poolUtil: () => 0.72 });
    await expect(q.enqueue("anticipate.mine", {})).rejects.toMatchObject({ name: "QueueShedError" });
    expect(inner.enqueued).not.toContain("anticipate.mine");
  });

  it("sheds medium at stage 2 but not high", async () => {
    const inner = fakeQueue();
    const q = createSheddingQueue(inner, { poolUtil: () => 0.88 });
    await expect(q.enqueue("consolidation", {})).rejects.toMatchObject({ name: "QueueShedError" });
    expect(await q.enqueue("embed.fact", {})).toMatch(/^job_/);
  });

  it("stamps opts.priority from the job's tier", async () => {
    const inner = fakeQueue();
    const seen: number[] = [];
    inner.enqueue = vi.fn(async (_job, _d, opts) => { seen.push(opts?.priority ?? -1); return "x"; });
    const q = createSheddingQueue(inner, { poolUtil: () => 0.0 });
    await q.enqueue("embed.fact", {});
    expect(seen[0]).toBe(2);
  });
});

// APP-010 (audit 2026-11-22): a shed job used to come back as the string
// "shed", indistinguishable from a job id at the only call site (the outbox
// worker), which then marked the entry processed. Shedding now rejects, so the
// outbox keeps the entry and retries it once the pressure drops.
describe("shedding is a refusal, not a success (APP-010)", () => {
  it("rejects a shed job with a retryable error", async () => {
    const inner = fakeQueue();
    const q = createSheddingQueue(inner, { poolUtil: () => 0.72 });
    await expect(q.enqueue("anticipate.mine", {})).rejects.toMatchObject({
      name: "QueueShedError",
      retryable: true,
    });
    expect(inner.enqueued).not.toContain("anticipate.mine");
  });
});
