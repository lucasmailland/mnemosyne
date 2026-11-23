/**
 * Shared test helper — returns a no-op `MnemoCore` stub backed by `vi.fn()`.
 *
 * Import and call `makeMockCognitive()` in any test that builds a `ServerDeps`
 * object. Pass an `overrides` map to replace specific methods with custom
 * implementations for the assertions you care about.
 *
 * Example:
 *   const deps = {
 *     ...otherDeps,
 *     cognitive: makeMockCognitive({
 *       remember: vi.fn(async () => ({ id: "fact-123", kind: "fact", staged: false })),
 *     }),
 *   } as unknown as ServerDeps;
 */
import { vi } from "vitest";
import type { MnemoCore } from "../../deps.js";

export function makeMockCognitive(overrides?: Partial<MnemoCore>): MnemoCore {
  return {
    remember: vi.fn().mockResolvedValue({ id: "mock-fact-id", kind: "fact", staged: false }),
    recall: vi.fn().mockResolvedValue({
      hits: [],
      total: 0,
      query: { text: "", limit: 10, offset: 0 },
      latencyMs: 0,
      fromHotTier: false,
    }),
    recallHot: vi.fn().mockResolvedValue([]),
    forget: vi.fn().mockResolvedValue(undefined),
    updateWorth: vi.fn().mockResolvedValue(undefined),
    updateRelationStrength: vi.fn().mockResolvedValue(undefined),
    collapseSession: vi.fn().mockResolvedValue({ turnsProcessed: 0, anticipationAccuracy: null }),
    ...overrides,
  } as unknown as MnemoCore;
}
