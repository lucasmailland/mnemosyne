import { describe, it, expect } from "vitest";
import {
  isSensitiveTier,
  sensitiveTextMayReachEmbedder,
  sensitiveTextMayReachLlm,
  type Sensitivity,
} from "../index.js";

describe("isSensitiveTier", () => {
  it.each(["public", "internal"])("%s is not sensitive", (t) => {
    expect(isSensitiveTier(t as Sensitivity)).toBe(false);
  });

  it.each(["confidential", "restricted"])("%s is sensitive", (t) => {
    expect(isSensitiveTier(t as Sensitivity)).toBe(true);
  });

  // `in` accepts inherited properties; a tier named after one must not pass as plaintext.
  it.each([
    undefined,
    null,
    "",
    "toString",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "valueOf",
    "PUBLIC",
    42,
  ])("%s fails closed", (t) => {
    expect(isSensitiveTier(t as unknown as Sensitivity)).toBe(true);
  });
});

describe("sensitiveTextMayReachLlm", () => {
  const local = { localTasks: ["judge", "default"] as const };

  it("a completion without a task never counts as local", () => {
    expect(sensitiveTextMayReachLlm("none", local, undefined)).toBe(false);
    expect(sensitiveTextMayReachLlm("embed", local, undefined)).toBe(false);
    expect(sensitiveTextMayReachLlm("all", local, undefined)).toBe(true);
  });

  it("a task counts as local only when listed", () => {
    expect(sensitiveTextMayReachLlm("none", local, "judge")).toBe(true);
    expect(sensitiveTextMayReachLlm("none", local, "summary")).toBe(false);
    expect(sensitiveTextMayReachLlm("none", {}, "judge")).toBe(false);
    expect(sensitiveTextMayReachLlm(undefined, undefined, "judge")).toBe(false);
  });
});

describe("sensitiveTextMayReachEmbedder", () => {
  it("only none closes the external embedder", () => {
    expect(sensitiveTextMayReachEmbedder("none", {})).toBe(false);
    expect(sensitiveTextMayReachEmbedder("none", { local: true })).toBe(true);
    expect(sensitiveTextMayReachEmbedder(undefined, {})).toBe(true);
    expect(sensitiveTextMayReachEmbedder("all", undefined)).toBe(true);
  });
});
