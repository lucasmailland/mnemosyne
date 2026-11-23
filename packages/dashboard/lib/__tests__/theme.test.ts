import { describe, expect, it } from "vitest";

import { resolveTheme, themeAttribute } from "../theme";

describe("theme", () => {
  it.each([
    [undefined, "system"],
    ["", "system"],
    ["neon", "system"],
    ["dark", "dark"],
    ["system", "system"],
    ["light", "light"],
  ])("resolveTheme(%s) is %s", (v, out) => {
    expect(resolveTheme(v as string | undefined)).toBe(out);
  });

  it("maps system to no attribute", () => {
    expect(themeAttribute("system")).toBeUndefined();
    expect(themeAttribute("dark")).toBe("dark");
  });
});

import { THEMES } from "../theme";
it("exports the one theme list", () => {
  expect(THEMES).toEqual(["light", "dark", "system"]);
});
