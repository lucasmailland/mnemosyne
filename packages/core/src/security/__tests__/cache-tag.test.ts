import { describe, it, expect } from "vitest";
import {
  wrapCacheValue,
  unwrapCacheValue,
  CachePoisoningError,
} from "../cache-tag.js";

const WS_A = "workspace-aaa-111";
const WS_B = "workspace-bbb-222";

describe("wrapCacheValue / unwrapCacheValue", () => {
  it("wraps a value with the workspace ID", () => {
    const wrapped = wrapCacheValue(WS_A, ["fact-1", "fact-2"]);
    expect(wrapped.__ws).toBe(WS_A);
    expect(wrapped.v).toEqual(["fact-1", "fact-2"]);
  });

  it("unwraps a correctly-tagged value", () => {
    const wrapped = wrapCacheValue(WS_A, 42);
    const result = unwrapCacheValue(WS_A, wrapped);
    expect(result).toBe(42);
  });

  it("round-trips through JSON serialization", () => {
    const original = { id: "fact-1", score: 0.9 };
    const wrapped = wrapCacheValue(WS_A, original);
    const serialized = JSON.parse(JSON.stringify(wrapped));
    const result = unwrapCacheValue(WS_A, serialized);
    expect(result).toEqual(original);
  });

  it("throws CachePoisoningError when workspace does not match", () => {
    const wrapped = wrapCacheValue(WS_A, "secret data");
    expect(() => unwrapCacheValue(WS_B, wrapped)).toThrow(CachePoisoningError);
  });

  it("CachePoisoningError carries expected and actual workspace IDs", () => {
    const wrapped = wrapCacheValue(WS_A, "data");
    try {
      unwrapCacheValue(WS_B, wrapped);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CachePoisoningError);
      const err = e as CachePoisoningError;
      expect(err.expectedWorkspace).toBe(WS_B);
      expect(err.actualWorkspace).toBe(WS_A);
    }
  });

  it("throws CachePoisoningError when __ws is missing", () => {
    const badPayload = { v: "some data" } as Parameters<typeof unwrapCacheValue>[1];
    expect(() => unwrapCacheValue(WS_A, badPayload)).toThrow(CachePoisoningError);
  });

  it("throws CachePoisoningError when actual workspace is undefined", () => {
    const badPayload = { v: "some data" } as Parameters<typeof unwrapCacheValue>[1];
    try {
      unwrapCacheValue(WS_A, badPayload);
    } catch (e) {
      const err = e as CachePoisoningError;
      expect(err.actualWorkspace).toBeUndefined();
    }
  });

  it("CachePoisoningError name is 'CachePoisoningError'", () => {
    const wrapped = wrapCacheValue(WS_A, "x");
    try {
      unwrapCacheValue(WS_B, wrapped);
    } catch (e) {
      expect((e as Error).name).toBe("CachePoisoningError");
    }
  });

  it("works with complex nested payloads", () => {
    const payload = {
      ids: ["a", "b"],
      meta: { count: 2, page: 1 },
    };
    const wrapped = wrapCacheValue(WS_A, payload);
    const result = unwrapCacheValue(WS_A, wrapped);
    expect(result).toEqual(payload);
  });
});
