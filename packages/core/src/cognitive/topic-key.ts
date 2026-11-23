// packages/core/src/cognitive/topic-key.ts
//
// Pure, deterministic `topicKey` derivation. No I/O, no LLM/embedding call —
// this is advisory string shaping only. See
// docs/archive/openspec/topickey-suggest-and-hit-freshness/design.md §1 for the exact
// algorithm this file implements; keep this file and that doc in sync.
//
// Key grammar (D1): `level1[/level2]`, words within a level joined by `-`,
// alphabet `[a-z0-9/-]`. This is the exact form
// `packages/core/src/primitives/decision.ts` and the `uniq_mnemo_decision_topic`
// partial unique index (migration 0017, normalized) match on:
// `lower(btrim(topicKey)) === topicKey` holds for every output of
// `suggestTopicKey()`.

import { createHash } from "node:crypto";

export interface SuggestTopicKeyInput {
  subject?: string | null;
  body?: string | null;
  /**
   * AGENTSIM-5 — WHAT the fact is about ("deploy method", "runtime version"),
   * as opposed to what it currently says. When given, the key is derived from
   * `subject` + `attribute` and `body` is ignored, so the old value and the
   * new one get the same key and the update supersedes instead of piling up.
   * Omitted → the legacy subject/body derivation, unchanged.
   */
  attribute?: string | null;
}

export interface TopicKeySuggestion {
  topicKey: string;
  /** 1 or 2 entries — the hyphen-joined levels `topicKey` was assembled from. */
  levels: string[];
  source:
    | "identity"
    | "subject+body"
    | "subject"
    | "body"
    | "fallback"
    | "subject+attribute"
    | "attribute";
}

/** Canonical key grammar — also the idempotence short-circuit test (D2). */
export const CANONICAL_TOPIC_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

const MAX_L1_TOKENS = 2;
const MAX_L2_TOKENS = 3;
const MIN_TOKEN_LEN = 3;
const MAX_LEVEL_CHARS = 40;
const MAX_KEY_CHARS = 80;

// D3: a new local bilingual (EN + ES) stopword set, deliberately NOT shared
// with `recall-pointer.ts`'s `STOPWORDS` — different tuning target, and
// coupling would let one tuning change silently move the other.
export const TOPIC_KEY_STOPWORDS = new Set<string>([
  // English
  "the",
  "and",
  "for",
  "are",
  "was",
  "were",
  "with",
  "that",
  "this",
  "these",
  "those",
  "from",
  "have",
  "has",
  "had",
  "what",
  "when",
  "where",
  "which",
  "who",
  "how",
  "not",
  "but",
  "its",
  "into",
  "your",
  "you",
  "our",
  "their",
  "his",
  "her",
  "them",
  "then",
  "than",
  "also",
  "will",
  "would",
  "could",
  "should",
  "been",
  "being",
  "did",
  "does",
  "doing",
  "about",
  "over",
  "under",
  "again",
  "just",
  "very",
  // Spanish
  "para",
  "por",
  "con",
  "sin",
  "del",
  "las",
  "los",
  "que",
  "como",
  "cuando",
  "donde",
  "este",
  "esta",
  "estos",
  "estas",
  "eso",
  "esa",
  "esos",
  "esas",
  "pero",
  "sus",
  "nuestro",
  "nuestra",
  "tambien",
  "sobre",
  "entre",
  "hacia",
  "desde",
  "porque",
  "todo",
  "toda",
  "todos",
  "todas",
  "muy",
  "mas",
]);

