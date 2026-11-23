import { describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

const WS = "ws-embedding-migration";
const OTHER_WS = "other-workspace";
const VECTOR = [1, 0, 0];

describe("InMemoryStorageAdapter.hasActiveEmbeddingMigration", () => {
  it("ignores a fact that has never been embedded but still lists it for backfill", async () => {
    const adapter = new InMemoryStorageAdapter();
    const fact = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "pending",
      subject: "test",
      kind: "other",
    });

    expect(await adapter.hasActiveEmbeddingMigration(WS, "current")).toBe(false);
    expect(await adapter.listStaleEmbeddings("fact", WS, "current", 10)).toContainEqual({
      id: fact.id,
      text: "pending",
    });
  });

  it("detects old-model vectors, but not clean current-model vectors", async () => {
    const adapter = new InMemoryStorageAdapter();
    const fact = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "embedded",
      subject: "test",
      kind: "other",
    });
    await adapter.updateEmbeddingVector("fact", fact.id, WS, VECTOR, "old");

    expect(await adapter.hasActiveEmbeddingMigration(WS, "current")).toBe(true);
    expect(await adapter.hasActiveEmbeddingMigration(WS, "old")).toBe(false);
  });

  it("detects a stale current-model vector and scopes results to the workspace", async () => {
    const adapter = new InMemoryStorageAdapter();
    const fact = await adapter.createFact({
      workspaceId: OTHER_WS,
      scope: "global",
      statement: "embedded",
      subject: "test",
      kind: "other",
    });
    await adapter.updateEmbeddingVector("fact", fact.id, OTHER_WS, VECTOR, "current");
    const stored = await adapter.getFact(fact.id, OTHER_WS);
    await adapter.updateFact(fact.id, OTHER_WS, { statement: "edited after embedding" });

    expect(stored?.embeddingStale).toBe(false);
    expect(await adapter.hasActiveEmbeddingMigration(WS, "current")).toBe(false);
    expect(await adapter.hasActiveEmbeddingMigration(OTHER_WS, "current")).toBe(true);
  });
});
