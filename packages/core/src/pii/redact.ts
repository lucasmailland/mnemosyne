// packages/mnemosyne/src/pii/redact.ts
//
// REDACT policy — replace every PII match with [REDACTED-<category>].
// Uses global regex flag so all occurrences are masked, not just the first.
//
// `redactPII` returns just the redacted string (back-compat).
// `redactPIIWithCategories` returns `{ redacted, categories }` so callers
// (e.g. createFact's PII wiring) can stash matched categories in metadata
// without re-running detection.

import { PII_PATTERNS, PII_SEVERITY, PII_VALIDATORS, type PIICategory } from "./patterns";

/**
 * Categories in DESCENDING severity, so the most sensitive pattern gets first
 * claim on an ambiguous run of digits.
 *
 * P119. This used to be plain `Object.entries(PII_PATTERNS)` — i.e. whatever
 * order the object literal happened to be written in, with `phone` above
 * `credit_card`. That is not a stylistic detail: each match REPLACES text, so
 * whichever pattern runs first consumes the digits. With a phone pattern loose
 * enough to match `4111 1111 1111`, a separated card number would be rewritten
 * to `[REDACTED-phone] 1111` — mislabelled, and leaking the last four digits.
 *
 * Ordering by the severity table that already exists makes that impossible by
 * construction rather than by luck, and it keeps working if someone later
 * widens a low-severity pattern.
 */
const CATEGORIES_BY_SEVERITY = (Object.keys(PII_PATTERNS) as PIICategory[]).sort(
  (a, b) => PII_SEVERITY[b] - PII_SEVERITY[a]
);

export interface RedactPIIResult {
  redacted: string;
  categories: PIICategory[];
}

export interface PIIScanResult extends RedactPIIResult {
  /** The first accepted match per category, in severity order. */
  matches: Array<{ category: PIICategory; match: string }>;
}

// SEC-8: matching runs on the ORIGINAL text and records spans; the output is
// built once at the end. A match its validator rejects still claims its span,
// so a later, looser pattern cannot take part of it — `2026 1017 1234 5678`
// fails Luhn, and without this the 2-4/4/4 phone alternative would rewrite it
// to "[REDACTED-phone] 5678". Nothing outside an accepted span is ever touched
// (an earlier in-band placeholder scheme corrupted text that already held
// private-use characters).
interface ClaimedSpan {
  start: number;
  end: number;
  /** null = a candidate the validator rejected: kept verbatim, but claimed. */
  category: PIICategory | null;
}

export function scanPII(text: string): PIIScanResult {
  const claimed: ClaimedSpan[] = [];
  const categories = new Set<PIICategory>();
  const matches: PIIScanResult["matches"] = [];
  const overlapsClaimed = (start: number, end: number) =>
    claimed.some((span) => start < span.end && end > span.start);
  for (const cat of CATEGORIES_BY_SEVERITY) {
    const re = PII_PATTERNS[cat];
    const validate = PII_VALIDATORS[cat];
    const gre = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = gre.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (end === start) {
        gre.lastIndex++;
        continue;
      }
      // A more sensitive pattern (or a kept candidate) already owns part of
      // this text; look again from the next character.
      if (overlapsClaimed(start, end)) {
        gre.lastIndex = start + 1;
        continue;
      }
      if (validate && !validate(m[0], text.slice(0, start), text.slice(end))) {
        claimed.push({ start, end, category: null });
        continue;
      }
      claimed.push({ start, end, category: cat });
      if (!categories.has(cat)) matches.push({ category: cat, match: m[0] });
      categories.add(cat);
    }
  }
  let out = "";
  let pos = 0;
  for (const span of claimed.filter((s) => s.category !== null).sort((a, b) => a.start - b.start)) {
    out += text.slice(pos, span.start) + `[REDACTED-${span.category}]`;
    pos = span.end;
  }
  out += text.slice(pos);
  return { redacted: out, categories: Array.from(categories), matches };
}

export function redactPIIWithCategories(text: string): RedactPIIResult {
  const { redacted, categories } = scanPII(text);
  return { redacted, categories };
}

export function redactPII(text: string): string {
  return redactPIIWithCategories(text).redacted;
}
