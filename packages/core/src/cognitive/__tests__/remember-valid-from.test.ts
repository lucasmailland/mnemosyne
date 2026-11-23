/**
 * remember() stores a fact's caller-supplied valid time (`validFrom`) instead
 * of dropping it; omitted, the fact is valid from the write.
 */
import { describe, it, expect, vi } from "vitest";

import { remember } from "../remember.js";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { CoreContext } from "../../types.js";

function makeCtx(storage: InMemoryStorageAdapter): CoreContext {
  return {
    storage,
    embed: {
      id: "test-embedder",
      model: "test-model",
      dimensions: 1536,
      semantic: false,
      embedSingle: async () => new Float32Array(1536).fill(0.01),
      embedBatch: async (xs: string[]) => xs.map(() => new Float32Array(1536).fill(0.01)),
    },
    vector: {
      search: async () => [],
      upsert: async () => undefined,
      remove: async () => undefined,
    },
    cache: undefined,
    llm: undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    telemetry: {
      startSpan: () => ({ end: vi.fn(), setAttribute: vi.fn(), recordException: vi.fn() }),
    },
    config: { surpriseThreshold: 0.15 },
  } as unknown as CoreContext;
}

const AUTH = { workspaceId: "ws_1", actorId: "key:k1", actorType: "agent", userId: null } as never;

describe("remember — validFrom", () => {
  it("stores the caller's valid time on a new fact", async () => {
    const storage = new InMemoryStorageAdapter();
    const validFrom = new Date("2026-01-05T09:00:00.000Z");
    const res = await remember(
      makeCtx(storage),
      {
        workspaceId: "ws_1",
        kind: "fact",
        subject: "deploys",
        content: "Deploys on Fridays",
        validFrom,
      } as never,
      AUTH
    );
    expect((await storage.getFact(res.id, "ws_1"))!.validFrom).toEqual(validFrom);
  });

  it("without one, the fact is valid from the write", async () => {
    const storage = new InMemoryStorageAdapter();
    const before = Date.now(); // determinism-ok: a lower bound on the write instant
    const res = await remember(
      makeCtx(storage),
      {
        workspaceId: "ws_1",
        kind: "fact",
        subject: "deploys",
        content: "Deploys on Mondays",
      } as never,
      AUTH
    );
    expect((await storage.getFact(res.id, "ws_1"))!.validFrom.getTime()).toBeGreaterThanOrEqual(
      before
    );
  });
});
