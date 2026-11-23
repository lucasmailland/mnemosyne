/**
 * Tiny, dependency-free i18n core shared by the CLI, the MCP server and the
 * server's error messages. Dictionaries live in each package; this file only
 * resolves a locale, renders a key, and matches English templates.
 */

export type Locale = "en-US" | "es-419";
export const LOCALES: readonly Locale[] = ["en-US", "es-419"];
export const DEFAULT_LOCALE: Locale = "en-US";

const PRIMARY: Record<string, Locale> = { en: "en-US", es: "es-419" };

/**
 * BCP 47 (`es`, `es-AR`) and POSIX (`es_MX.UTF-8`, `es_AR@euro`) tags to a
 * Locale. `C`, `POSIX`, empty and unknown languages give undefined.
 */
export function normalizeLocale(tag?: string): Locale | undefined {
  if (typeof tag !== "string" || !tag) return undefined; // JSON config can hand us a number
  const primary =
    tag
      .trim()
      .toLowerCase()
      .split(/[-_.@]/)[0] ?? "";
  // Own properties only: "constructor" or "__proto__" must not reach Object's.
  return Object.hasOwn(PRIMARY, primary) ? PRIMARY[primary] : undefined;
}

/** First candidate that normalizes wins, then q-sorted Accept-Language, then en-US. */
export function resolveLocale(
  candidates: Array<string | undefined>,
  acceptLanguage?: string
): Locale {
  for (const c of candidates) {
    const locale = normalizeLocale(c);
    if (locale) return locale;
  }
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag, q: q ? Number(q.slice(2)) : 1, i };
    })
    .filter((e) => e.tag && e.q > 0) // NaN (malformed q) fails this too
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of ranked) {
    const locale = normalizeLocale(tag);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

export type Plural = { one: string; other: string };
/** A dictionary: nested objects whose leaves are strings or `{ one, other }` plurals. */
export type Dict<T = string> = { readonly [key: string]: T | Plural | Dict<T> };
export type Vars = Record<string, string | number>;

/**
 * Renders `key` (dotted) from `dict`. `{name}` is replaced from `vars`; an
 * unknown `{name}` stays visible. A `{ one, other }` leaf picks its branch from
 * `vars.count` with Intl.PluralRules. A missing key returns the key.
 */
export function translate(
  dict: Dict,
  key: string,
  vars?: Vars,
  locale: Locale = DEFAULT_LOCALE
): string {
  let node: unknown = dict;
  for (const part of key.split("."))
    node =
      node && typeof node === "object" && Object.hasOwn(node, part)
        ? (node as Record<string, unknown>)[part]
        : undefined;
  if (node && typeof node === "object") {
    const p = node as Record<string, unknown>;
    const count = vars?.count;
    const branch = typeof count === "number" ? new Intl.PluralRules(locale).select(count) : "other";
    node = Object.hasOwn(p, branch) ? p[branch] : p.other;
  }
  if (typeof node !== "string") return key;
  return node.replace(/\{(\w+)\}/g, (m, name: string) =>
    vars && Object.hasOwn(vars, name) ? String(vars[name]) : m
  );
}

export interface CompiledTemplate {
  key: string;
  /** Literal pieces around the placeholders: `literals.length === names.length + 1`. */
  literals: string[];
  names: string[];
  /** Literal characters (placeholders excluded): more means more specific. */
  weight: number;
}

/** Messages longer than this are never matched (they stay untranslated). */
export const MAX_MATCH_LENGTH = 2048;

/**
 * Compiles English `{name}` templates (key -> template), most specific (most
 * literal characters, then fewest placeholders) first. Throws on a duplicate
 * placeholder name or two adjacent placeholders (unmatchable without a separator).
 */
export function compileTemplates(table: Record<string, string>): CompiledTemplate[] {
  return Object.entries(table)
    .map(([key, template]) => {
      // split with a capture group alternates literal, name, literal, ...
      const pieces = template.split(/\{(\w+)\}/);
      const literals = pieces.filter((_, i) => i % 2 === 0);
      const names = pieces.filter((_, i) => i % 2 === 1);
      if (new Set(names).size !== names.length)
        throw new Error(`duplicate placeholder in "${key}"`);
      if (literals.slice(1, -1).includes("")) throw new Error(`adjacent placeholders in "${key}"`);
      return { key, literals, names, weight: literals.join("").length };
    })
    .sort((a, b) => b.weight - a.weight || a.names.length - b.names.length); // stable
}

/**
 * The key and captured values of the first template matching `message`, else
 * undefined. Linear time, no RegExp: the message must start and end with the
 * template's outer literals and contain the middle ones in order. Each middle
 * literal is taken at its FIRST occurrence after the previous one, so it can
 * differ from a backtracking regex only when a separator also occurs inside a
 * captured value. Captures are non-empty.
 */
export function matchTemplate(
  compiled: readonly CompiledTemplate[],
  message: string
): { key: string; vars: Record<string, string> } | undefined {
  if (message.length > MAX_MATCH_LENGTH) return undefined;
  for (const { key, literals, names } of compiled) {
    const first = literals[0] ?? "";
    if (names.length === 0) {
      if (message === first) return { key, vars: Object.create(null) };
      continue;
    }
    const last = literals[literals.length - 1] ?? "";
    if (!message.startsWith(first) || !message.endsWith(last)) continue;
    const end = message.length - last.length;
    if (end < first.length) continue; // prefix and suffix would overlap
    const vars: Record<string, string> = Object.create(null);
    let pos = first.length;
    let ok = true;
    for (let i = 0; i < names.length && ok; i++) {
      const sep = i < names.length - 1 ? (literals[i + 1] ?? "") : undefined;
      const stop = sep === undefined ? end : message.indexOf(sep, pos + 1);
      if (stop <= pos || (sep !== undefined && stop + sep.length > end)) ok = false;
      else {
        vars[names[i] as string] = message.slice(pos, stop);
        pos = stop + (sep?.length ?? 0);
      }
    }
    if (ok) return { key, vars };
  }
  return undefined;
}
