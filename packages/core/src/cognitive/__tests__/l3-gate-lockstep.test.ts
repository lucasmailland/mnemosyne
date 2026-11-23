/**
 * P59 (docs/archive/openspec/p59-query-cache-l3-fix) design.md D10 — gate-lockstep test.
 *
 * D9's safety (workspace-shared L3 cache reuse is correct today) is a
 * property of `canUseL3ResultCache`'s predicate list, not of the SQL: the
 * cache key carries no `filter`/`scopeRef`/`actorId`, so the result set
 * cannot depend on caller identity ONLY as long as the gate keeps requiring
 * `filter === undefined`, offset 0, the default limit, and no query
 * modifier that would change which hits are returned for the same text.
 *
 * This test pins the EXACT clause set `canUseL3ResultCache` checks today.
 * If a future change relaxes any one of them (e.g. allows `filter`, or a
 * non-default `limit`), this test fails — forcing that change to be a
 * conscious, reviewed decision against this design, not a silent drift.
 */
import { describe, expect, it } from "vitest";
import type { AuthContext, RecallQuery } from "@mnemo-ai/types";
import { canUseL3ResultCache } from "../index.js";

const WORKSPACE_ID = "ws-gate-lockstep";

function baseQuery(overrides: Partial<RecallQuery> = {}): RecallQuery {
  return {
    workspaceId: WORKSPACE_ID,
    text: "gate lockstep query",
    ...overrides,
  };
}

// `memory:admin` scope gives an unset maxSensitivity ceiling "restricted"
// (see recall-cold.ts's sensitivityAllowed) — matches the admin fixture
// used by recall-cache-sensitivity.test.ts's default gate-open case.
function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    workspaceId: WORKSPACE_ID,
    actorId: "agent-1",
    actorType: "agent",
    scopes: ["memory:read", "memory:admin"],
    maxSensitivity: undefined,
    ...overrides,
  } as AuthContext;
}

describe("canUseL3ResultCache — D10 gate lockstep", () => {
  it("allows the default, most-permissive query shape", () => {
    expect(canUseL3ResultCache(baseQuery(), auth())).toBe(true);
  });

  it("allows an explicit limit: 10 / offset: 0 (the documented defaults)", () => {
    expect(canUseL3ResultCache(baseQuery({ limit: 10, offset: 0 }), auth())).toBe(true);
  });

  it.each([
    ["filter present", { filter: { kinds: ["fact"] } }],
    ["includeArchived: true", { includeArchived: true }],
    ["includeLowWorth: true", { includeLowWorth: true }],
    ["offset: 1 (non-zero)", { offset: 1 }],
    ["limit: 5 (non-default)", { limit: 5 }],
    ["limit: 20 (non-default)", { limit: 20 }],
    ["materialiseInferences: true", { materialiseInferences: true }],
    ["conversationId set", { conversationId: "conversation-1" }],
    ["tokenBudget set", { tokenBudget: 10_000 }],
    ["rerank: true", { rerank: true }],
    ["recurrenceThreshold set", { recurrenceThreshold: 0.7 }],
    ["hyde: true", { hyde: true }],
    ["hybridFts: true", { hybridFts: true }],
    ["minSimilarity set", { minSimilarity: 0.7 }],
    ["embeddingMigrationActive: true", { embeddingMigrationActive: true }],
  ] satisfies Array<[string, Partial<RecallQuery>]>)("denies L3 when %s", (_name, overrides) => {
    expect(canUseL3ResultCache(baseQuery(overrides), auth())).toBe(false);
  });

  it("denies L3 when the caller cannot be cleared for restricted sensitivity", () => {
    // memory:admin still caps the explicit ceiling below restricted here.
    expect(canUseL3ResultCache(baseQuery(), auth({ maxSensitivity: "confidential" }))).toBe(false);
    expect(canUseL3ResultCache(baseQuery(), auth({ maxSensitivity: "public" }))).toBe(false);
    // Without memory:admin, the scope ceiling itself caps at "internal".
    expect(
      canUseL3ResultCache(baseQuery(), auth({ scopes: ["memory:read"], maxSensitivity: undefined }))
    ).toBe(false);
  });

  it("allows L3 for a caller with no explicit ceiling (unrestricted) or explicit restricted", () => {
    expect(canUseL3ResultCache(baseQuery(), auth({ maxSensitivity: undefined }))).toBe(true);
    expect(canUseL3ResultCache(baseQuery(), auth({ maxSensitivity: "restricted" }))).toBe(true);
  });
});
