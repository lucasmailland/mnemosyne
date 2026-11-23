import { describe, it, expect } from "vitest";
import { applyMigrationReweight } from "../recall-cold.js";

describe("WP14.8 — applyMigrationReweight fires only during migration (spec §36)", () => {
  it("is identity when migrationActive is false", () => {
    const r = applyMigrationReweight({ vectorScore: 0.8, isFtsOnly: false }, false);
    expect(r).toBeCloseTo(0.8, 10);
    const f = applyMigrationReweight({ vectorScore: 0.1, isFtsOnly: true }, false);
    expect(f).toBeCloseTo(0.1, 10);
  });

  it("dampens a pure-vector hit and boosts an FTS-only hit when migration is active", () => {
    // vector hit: scaled by vector/normalVector = 0.3/0.6 = 0.5
    const v = applyMigrationReweight({ vectorScore: 0.8, isFtsOnly: false }, true);
    expect(v).toBeCloseTo(0.8 * (0.3 / 0.6), 10);
    // fts-only hit: scaled by fts/normalFts = 0.7/0.4 = 1.75
    const f = applyMigrationReweight({ vectorScore: 0.1, isFtsOnly: true }, true);
    expect(f).toBeCloseTo(0.1 * (0.7 / 0.4), 10);
  });
});
