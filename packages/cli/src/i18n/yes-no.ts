import { getLocale, t } from "./index.js";

/** `[y/N]` / `[Y/n]` in English, `[s/N]` / `[S/n]` in Spanish. */
export function yesNoSuffix(defaultYes: boolean): string {
  return t(defaultYes ? "prompt.yesNoDefaultYes" : "prompt.yesNoDefaultNo");
}

/**
 * Reads a typed answer. `y`/`yes` count in every locale; Spanish also accepts
 * `s`/`sí`/`si`. An empty answer is the default. With a default of yes, `n` and `no`
 * decline in every locale (only `n` used to).
 */
export function isYes(answer: string, defaultYes: boolean): boolean {
  const a = answer.trim().toLowerCase();
  if (defaultYes) return a !== "n" && a !== "no";
  if (a === "y" || a === "yes") return true;
  return getLocale() === "es-419" && (a === "s" || a === "sí" || a === "si");
}
