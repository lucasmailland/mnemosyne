import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { InMemoryQueueAdapter } from "../queueMemory.js";
import { logger } from "../logging.js";

// P74 — this adapter's silence is what let an orphaned producer survive.
//
// `enqueue()` used to return a fresh job id and drop the job on the floor when
// no handler was registered: no error, no log, no dead-letter. From every call
// site an unconsumed job was indistinguishable from a processed one, which is
// how `staging_evaluation` stayed orphaned long enough to lose writes.
// Enqueuing a job nobody consumes is always a wiring bug and must be visible.

describe("InMemoryQueueAdapter: orphaned jobs are loud (P74)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it("warns, naming the job, when no handler is registered", async () => {
    const queue = new InMemoryQueueAdapter();

    // APP-010: the job is refused (the outbox keeps its entry), and still named in a warning.
    await expect(queue.enqueue("staging_evaluation", { content: "we use Postgres" })).rejects.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    const [meta, message] = warn.mock.calls[0] as [{ jobName: string }, string];
    expect(meta.jobName).toBe("staging_evaluation");
    expect(message).toContain("staging_evaluation");
  });

  it("stays quiet on the happy path and delivers the payload", async () => {
    const queue = new InMemoryQueueAdapter();
    const handler = vi.fn(async () => {});
    await queue.process("scoped_semantic_conflict_check", handler);

    await queue.enqueue("scoped_semantic_conflict_check", { factId: "f-1" });
    await new Promise((r) => setImmediate(r));

    expect(warn).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith({ factId: "f-1" });
  });

  it("surfaces a throwing handler instead of swallowing it", async () => {
    const queue = new InMemoryQueueAdapter();
    await queue.process("boom", async () => {
      throw new Error("handler exploded");
    });

    await expect(queue.enqueue("boom", {})).rejects.toThrow("handler exploded");

    expect(error).toHaveBeenCalledTimes(1);
  });
});

// APP-010 (audit 2026-11-22): the only producer is the outbox worker, which
// marks its entry done when enqueue() resolves. So enqueue() now resolves only
// after the handler finished, and rejects when there is no handler or the
// handler threw: the entry is retried and, if it keeps failing, dead-lettered
// where an operator sees it, instead of being marked processed.
describe("InMemoryQueueAdapter: enqueue reports the job's outcome (APP-010)", () => {
  it("rejects when no handler is registered", async () => {
    const queue = new InMemoryQueueAdapter();
    await expect(queue.enqueue("nobody_listens", {})).rejects.toThrow(/nobody_listens/);
  });

  it("resolves only after the handler ran", async () => {
    const queue = new InMemoryQueueAdapter();
    let done = false;
    await queue.process("slow", async () => {
      await new Promise((r) => setTimeout(r, 20));
      done = true;
    });
    await queue.enqueue("slow", {});
    expect(done).toBe(true);
  });

  it("rejects when the handler throws", async () => {
    const queue = new InMemoryQueueAdapter();
    await queue.process("boom2", async () => {
      throw new Error("handler exploded");
    });
    await expect(queue.enqueue("boom2", {})).rejects.toThrow("handler exploded");
  });
});
