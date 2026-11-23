import { describe, it, expect, vi } from "vitest";
import { detectStale, migrateWorkspace, EMBEDDABLE_TABLES } from "../embedMigration.js";
import type { EmbedMigrationStorage, EmbedMigrationEmbed } from "../embedMigration.js";

function makeStorage(staleOverride?: Record<string, number>): EmbedMigrationStorage {
  const counts = staleOverride ?? { fact: 3, decision: 1, skill: 0, strategy: 2, reasoning: 0 };
  const written: Array<{ table: string; id: string; model: string }> = [];
  return {
    async listStaleEmbeddings(table, _workspaceId, _model, limit) {
      const n = counts[table] ?? 0;
      return Array.from({ length: Math.min(n, limit) }, (_, i) => ({
        id: `${table}-${i}`,
        text: `text ${table} ${i}`,
      }));
    },
    async markEmbeddingsStale(table, _workspaceId, _model) {
      return counts[table] ?? 0;
    },
    async updateEmbeddingVector(table, id, _workspaceId, _vector, model) {
      written.push({ table, id, model });
    },
    async listWorkspaceIds() {
      return ["ws1"];
    },
    _written: written,
  } as EmbedMigrationStorage & { _written: typeof written };
}

function makeEmbed(model = "text-embedding-3-small"): EmbedMigrationEmbed {
  return {
    model,
    async embed(texts) {
      return texts.map(() => new Float32Array(3).fill(0.1));
    },
  };
}

describe("§36 embedMigration — detectStale", () => {
  it("returns per-table counts and total", async () => {
    const storage = makeStorage();
    const result = await detectStale(storage, "ws1", "model-new");
    expect(result.counts.fact).toBe(3);
    expect(result.counts.decision).toBe(1);
    expect(result.counts.skill).toBe(0);
    expect(result.counts.strategy).toBe(2);
    expect(result.counts.reasoning).toBe(0);
    expect(result.total).toBe(6);
  });

  it("reports zero when nothing is stale", async () => {
    const storage = makeStorage({ fact: 0, decision: 0, skill: 0, strategy: 0, reasoning: 0 });
    const result = await detectStale(storage, "ws1", "new-model");
    expect(result.total).toBe(0);
  });
});

describe("§36 embedMigration — migrateWorkspace", () => {
  it("writes vectors for each stale row", async () => {
    const storage = makeStorage({ fact: 2, decision: 0, skill: 0, strategy: 0, reasoning: 0 });
    const embed = makeEmbed();
    const result = await migrateWorkspace({ storage, embed, workspaceId: "ws1" });
    expect(result.migrated).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it("collects per-row errors without aborting", async () => {
    let callCount = 0;
    const storage: EmbedMigrationStorage = {
      async listStaleEmbeddings(table, _ws, _model, _limit) {
        return table === "fact" ? [{ id: "f1", text: "hello" }] : [];
      },
      async markEmbeddingsStale() {
        return 0;
      },
      async updateEmbeddingVector() {
        callCount++;
        throw new Error("write failed");
      },
      async listWorkspaceIds() {
        return [];
      },
    };
    const result = await migrateWorkspace({ storage, embed: makeEmbed(), workspaceId: "ws1" });
    expect(result.migrated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.table).toBe("fact");
    expect(result.errors[0]!.id).toBe("f1");
    expect(callCount).toBe(1);
  });

  it("covers all 5 tables", async () => {
    const touched: string[] = [];
    const storage: EmbedMigrationStorage = {
      async listStaleEmbeddings(table) {
        return [{ id: `${table}-0`, text: "t" }];
      },
      async markEmbeddingsStale() {
        return 0;
      },
      async updateEmbeddingVector(table) {
        touched.push(table);
      },
      async listWorkspaceIds() {
        return [];
      },
    };
    await migrateWorkspace({ storage, embed: makeEmbed(), workspaceId: "ws1" });
    expect(new Set(touched)).toEqual(new Set(EMBEDDABLE_TABLES));
  });
});

describe("sensitive rows and the re-embed sweep (SECURITY.md §7)", () => {
  function spyStorage() {
    const seen: unknown[] = [];
    const storage = {
      async listStaleEmbeddings(_t: string, _w: string, _m: string, _l: number, opts?: unknown) {
        seen.push(opts);
        return [];
      },
      async markEmbeddingsStale() {
        return 0;
      },
    } as unknown as EmbedMigrationStorage;
    return { storage, seen };
  }

  it("lists only plaintext rows unless told the embedder may get sensitive text", async () => {
    const unset = spyStorage();
    await detectStale(unset.storage, "ws1", "m");
    expect(unset.seen.length).toBeGreaterThan(0);
    expect(
      unset.seen.every((o) => (o as { plaintextOnly?: boolean })?.plaintextOnly === true)
    ).toBe(true);

    const allowed = spyStorage();
    await detectStale(allowed.storage, "ws1", "m", { sensitiveTextToEmbedder: true });
    expect(allowed.seen.every((o) => o === undefined)).toBe(true);
  });
});
