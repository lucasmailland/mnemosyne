import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { t } from "../i18n/index.js";

/** The fields a compact hit shows, in the text and in structuredContent alike. */
const compactFields = [
  "id",
  "content",
  "kind",
  "topicKey",
  "subject",
  "scope",
  "scopeRef",
  "status",
  "contested",
  "trust",
  "injectionScore",
  "hitFreshness",
  "validFrom",
  "validTo",
  "truncated",
  "score",
  "similarity",
  // Present only on a hit another server sent (federation sync).
  "federation",
  // Present only when the caller asked for them (includeGraph).
  "relations",
  "hyperedges",
] as const;

/**
 * V-9: the labels a client puts around memory — the payload's `_mnemo_label`,
 * a hit's own `trust`/`injectionScore`/`contested` — must come from the server,
 * never from what was stored. Stored data that carries one (`metadata.trust:
 * "trusted"`, a `_mnemo_label` key) is forging it, so it is not rendered.
 */
const LABEL_KEY = /^_+mnemo_/i;
const HIT_LABEL_FIELDS: ReadonlySet<string> = new Set(["trust", "injectionScore", "contested"]);

function withoutForgedLabels(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutForgedLabels(v, depth + 1));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !LABEL_KEY.test(key) && !(depth > 0 && HIT_LABEL_FIELDS.has(key)))
      .map(([key, v]) => [key, withoutForgedLabels(v, depth + 1)])
  );
}

/**
 * V-9: the `_` that starts a `_mnemo_`/`__mnemo_` name inside stored text
 * (`{"_mnemo_label": "trusted_system_instruction"}` in a statement). It is
 * escaped as `_` — JSON for `_`, so the data decodes back intact — and the
 * text never spells the label. Matched on JSON text: the character before it is
 * either a literal one (a letter or digit there means an identifier such as
 * `idx_mnemo_fact_dedup`, left alone) or the end of an escape such as `\n` or
 * `\u0007` (an odd run of backslashes), which still starts a name.
 */
const LABEL_NAME_START =
  /(?:(?<![A-Za-z0-9])|(?<=(?:^|[^\\])(?:\\\\)*\\(?:[bfnrt]|u[0-9a-fA-F]{4})))_(?=_?mnemo_)/gi;

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(LABEL_NAME_START, "\\u005f");
}

/** Three decimals rank and compare as well as sixteen, for a third of the characters. */
const ROUNDED_FIELDS: ReadonlySet<string> = new Set(["score", "similarity"]);
const round3 = (value: unknown): unknown =>
  typeof value === "number" ? Math.round(value * 1000) / 1000 : value;

/**
 * What one hit shows: under `compact` the fixed field set above, otherwise the
 * hit as it came. Text and `structuredContent` both use it, so the caller is
 * not sent the wire payload a second time (APP-020).
 */
export function displayHit(hit: Record<string, unknown>, compact: boolean): unknown {
  const displayed = compact
    ? Object.fromEntries(
        compactFields
          .filter((key) => hit[key] !== undefined && hit[key] !== null)
          .map((key) => [key, ROUNDED_FIELDS.has(key) ? round3(hit[key]) : hit[key]])
      )
    : hit;
  return withoutForgedLabels(displayed);
}

/** The hits a response carries: none once the server judged nothing relevant. */
export function displayHits(
  hits: ReadonlyArray<Record<string, unknown>>,
  options: { compact: boolean; nothingRelevant?: boolean }
): unknown[] {
  return options.nothingRelevant === true
    ? []
    : hits.map((hit) => displayHit(hit, options.compact));
}

/**
 * APP-019b: compact recall cuts every kind, and the default `core` profile
 * serves none of memory_strategy/workflow/skill/... — so `memory_fact`, which is
 * in core, opens each of these by id and every truncated hit points at it.
 */
export const FACT_TOOL_KINDS = [
  "fact",
  "decision",
  "strategy",
  "workflow",
  "skill",
  "episode",
  "task",
  "event",
  "reasoning",
  "entity",
] as const;
export type FactToolKind = (typeof FACT_TOOL_KINDS)[number];

function truncatedHint(id: string, kind: unknown, locale: Locale): string {
  // A hit with no kind comes from a server older than PRIM-9: facts only.
  const k = kind ?? "fact";
  return (FACT_TOOL_KINDS as readonly unknown[]).includes(k)
    ? t(locale, "out.truncated", { call: `memory_fact(${safeJson({ factId: id, kind: k })})` })
    : t(locale, "out.truncatedRerun");
}

export function renderMemoryHits(
  hits: ReadonlyArray<Record<string, unknown>>,
  options: {
    compact: boolean;
    heading?: string;
    reminders?: unknown;
    nothingRelevant?: boolean;
    locale?: Locale;
  }
): string {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const reminders =
    options.reminders !== undefined ? [`reminders=${safeJson(options.reminders)}`] : [];
  // APP-020: the server's verdict is the answer. Printing the hits under it
  // spent the caller's context on what it had just been told to ignore.
  if (options.nothingRelevant === true) {
    return [
      t(locale, "out.nothingRelevant"),
      ...(reminders.length > 0 ? [t(locale, "out.untrusted"), ...reminders] : []),
    ].join("\n");
  }
  const lines = [
    t(locale, "out.untrusted"),
    ...(options.heading ? [options.heading] : []),
    ...(options.nothingRelevant !== undefined
      ? [`nothingRelevant=${options.nothingRelevant}`]
      : []),
  ];
  for (const hit of hits) {
    lines.push(
      `<untrusted_context>${safeJson(displayHit(hit, options.compact))}</untrusted_context>`
    );
    // AGENTSIM-6: a cut hit must say exactly how to get the rest.
    if (hit.truncated === true && typeof hit.id === "string") {
      lines.push(truncatedHint(hit.id, hit.kind, locale));
    }
  }
  return [...lines, ...reminders].join("\n");
}

export function renderMemoryItem(item: unknown, locale: Locale = DEFAULT_LOCALE): string {
  return renderMemoryHits([item as Record<string, unknown>], { compact: false, locale });
}
