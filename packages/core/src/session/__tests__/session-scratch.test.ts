import { describe, it, expect } from "vitest";
import { mergeScratch } from "../collapse.js";

describe("mergeScratch (spec §7 scratchpad)", () => {
  it("shallow-merges new keys over existing", () => {
    expect(mergeScratch({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
  });
  it("treats null/undefined base as empty", () => {
    expect(mergeScratch(null, { x: 1 })).toEqual({ x: 1 });
  });
  it("returns a new object (no mutation of base)", () => {
    const base = { a: 1 };
    const out = mergeScratch(base, { b: 2 });
    expect(base).toEqual({ a: 1 });
    expect(out).toEqual({ a: 1, b: 2 });
  });
});
