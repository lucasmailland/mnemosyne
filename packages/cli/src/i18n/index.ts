import { DEFAULT_LOCALE, translate, type Dict, type Locale, type Vars } from "@mnemo-ai/types";
import { en } from "./en.js";
import { es } from "./es.js";

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MessageKey = Leaves<typeof en>;

const DICTIONARIES: Record<Locale, Dict> = { "en-US": en, "es-419": es };

// Module-level on purpose: one CLI process runs one command and exits, and
// threading a locale through ~50 command functions would touch every call
// site. main() calls setLocale() once, before anything prints.
let current: Locale = DEFAULT_LOCALE;

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

/** Renders `key` in the process locale. `{name}` placeholders come from `vars`. */
export function t(key: MessageKey, vars?: Vars): string {
  return translate(DICTIONARIES[current], key, vars, current);
}
