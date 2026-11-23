import type { en } from "./messages/en";

export type Locale = "en-US" | "es-419";
export const LOCALES: readonly Locale[] = ["en-US", "es-419"];
export const DEFAULT_LOCALE: Locale = "en-US";
export const LOCALE_COOKIE = "mnemo_locale";

/** Shape of the dictionary: every leaf is a string or a `{ one, other }` plural. */
export type Messages = typeof en;

type Plural = { one: string; other: string };
type Paths<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends Plural
    ? `${P}${K}`
    : T[K] extends string
      ? `${P}${K}`
      : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Paths<Messages>;

export type Vars = Record<string, string | number>;
export type T = (key: MessageKey, vars?: Vars) => string;

const PRIMARY: Record<string, Locale> = { en: "en-US", es: "es-419" };

export function resolveLocale(
  cookie: string | undefined,
  acceptLanguage: string | null | undefined
): Locale {
  if (cookie && (LOCALES as readonly string[]).includes(cookie)) return cookie as Locale;
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag: tag.toLowerCase(), q: q ? Number(q.slice(2)) : 1, i };
    })
    .filter((e) => e.tag && e.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of ranked) {
    // Own properties only: "constructor" or "__proto__" in the header must not reach Object's.
    const primary = tag.split("-")[0];
    if (Object.hasOwn(PRIMARY, primary)) return PRIMARY[primary];
  }
  return DEFAULT_LOCALE;
}

export function translate(
  messages: Messages,
  key: MessageKey,
  vars?: Vars,
  locale: Locale = DEFAULT_LOCALE
): string {
  // Keys can carry API values ("browser.kind.<kind>"): walk own properties only.
  let node: unknown = messages;
  for (const part of key.split("."))
    node =
      node && typeof node === "object" && Object.hasOwn(node, part)
        ? (node as Record<string, unknown>)[part]
        : undefined;
  if (node && typeof node === "object") {
    const p = node as Plural;
    const count = vars?.count;
    const branch = typeof count === "number" ? new Intl.PluralRules(locale).select(count) : "other";
    node = (p as Record<string, string>)[branch] ?? p.other;
  }
  if (typeof node !== "string") return key;
  return node.replace(/\{(\w+)\}/g, (m, name: string) =>
    !vars || !Object.hasOwn(vars, name)
      ? m
      : name === "count" && typeof vars.count === "number"
        ? new Intl.NumberFormat(locale).format(vars.count)
        : String(vars[name])
  );
}

/** `digits` pins the number of decimals (e.g. 2 for scores); omit it for the default. */
export function formatNumber(locale: Locale, n: number, digits?: number): string {
  const opts =
    digits === undefined
      ? undefined
      : { minimumFractionDigits: digits, maximumFractionDigits: digits };
  return new Intl.NumberFormat(locale, opts).format(n);
}

/**
 * The dashboard's one date formatter (APP-052). UTC so the server and the browser render the
 * same text: pages render on the server, which cannot know the reader's zone, and the API's
 * day aggregates are UTC days. Styles that show a time name the zone ("10:05 UTC").
 */
export function formatDate(
  locale: Locale,
  d: Date | string,
  style: "long" | "short" | "datetime" | "month" | "day" | "time"
): string {
  const opts: Intl.DateTimeFormatOptions =
    style === "time"
      ? {
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
          timeZone: "UTC",
          timeZoneName: "short",
        }
      : style === "day"
        ? { day: "numeric", month: "short", timeZone: "UTC" }
        : style === "month"
          ? { month: "short", year: "numeric", timeZone: "UTC" }
          : style === "long"
            ? { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }
            : style === "datetime"
              ? {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  hourCycle: "h23",
                  timeZone: "UTC",
                  timeZoneName: "short",
                }
              : { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" };
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(locale, opts).format(date);
}

/** Each unit, its length in seconds, and the rounded count at which the next unit takes over. */
const UNITS: [Intl.RelativeTimeFormatUnit, number, number][] = [
  ["second", 1, 60],
  ["minute", 60, 60],
  ["hour", 3600, 24],
  ["day", 86400, 30],
  ["month", 2592000, 12],
  ["year", 31536000, Infinity],
];

export function formatRelative(locale: Locale, d: Date | string, now: Date = new Date()): string {
  const time = new Date(d).getTime();
  if (Number.isNaN(time)) return "";
  const seconds = (time - now.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  // Smallest unit whose ROUNDED count stays under the next unit: 3599 s is "1 hour", not "60 minutes".
  for (const [unit, size, next] of UNITS) {
    const count = Math.round(seconds / size);
    if (Math.abs(count) < next) return rtf.format(count, unit);
  }
  return "";
}
