import { describe, it, expect } from "vitest";
import { tiersAtOrBelow } from "../security.js";

describe("tiersAtOrBelow", () => {
  it("lists the readable tiers, lowest first", () => {
    expect(tiersAtOrBelow("public")).toEqual(["public"]);
    expect(tiersAtOrBelow("internal")).toEqual(["public", "internal"]);
    expect(tiersAtOrBelow("restricted")).toEqual([
      "public",
      "internal",
      "confidential",
      "restricted",
    ]);
  });
});
