import { describe, it, expect, vi } from "vitest";
import { shouldCollapseUnderPolicy, discoverSweepCandidates } from "../session-sweep.js";
import { DEFAULT_COLLAPSE_POLICY } from "@mnemo-ai/core";

describe("shouldCollapseUnderPolicy (F2 sweep trigger)", () => {
  it("fires max_turns when turnCount >= policy.maxTurns (per-agent override beats default 50)", () => {
    const r = shouldCollapseUnderPolicy(
      { turnCount: 5, tokenCount: 10, ageSeconds: 1 },
      { ...DEFAULT_COLLAPSE_POLICY, maxTurns: 5 }
    );
    expect(r).toBe("max_turns");
  });

  it("does NOT fire at 5 turns under the default policy (maxTurns 50)", () => {
    const r = shouldCollapseUnderPolicy(
      { turnCount: 5, tokenCount: 10, ageSeconds: 1 },
      DEFAULT_COLLAPSE_POLICY
    );
    expect(r).toBeNull();
  });

  it("fires max_tokens before inactivity", () => {
    const r = shouldCollapseUnderPolicy(
      { turnCount: 1, tokenCount: 9000, ageSeconds: 10 },
      DEFAULT_COLLAPSE_POLICY
    );
    expect(r).toBe("max_tokens");
  });

  it("fires inactivity when ageSeconds >= policy.inactivityTimeout", () => {
    const r = shouldCollapseUnderPolicy(
      { turnCount: 1, tokenCount: 10, ageSeconds: 2000 },
      DEFAULT_COLLAPSE_POLICY
    );
    expect(r).toBe("inactivity");
  });
});

describe("bounded authoritative sweep discovery", () => {
  it("skips candidates past the retry limit or before their retry time", async () => {
    const base = { workspaceId: "ws", turnCount: 50, tokenCount: 100, inactivitySeconds: 2000 };
    const result = await discoverSweepCandidates(
      { workspaceId: "ws", limit: 3 },
      {
        listDatabasePage: async () => ({
          rows: [
            { ...base, id: "exhausted", collapseAttempts: 8 },
            { ...base, id: "waiting", collapseAttempts: 1, collapseRetryDue: false },
            { ...base, id: "due", collapseAttempts: 1, collapseRetryDue: true },
          ],
          nextCursor: null,
        }),
        listRedisIds: async () => [],
        hydrateRedisIds: async () => [],
        removeStaleRedisId: async () => {},
      }
    );
    expect(result.rows.map((row) => row.id)).toEqual(["due"]);
  });
  it("unions Redis with a bounded database page and removes stale Redis IDs", async () => {
    const db = {
      id: "db",
      workspaceId: "ws",
      turnCount: 2,
      tokenCount: 10,
      inactivitySeconds: 2000,
    };
    const redis = { ...db, id: "redis" };
    const listDatabasePage = vi.fn(async () => ({
      rows: [db],
      nextCursor: { activityAt: "2026-09-01", id: "db" },
    }));
    const removeStaleRedisId = vi.fn();
    const result = await discoverSweepCandidates(
      { workspaceId: "ws", limit: 2, cursor: { activityAt: "2026-08-01", id: "prior" } },
      {
        listDatabasePage,
        listRedisIds: async () => ["stale", "redis", "db"],
        hydrateRedisIds: async () => [redis, db],
        removeStaleRedisId,
      }
    );
    expect(result.rows.map((r) => r.id)).toEqual(["db", "redis"]);
    expect(removeStaleRedisId).toHaveBeenCalledWith("ws", "stale");
    expect(listDatabasePage).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2, cursor: { activityAt: "2026-08-01", id: "prior" } })
    );
    expect(result.nextCursor?.id).toBe("db");
  });
  it("keeps database progress when Redis fails", async () => {
    const result = await discoverSweepCandidates(
      { workspaceId: "ws", limit: 2 },
      {
        listDatabasePage: async () => ({
          rows: [
            { id: "db", workspaceId: "ws", turnCount: 2, tokenCount: 10, inactivitySeconds: 2 },
          ],
          nextCursor: null,
        }),
        listRedisIds: async () => {
          throw new Error("redis down");
        },
        hydrateRedisIds: vi.fn(),
        removeStaleRedisId: vi.fn(),
      }
    );
    expect(result.rows.map((r) => r.id)).toEqual(["db"]);
  });
  it("uses authoritative inactivity over session lifetime", () => {
    expect(
      shouldCollapseUnderPolicy(
        { turnCount: 2, tokenCount: 10, ageSeconds: 100_000, inactivitySeconds: 5 },
        DEFAULT_COLLAPSE_POLICY
      )
    ).toBeNull();
  });
});
