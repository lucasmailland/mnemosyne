import {
  DEFAULT_LOCALE,
  normalizeLocale,
  translate,
  type Locale,
  type Vars,
} from "@mnemo-ai/types";
import { en } from "./en.js";
import { es } from "./es.js";

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MessageKey = Leaves<typeof en>;

const DICTIONARIES = { "en-US": en, "es-419": es } as const;

/**
 * MCP reads ONLY MNEMO_LOCALE (the client config `env` block is the one
 * per-server channel; LANG is deliberately ignored). Undefined when unset or
 * unknown, so callers can tell "not set" from the en-US default.
 */
export function mcpLocale(env: NodeJS.ProcessEnv = process.env): Locale | undefined {
  return normalizeLocale(env.MNEMO_LOCALE?.trim());
}

/** Renders `key` in `locale`. `{name}` placeholders come from `vars`. */
export function t(locale: Locale, key: MessageKey, vars?: Vars): string {
  return translate(DICTIONARIES[locale], key, vars, locale);
}

/** `d(locale)("tools.memory_pin")` — what Tasks 10-11 use for field `.describe()` text. */
export const describer =
  (locale: Locale = DEFAULT_LOCALE) =>
  (key: MessageKey): string =>
    t(locale, key);
