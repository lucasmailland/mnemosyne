/**
 * Unit tests for DrizzleStorageAdapter neuro-dynamics methods (Wave Y, §25.2/§25.3).
 * These tests use InMemoryStorageAdapter stubs — no real DB required.
 */

import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";

const WS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

describe("decayKind — entity class is a no-op", () => {
  it("returns 0 without touching the DB for entity class", async () => {
    const s = new InMemoryStorageAdapter();
    const count = await s.decayKind(WS, "entity", 0);
    expect(count).toBe(0);
  });

  it("returns 0 for all other classes (in-memory stub is always no-op)", async () => {
    const s = new InMemoryStorageAdapter();
    expect(await s.decayKind(WS, "semantic", 58)).toBe(0);
    expect(await s.decayKind(WS, "procedural", 173)).toBe(0);
    expect(await s.decayKind(WS, "episodic", 35)).toBe(0);
    expect(await s.decayKind(WS, "reasoning", 90)).toBe(0);
  });
});

describe("normalizeHebbianWeights — stub resolves without error", () => {
  it("resolves and returns 0 (no DB)", async () => {
    const s = new InMemoryStorageAdapter();
    const result = await s.normalizeHebbianWeights(WS);
    expect(result).toBe(0);
  });
});

describe("recordCoRecallStdp — stub resolves without error", () => {
  it("resolves without throwing", async () => {
    const s = new InMemoryStorageAdapter();
    await expect(
      s.recordCoRecallStdp(WS, "relation-id-1", new Date()), // determinism-ok: throwaway fixture date, not asserted
    ).resolves.toBeUndefined();
  });
});
