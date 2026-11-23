import { describe, expect, it, vi } from "vitest";
import { OutboxWorker } from "../OutboxWorker.js";
import type { OutboxEntry } from "@mnemo-ai/types";

// PRIM-10 — `vector_delete` ignored `kind` and always cleared
// `mnemo_fact.embedding` for the payload's id. A forgotten decision, strategy
// or event was therefore never removed from anything, while the worker aimed
// a fact-table UPDATE at an id that is not a fact. Only fact deletes (and
// legacy payloads without a kind, which only facts ever produced) may reach
// the fact vector index; the other kinds are excluded from recall by their
// own liveness predicate.

function makeEntry(payload: unknown): OutboxEntry {
  return {
    id: "outbox-1",
    workspaceId: "ws-1",
    eventType: "vector_delete",
    payload,
    createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    claimedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    processedAt: null,
    attempts: 0,
    lastError: null,
  } as unknown as OutboxEntry;
}

function makeWorker(entry: OutboxEntry) {
  const del = vi.fn(async () => undefined);
  const storage = {
    claimOutbox: vi.fn(async () => [entry]),
    markOutboxProcessed: vi.fn(async () => {}),
    markOutboxFailed: vi.fn(async () => {}),
    reapDeadLetters: vi.fn(async () => 0),
  };
  const worker = new OutboxWorker(
    storage as never,
    { delete: del } as never,
    {} as never,
    {} as never,
    { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
  );
  return { worker, del, storage };
}

describe("OutboxWorker: vector_delete is routed by kind (PRIM-10)", () => {
  it.each([[{ id: "f-1", kind: "fact" }], [{ id: "f-1" }]])(
    "clears the fact vector for %j",
    async (payload) => {
      const { worker, del, storage } = makeWorker(makeEntry(payload));
      await worker.runBatch();
      expect(del).toHaveBeenCalledWith("f-1", "ws-1");
      expect(storage.markOutboxProcessed).toHaveBeenCalled();
    }
  );

  it.each(["decision", "event", "strategy", "episode"])(
    "never touches the fact index for a %s id",
    async (kind) => {
      const { worker, del, storage } = makeWorker(makeEntry({ id: "x-1", kind }));
      await worker.runBatch();
      expect(del).not.toHaveBeenCalled();
      expect(storage.markOutboxProcessed).toHaveBeenCalled();
      expect(storage.markOutboxFailed).not.toHaveBeenCalled();
    }
  );
});
