import type { Fact } from "../deps.js";

/**
 * Pure fact-comparison domain logic, relocated from
 * `packages/mcp/src/tools/compare.ts` (docs/archive/openspec/decompose-recall-and-compare,
 * Slice 2). No Hono, no adapter, no I/O — `compareFacts` takes two already-
 * resolved wire-shaped facts and returns a structured diff, a same-subject
 * judgment, and a suggested relation verb. The `POST /facts/compare` route
 * (`../routes/factsCompare.ts`) owns fetching, the 404/sensitivity-ceiling
 * guard, and wiring this pure function to HTTP.
 *
 * Verb suggestion heuristic:
 *   - Both refer to the same subject AND one was created later      → supersedes
 *   - Same subject, different claims, no clear temporal order       → conflicts_with
 *   - One fact's content is a subset / qualifier of the other       → scoped
 *   - Everything else (including different workspaces)              → compatible
 *
 * Diff scope: content, pinned, and the valid-time interval only — `mnemo_fact`
 * has no persisted `tags` column, so tag-based diffing was removed rather than
 * left as unreachable dead code (docs/archive/openspec/complete-mcp-tools, B6).
 */

/** Wire-shaped fact this module compares. Matches `routes/facts.ts`'s `FactSchema`. */
export type ApiFact = Fact;

export type SuggestableVerb = "supersedes" | "conflicts_with" | "compatible" | "scoped";

export interface FactComparison {
  differences: string[];
  suggestedVerb: SuggestableVerb;
  sameSubject: boolean;
}

export function compareFacts(a: ApiFact, b: ApiFact): FactComparison {
  const differences = computeDifferences(a, b);
  const sameSubject = detectSameSubject(a, b);
  const suggestedVerb = suggestVerb(a, b, sameSubject);
  return { differences, suggestedVerb, sameSubject };
}

/**
 * Returns a list of human-readable difference strings between two facts.
 * Each entry describes which field changed and what the two values are.
 */
function computeDifferences(a: ApiFact, b: ApiFact): string[] {
  const diffs: string[] = [];

  if (a.content !== b.content) {
    diffs.push(`content: "${a.content}" → "${b.content}"`);
  }

  if (a.pinned !== b.pinned) {
    diffs.push(`pinned: ${a.pinned} → ${b.pinned}`);
  }

  if (a.validFrom !== b.validFrom) {
    diffs.push(`validFrom: ${a.validFrom} → ${b.validFrom}`);
  }

  if (a.validTo !== b.validTo) {
    diffs.push(`validTo: ${a.validTo ?? "null"} → ${b.validTo ?? "null"}`);
  }

  if (diffs.length === 0) {
    diffs.push("No field differences detected (content and metadata are identical).");
  }

  return diffs;
}

/**
 * Heuristic: are these two facts about the same subject?
 *
 * Strategy: extract a leading "subject phrase" from each content string and
 * compare them (first 6 tokens, lowercased). 60% token overlap counts as
 * same subject.
 */
function detectSameSubject(a: ApiFact, b: ApiFact): boolean {
  // Token overlap on the first sentence / clause of each content.
  const tokensA = leadingTokens(a.content);
  const tokensB = leadingTokens(b.content);
  if (tokensA.length === 0 || tokensB.length === 0) return false;

  const setA = new Set(tokensA);
  const overlap = tokensB.filter((t) => setA.has(t)).length;
  const minLen = Math.min(tokensA.length, tokensB.length);
  return minLen > 0 && overlap / minLen >= 0.6;
}

/** Extract the first N meaningful tokens from a content string. */
function leadingTokens(content: string, n = 6): string[] {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, n);
}

/**
 * Suggest the most appropriate relation verb given the two facts.
 *
 * Decision tree:
 *   - Same subject + factB is newer           → supersedes (B supersedes A)
 *   - Same subject + factA is newer           → supersedes (A supersedes B, noted in result)
 *   - Same subject + no clear temporal order  → conflicts_with
 *   - Different subjects, one is closed       → scoped (one is context of the other)
 *   - Default fallback                        → compatible
 */
function suggestVerb(a: ApiFact, b: ApiFact, sameSubject: boolean): SuggestableVerb {
  if (sameSubject) {
    const timeA = new Date(a.createdAt).getTime();
    const timeB = new Date(b.createdAt).getTime();
    // If timestamps differ by more than a minute, the newer one supersedes.
    if (Math.abs(timeB - timeA) > 60_000) {
      return "supersedes";
    }
    // Same subject, close in time → likely a conflict.
    return "conflicts_with";
  }

  // One fact is closed (validTo set) while the other is open — likely scoped context.
  if ((a.validTo !== null) !== (b.validTo !== null)) {
    return "scoped";
  }

  // Default: no obvious contradiction → compatible.
  return "compatible";
}
