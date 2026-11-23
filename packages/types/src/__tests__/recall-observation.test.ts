import { describe, expect, expectTypeOf, it } from "vitest";
import { readFileSync } from "node:fs";
import type { RecallPort } from "../ports.js";
import type { RecallHitObservation, RecallRequestObservation } from "../recall.js";

const base: RecallRequestObservation = {
  requestId: "r1",
  workspaceId: "w",
  trafficOrigin: "unknown",
  clientVersion: "unknown",
  pluginVersion: "unknown",
  serverVersion: "unknown",
  sessionId: null,
  sessionNullReason: "invalid",
  requestedFilters: {},
  effectiveFilters: {},
  tiers: [],
  cacheHit: false,
  resultCount: 0,
  nothingRelevant: true,
  status: "error",
  error: "boom",
  queryHash: "h",
  totalDurationMs: 1,
  phaseDurationsMs: {},
};

describe("recall observation types", () => {
  it("supports fixtures", () => {
    const hits: RecallHitObservation[] = [
      {
        workspaceId: "w",
        requestId: "r1",
        primitiveKind: "fact",
        memoryId: "uuid",
        rank: 0,
        score: 1,
      },
      {
        workspaceId: "w",
        requestId: "r1",
        primitiveKind: "episode",
        memoryId: "mepi_x",
        rank: 1,
        score: 1,
      },
    ];
    expectTypeOf(hits[0]!.memoryId).toEqualTypeOf<string>();
    expectTypeOf(base.sessionId).toEqualTypeOf<string | null>();
    expectTypeOf<RecallPort["recordRecallObservation"]>().toEqualTypeOf<
      ((r: RecallRequestObservation, h: RecallHitObservation[]) => Promise<void>) | undefined
    >();
  });
  it("has no infrastructure imports", () => {
    const src = readFileSync(new URL("../recall.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/drizzle-orm|from "postgres"|ioredis/);
  });
});
