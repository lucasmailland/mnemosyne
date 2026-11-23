import { describe, it, expect, afterEach } from "vitest";
import { setLocale, t } from "../i18n/index.js";
import { isYes, yesNoSuffix } from "../i18n/yes-no.js";

afterEach(() => setLocale("en-US"));

describe("yes/no prompts", () => {
  it("English text and behavior are unchanged", () => {
    expect(yesNoSuffix(false)).toBe("[y/N]");
    expect(yesNoSuffix(true)).toBe("[Y/n]");
    expect(t("init.registerAUserProfile", { yn: yesNoSuffix(false) })).toBe(
      "Register a user profile on this server? [y/N]: "
    );
    expect(isYes("Y", false)).toBe(true);
    expect(isYes("yes", false)).toBe(true);
    expect(isYes("", false)).toBe(false);
    expect(isYes("s", false)).toBe(false);
    expect(isYes("", true)).toBe(true);
    expect(isYes(" n ", true)).toBe(false);
  });

  it("Spanish shows [s/N] and accepts s, sí, si (any case) and still y", () => {
    setLocale("es-419");
    expect(yesNoSuffix(false)).toBe("[s/N]");
    expect(yesNoSuffix(true)).toBe("[S/n]");
    expect(t("init.configureClaudeDesktopY", { yn: yesNoSuffix(true) })).toBe(
      "¿Configurar Claude Desktop? [S/n]: "
    );
    for (const a of ["s", "sí", "SI", " Sí ", "y", "yes"]) expect(isYes(a, false)).toBe(true);
    for (const a of ["", "n", "no", "x"]) expect(isYes(a, false)).toBe(false);
    expect(isYes("", true)).toBe(true);
    expect(isYes("n", true)).toBe(false);
  });

  it('a default-yes prompt treats "no" as no in every locale', () => {
    expect(isYes("no", true)).toBe(false);
    expect(isYes(" NO ", true)).toBe(false);
  });
});
