// make-primitives-recallable (PR1, tasks.md 1.5/1.6) — unit coverage for the
// shared, port-only indexing helper.

import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { CoreContext } from "../context.js";
import { projectPrimitiveText, enqueuePrimitiveIndex } from "../indexing.js";

describe("projectPrimitiveText", () => {
  it("projects a fact to its statement field", () => {
    expect(projectPrimitiveText("fact", { statement: "the sky is blue" })).toBe("the sky is blue");
  });

  it("projects a decision to title + separator + body", () => {
    expect(projectPrimitiveText("decision", { title: "Use Postgres", body: "RLS support." })).toBe(
      "Use Postgres RLS support."
    );
  });

  it("skips an absent field instead of emitting the literal string 'undefined'", () => {
    expect(projectPrimitiveText("decision", { title: "Use Postgres" })).toBe("Use Postgres");
    expect(projectPrimitiveText("decision", { body: "RLS support." })).toBe("RLS support.");
  });

  it("skips an empty-string field", () => {
    expect(projectPrimitiveText("decision", { title: "", body: "RLS support." })).toBe(
      "RLS support."
    );
  });

  it("skips a non-string field value", () => {
    expect(
      projectPrimitiveText("decision", { title: 42, body: "RLS support." } as unknown as Record<
        string,
        unknown
      >)
    ).toBe("RLS support.");
  });

  it("returns an empty string when every field is absent", () => {
    expect(projectPrimitiveText("decision", {})).toBe("");
  });
});

describe("enqueuePrimitiveIndex", () => {
  function makeCtx(storage: InMemoryStorageAdapter): CoreContext {
    return { storage } as unknown as CoreContext;
  }

  it("appends a text-form vector_upsert outbox entry carrying {id, kind, text}", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    await enqueuePrimitiveIndex(ctx, {
      workspaceId: "11111111-1111-1111-1111-111111111111",
      id: "decision-1",
      kind: "decision",
      text: "Use Postgres RLS support.",
    });

    const entries = storage.outbox.filter((e) => e.eventType === "vector_upsert");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toMatchObject({
      id: "decision-1",
      kind: "decision",
      text: "Use Postgres RLS support.",
    });
    expect(entries[0]?.payload["vector"]).toBeUndefined();
  });

  it("appends a vector-form vector_upsert outbox entry carrying {id, kind, vector}", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    await enqueuePrimitiveIndex(ctx, {
      workspaceId: "11111111-1111-1111-1111-111111111111",
      id: "episode-1",
      kind: "episode",
      vector: [0.1, 0.2, 0.3],
      revision: 1,
      model: "test-embed-model",
    });

    const entries = storage.outbox.filter((e) => e.eventType === "vector_upsert");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toMatchObject({
      id: "episode-1",
      kind: "episode",
      vector: [0.1, 0.2, 0.3],
      revision: 1,
      model: "test-embed-model",
    });
  });
});
