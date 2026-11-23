import { describe, it, expect } from "vitest";
import { constantTimeEqual } from "../constantTimeEqual.js";

describe("constantTimeEqual", () => {
  it("returns true for equal buffers", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(constantTimeEqual(a, b)).toBe(true);
  });

  it("returns false for same-length buffers differing in one byte", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it("returns false for different-length buffers without throwing", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(() => constantTimeEqual(a, b)).not.toThrow();
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it("returns true for two empty buffers", () => {
    const a = new Uint8Array([]);
    const b = new Uint8Array([]);
    expect(constantTimeEqual(a, b)).toBe(true);
  });
});
