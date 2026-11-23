import { describe, it, expect } from "vitest";
import { encodeDelta, applyDelta, DELTA_MAGIC_V1, FULL_MAGIC_V1 } from "../delta-text.js";

describe("delta-text codec (DELTAMEM §16 residual encoding)", () => {
  it("round-trips an exact match to an empty-residual delta", () => {
    const s = "line one\nline two\nline three";
    const d = encodeDelta(s, s);
    expect(applyDelta(s, d)).toBe(s);
  });

  it("encodes a high-overlap child as a residual shorter than the child", () => {
    const parent = [
      "Deploy process started",
      "Built the container image",
      "Pushed to the registry",
      "Ran the migration",
      "Health check green",
    ].join("\n");
    const child = [
      "Deploy process started",
      "Built the container image",
      "Pushed to the registry",
      "Rolled back the migration", // single changed line
      "Health check green",
    ].join("\n");

    const delta = encodeDelta(parent, child);
    // >70% shared text → residual strictly smaller than the full child narrative.
    expect(delta.length).toBeLessThan(child.length);
    expect(delta.startsWith(DELTA_MAGIC_V1)).toBe(true);
    // Exact reconstruction.
    expect(applyDelta(parent, delta)).toBe(child);
  });

  it("applyDelta(encodeDelta(parent, child)) === child for disjoint text", () => {
    const parent = "totally\nunrelated\ncontent";
    const child = "a\ncompletely\ndifferent\nepisode\nnarrative";
    const delta = encodeDelta(parent, child);
    expect(applyDelta(parent, delta)).toBe(child);
  });

  it("never grows beyond a full payload for low-overlap children", () => {
    const parent = "aaa\nbbb\nccc";
    const child = "xxx\nyyy\nzzz";
    const delta = encodeDelta(parent, child);
    // Low overlap → falls back to FULL payload, still exact.
    expect(delta.startsWith(FULL_MAGIC_V1)).toBe(true);
    expect(applyDelta(parent, delta)).toBe(child);
  });

  it("treats a header-less legacy string as a literal full narrative", () => {
    // Pre-WP5 rows / raw test fixtures stored the full text directly.
    expect(applyDelta("ignored parent", "DELTA1")).toBe("DELTA1");
    expect(applyDelta("ignored parent", "rolled back the auth service")).toBe(
      "rolled back the auth service",
    );
  });

  it("handles empty parent and empty child exactly", () => {
    expect(applyDelta("", encodeDelta("", "new"))).toBe("new");
    expect(applyDelta("parent", encodeDelta("parent", ""))).toBe("");
    expect(applyDelta("", encodeDelta("", ""))).toBe("");
  });

  it("preserves trailing newlines and blank lines exactly", () => {
    const parent = "a\n\nb\n";
    const child = "a\n\nc\n";
    expect(applyDelta(parent, encodeDelta(parent, child))).toBe(child);
  });
});