function normalizeSegment(text: string | null | undefined): string[] {
  const normalized = String(text ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return normalized.length === 0 ? [] : normalized.split(" ");
}

function filterTokens(rawTokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of rawTokens) {
    if (TOPIC_KEY_STOPWORDS.has(token)) continue;
    const hasDigit = /[0-9]/.test(token);
    const keepShort = token.length === 2 && hasDigit;
    if (token.length < MIN_TOKEN_LEN && !keepShort) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/** Accent-folded, lowercased, stopword-filtered and deduplicated content terms of `text`. */
export function contentTerms(text: string | null | undefined): string[] {
  return filterTokens(normalizeSegment(text));
}

type LevelSource = Exclude<
  TopicKeySuggestion["source"],
  "identity" | "fallback" | "subject+attribute" | "attribute"
>;

function assembleLevels(
  subjectTokens: string[],
  bodyTokens: string[]
): { levels: string[][]; source: LevelSource } | null {
  if (subjectTokens.length > 0 && bodyTokens.length > 0) {
    const l1 = subjectTokens.slice(0, MAX_L1_TOKENS);
    const l1Set = new Set(l1);
    const l2 = bodyTokens.filter((t) => !l1Set.has(t)).slice(0, MAX_L2_TOKENS);
    return { levels: l2.length > 0 ? [l1, l2] : [l1], source: "subject+body" };
  }
  if (subjectTokens.length === 0 && bodyTokens.length > 0) {
    const l1 = bodyTokens.slice(0, MAX_L1_TOKENS);
    const l2 = bodyTokens.slice(MAX_L1_TOKENS, MAX_L1_TOKENS + MAX_L2_TOKENS);
    return { levels: l2.length > 0 ? [l1, l2] : [l1], source: "body" };
  }
  if (subjectTokens.length > 0 && bodyTokens.length === 0) {
    return { levels: [subjectTokens.slice(0, MAX_L1_TOKENS)], source: "subject" };
  }
  return null;
}

/** Drop trailing tokens (token-boundary only) until the level fits, keeping ≥1. */
function clampLevel(tokens: string[]): string[] {
  let kept = tokens;
  while (kept.join("-").length > MAX_LEVEL_CHARS && kept.length > 1) {
    kept = kept.slice(0, -1);
  }
  return kept;
}

/** Drop L2 first, then trailing L1 tokens (L1 always keeps ≥1 token). */
function clampKey(levels: string[][]): string[][] {
  let clamped = levels.map(clampLevel);
  if (clamped.map((l) => l.join("-")).join("/").length <= MAX_KEY_CHARS) return clamped;

  if (clamped.length > 1) {
    clamped = [clamped[0]!];
    if (clamped[0]!.join("-").length <= MAX_KEY_CHARS) return clamped;
  }

  let l1 = clamped[0]!;
  while (l1.join("-").length > MAX_KEY_CHARS && l1.length > 1) {
    l1 = l1.slice(0, -1);
  }
  return [l1];
}

function fallbackKey(rawSubject: string, rawBody: string): { topicKey: string; levels: string[] } {
  if (rawSubject.trim().length === 0 && rawBody.trim().length === 0) {
    return { topicKey: "general", levels: ["general"] };
  }
  // node:crypto is already used inside cognitive/remember.ts — not an
  // infrastructure import, safe under the v3-purity guard (S9).
  const hash = createHash("sha256").update(`${rawSubject} ${rawBody}`).digest("hex").slice(0, 8);
  return { topicKey: `general/${hash}`, levels: ["general", hash] };
}

/**
 * Derive a deterministic, idempotent `topicKey` from a subject/body pair.
 * Pure, sync, zero I/O, zero LLM/embed calls. See file header for the
 * design doc this mirrors.
 */
export function suggestTopicKey(input: SuggestTopicKeyInput): TopicKeySuggestion {
  const rawSubject = String(input.subject ?? "");
  const rawBody = String(input.body ?? "");

  // Step 0 — canonical short-circuit (D2): a canonical-grammar subject with
  // no body returns unchanged. This is what makes
  // suggest({ subject: suggest(x).topicKey }).topicKey === x hold.
  const subjectTrimmed = rawSubject.trim();
  const bodyBlank = rawBody.trim().length === 0;
  const attributeBlank = String(input.attribute ?? "").trim().length === 0;
  if (
    bodyBlank &&
    attributeBlank &&
    subjectTrimmed.length > 0 &&
    subjectTrimmed.length <= MAX_KEY_CHARS &&
    CANONICAL_TOPIC_KEY.test(subjectTrimmed)
  ) {
    return { topicKey: subjectTrimmed, levels: subjectTrimmed.split("/"), source: "identity" };
  }

  const subjectTokens = filterTokens(normalizeSegment(rawSubject));

  // AGENTSIM-5 — attribute-based key: subject (L1) + attribute (L2), body
  // ignored. Same shape and limits as the subject/body path, so the key
  // grammar is unchanged.
  const attributeTokens = filterTokens(normalizeSegment(input.attribute));
  if (attributeTokens.length > 0) {
    const l1 = subjectTokens.slice(0, MAX_L1_TOKENS);
    const l1Set = new Set(l1);
    const l2 = attributeTokens.filter((t) => !l1Set.has(t)).slice(0, MAX_L2_TOKENS);
    const raw =
      l1.length > 0 ? (l2.length > 0 ? [l1, l2] : [l1]) : [attributeTokens.slice(0, MAX_L2_TOKENS)];
    const levels = clampKey(raw).map((l) => l.join("-"));
    return {
      topicKey: levels.join("/"),
      levels,
      source: l1.length > 0 ? "subject+attribute" : "attribute",
    };
  }

  const bodyTokens = filterTokens(normalizeSegment(rawBody));

  const derived = assembleLevels(subjectTokens, bodyTokens);
  if (derived === null) {
    const { topicKey, levels } = fallbackKey(rawSubject, rawBody);
    return { topicKey, levels, source: "fallback" };
  }

  const clampedLevels = clampKey(derived.levels);
  const levels = clampedLevels.map((l) => l.join("-"));
  return { topicKey: levels.join("/"), levels, source: derived.source };
}
