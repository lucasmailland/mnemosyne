import { beforeEach, expect, it } from "vitest";
import { setPreference } from "../preferences";

beforeEach(() => {
  window.history.pushState({}, "", "/dashboard/account"); // cookie Path=/dashboard
  document.cookie = "mnemo_locale=; Max-Age=0";
  document.cookie = "mnemo_theme=; Max-Age=0";
});

it("writes an allowed locale", () => {
  setPreference("mnemo_locale", "es-419");
  expect(document.cookie).toContain("mnemo_locale=es-419");
});

it("ignores values outside the allowed set", () => {
  setPreference("mnemo_locale", "fr");
  setPreference("mnemo_theme", "neon");
  expect(document.cookie).not.toContain("mnemo_locale");
  expect(document.cookie).not.toContain("mnemo_theme");
});
