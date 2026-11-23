import { describe, it, expect } from "vitest";
import {
  canReadSensitivity,
  effectiveCeiling,
  filterBySensitivity,
  resolveDefaultCeiling,
  canDelegateTo,
  DEFAULT_SENSITIVITY,
} from "../../rbac.js";

describe("canReadSensitivity", () => {
  it("allows reading at or below the ceiling", () => {
    expect(canReadSensitivity("internal", "public")).toBe(true);
    expect(canReadSensitivity("internal", "internal")).toBe(true);
    expect(canReadSensitivity("restricted", "confidential")).toBe(true);
  });

  it("denies reading above the ceiling", () => {
    expect(canReadSensitivity("internal", "confidential")).toBe(false);
    expect(canReadSensitivity("public", "internal")).toBe(false);
    expect(canReadSensitivity("confidential", "restricted")).toBe(false);
  });

  it("treats missing fact sensitivity as 'internal' (default)", () => {
    expect(canReadSensitivity("internal", undefined)).toBe(true);
    expect(canReadSensitivity("public", undefined)).toBe(false);
  });

  it("uses numeric ordering, not string comparison (MED-23)", () => {
    // Alphabetically "confidential" < "public", so string comparison
    // would wrongly allow a public-ceiling caller to read confidential.
    expect(canReadSensitivity("public", "confidential")).toBe(false);
  });
});

describe("filterBySensitivity", () => {
  const items: Array<{ id: string; sensitivity?: string }> = [
    { id: "a", sensitivity: "public" },
    { id: "b", sensitivity: "internal" },
    { id: "c", sensitivity: "confidential" },
    { id: "d" }, // no sensitivity → treated as internal
  ];

  it("keeps only items at or below the ceiling", () => {
    expect(filterBySensitivity(items, "internal").map((i) => i.id)).toEqual(["a", "b", "d"]);
    expect(filterBySensitivity(items, "restricted").map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(filterBySensitivity(items, "public").map((i) => i.id)).toEqual(["a"]);
  });
});

describe("canDelegateTo", () => {
  it("allows delegation to a different agent", () => {
    expect(canDelegateTo("agent-a", "agent-b")).toBe(true);
  });

  it("rejects self-delegation", () => {
    expect(canDelegateTo("agent-a", "agent-a")).toBe(false);
  });

  it("rejects empty target", () => {
    expect(canDelegateTo("agent-a", "")).toBe(false);
  });

  it("denies a target outside the allow-list", () => {
    expect(canDelegateTo("agent-a", "agent-b", ["agent-c"])).toBe(false);
  });

  it("allows a target present in the allow-list", () => {
    expect(canDelegateTo("agent-a", "agent-b", ["agent-b", "agent-c"])).toBe(true);
  });

  it("allows any non-self target when the allow-list is the wildcard", () => {
    expect(canDelegateTo("agent-a", "agent-b", ["*"])).toBe(true);
  });

  it("still rejects self even when self is in the allow-list", () => {
    expect(canDelegateTo("agent-a", "agent-a", ["agent-a", "*"])).toBe(false);
  });

  it("treats an empty allow-list as deny-all (no targets permitted)", () => {
    expect(canDelegateTo("agent-a", "agent-b", [])).toBe(false);
  });

  it("falls back to legacy self/empty check when allow-list is omitted", () => {
    expect(canDelegateTo("agent-a", "agent-b")).toBe(true);
    expect(canDelegateTo("agent-a", "agent-a")).toBe(false);
  });
});

describe("resolveDefaultCeiling", () => {
  it("falls back to DEFAULT_SENSITIVITY when env is unset or invalid", () => {
    expect(resolveDefaultCeiling(undefined)).toBe(DEFAULT_SENSITIVITY);
    expect(resolveDefaultCeiling("not-a-level")).toBe(DEFAULT_SENSITIVITY);
  });

  it("accepts a valid level from env", () => {
    expect(resolveDefaultCeiling("restricted")).toBe("restricted");
    expect(resolveDefaultCeiling("public")).toBe("public");
  });
});

describe("effectiveCeiling", () => {
  it("returns the env ceiling unchanged when no per-key grant is present", () => {
    expect(effectiveCeiling("internal", undefined)).toBe("internal");
    expect(effectiveCeiling("restricted", undefined)).toBe("restricted");
    expect(effectiveCeiling("public", undefined)).toBe("public");
  });

  it("lowers the ceiling to the per-key grant when the key is more restrictive", () => {
    expect(effectiveCeiling("restricted", "internal")).toBe("internal");
    expect(effectiveCeiling("confidential", "public")).toBe("public");
  });

  it("never raises the ceiling above the env limit (key can only lower)", () => {
    // Key requests 'restricted' but env caps at 'internal' → env wins.
    expect(effectiveCeiling("internal", "restricted")).toBe("internal");
    expect(effectiveCeiling("public", "confidential")).toBe("public");
  });

  it("returns either when env and key are equal", () => {
    expect(effectiveCeiling("confidential", "confidential")).toBe("confidential");
  });

  it("uses numeric ordering, not string comparison (MED-23)", () => {
    // Alphabetically "confidential" < "internal", but numerically internal(1) <
    // confidential(2). The more-restrictive (lower numeric) tier must win.
    expect(effectiveCeiling("confidential", "internal")).toBe("internal");
    expect(effectiveCeiling("internal", "confidential")).toBe("internal");
  });
});
