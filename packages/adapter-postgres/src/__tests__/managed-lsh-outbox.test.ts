import { describe, it, expect, vi } from "vitest";
import { lshBands, type OutboxEntry } from "@mnemo-ai/types";
import { OutboxWorker } from "../OutboxWorker.js";

function setup(indexLsh = true) {
  const embedding = new Float32Array(Array.from({ length: 64 }, (_, i) => Math.sin(i)));
  const entry: OutboxEntry = {
    id: "outbox-managed",
    workspaceId: "workspace-1",
    eventType: "vector_upsert",
    payload: {
      id: "fact-1",
      kind: "fact",
      text: "Safe extracted fact",
      revision: 2,
      operationId: "managed-operation",
      indexLsh,
    },
    createdAt: new Date(0),
    attempts: 0,
  } as OutboxEntry;
  const order: string[] = [];
  const storage = {
    claimOutbox: vi.fn(async () => [entry]),
    markOutboxProcessed: vi.fn(async () => {
      order.push("ack");
    }),
    markOutboxFailed: vi.fn(async () => {
      order.push("retry");
    }),
    upsertFactLsh: vi.fn(async (_input: unknown) => {
      order.push("lsh");
    }),
  };
  const vector = {
    upsert: vi.fn(async () => {
      order.push("vector");
    }),
  };
  const embed = { model: "deterministic", embedSingle: vi.fn(async () => embedding) };
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const worker = new OutboxWorker(
    storage as never,
    vector as never,
    {} as never,
    {} as never,
    logger as never,
    {},
    embed as never
  );
  return { worker, storage, order, embedding };
}

describe("managed vector outbox includes durable LSH indexing", () => {
  it("acknowledges only after applying vector and canonical LSH bands", async () => {
    const { worker, storage, order, embedding } = setup();
    expect(await worker.runBatch()).toBe(1);
    expect(order).toEqual(["vector", "lsh", "ack"]);
    expect(storage.upsertFactLsh).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      factId: "fact-1",
      revision: 2,
      bands: lshBands(embedding),
    });
  });

  it("retains the vector job for retry after LSH fails", async () => {
    const { worker, storage, order } = setup();
    storage.upsertFactLsh.mockRejectedValueOnce(new Error("LSH unavailable"));
    expect(await worker.runBatch()).toBe(0);
    expect(storage.markOutboxProcessed).not.toHaveBeenCalled();
    expect(storage.markOutboxFailed).toHaveBeenCalledWith("outbox-managed", "LSH unavailable");
    expect(await worker.runBatch()).toBe(1);
    expect(order).toEqual(["vector", "retry", "vector", "lsh", "ack"]);
  });

  it("preserves the legacy unmarked vector job contract", async () => {
    const { worker, storage, order } = setup(false);
    expect(await worker.runBatch()).toBe(1);
    expect(storage.upsertFactLsh).not.toHaveBeenCalled();
    expect(order).toEqual(["vector", "ack"]);
  });
});
