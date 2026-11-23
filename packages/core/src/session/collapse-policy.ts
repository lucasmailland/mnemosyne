/**
 * resolveCollapsePolicy — pure mapping from an agent profile's metadata bag to a
 * fully-populated CollapsePolicy. Documented defaults (MEMORY_IMPROVEMENT.md
 * §Collapse Policy, lines 614-635) fill any field the agent did not override or
 * supplied with an invalid type.
 *
 * PURITY: depends only on @mnemo-ai/types — no drizzle/pg/redis/adapter imports.
 * The CollapsePolicy is read from profile.metadata.collapsePolicy, an untyped
 * Record<string, unknown>; every field is type-checked before use and silently
 * ignored when malformed.
 */
import type { MnemoAgentProfile } from "@mnemo-ai/types";
import type { CollapsePolicy } from "./collapse.js";

/** Spec defaults — MEMORY_IMPROVEMENT.md §Collapse Policy lines 618-634. */
export const DEFAULT_COLLAPSE_POLICY: Required<
  Pick<
    CollapsePolicy,
    | "mode"
    | "inactivityTimeout"
    | "maxTurns"
    | "maxTokens"
    | "minTurnsForCollapse"
    | "requirePin"
    | "extractFacts"
    | "extractDecisions"
    | "extractStrategies"
    | "extractTasks"
    | "recurrenceThreshold"
    | "skipLlmIfBelowThreshold"
  >
> = {
  mode: "auto",
  inactivityTimeout: 1800, // 30 min
  maxTurns: 50,
  maxTokens: 8192,
  minTurnsForCollapse: 3,
  requirePin: false,
  extractFacts: true,
  extractDecisions: true,
  extractStrategies: true,
  extractTasks: false,
  recurrenceThreshold: 0.6,
  skipLlmIfBelowThreshold: true,
};

const VALID_MODES = new Set<CollapsePolicy["mode"]>(["auto", "explicit", "hybrid"]);

function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Build a complete CollapsePolicy from a (possibly null) agent profile.
 * Returns a fresh object every call — never mutates DEFAULT_COLLAPSE_POLICY.
 */
export function resolveCollapsePolicy(profile: MnemoAgentProfile | null): CollapsePolicy {
  const out: CollapsePolicy = { ...DEFAULT_COLLAPSE_POLICY };
  const raw = (profile?.metadata as Record<string, unknown> | undefined)?.collapsePolicy;
  if (!raw || typeof raw !== "object") return out;
  const p = raw as Record<string, unknown>;

  if (typeof p.mode === "string" && VALID_MODES.has(p.mode as CollapsePolicy["mode"])) {
    out.mode = p.mode as CollapsePolicy["mode"];
  }
  if (isPositiveNumber(p.inactivityTimeout)) out.inactivityTimeout = p.inactivityTimeout;
  if (isPositiveNumber(p.maxTurns)) out.maxTurns = p.maxTurns;
  if (isPositiveNumber(p.maxTokens)) out.maxTokens = p.maxTokens;
  if (isPositiveNumber(p.minTurnsForCollapse)) out.minTurnsForCollapse = p.minTurnsForCollapse;
  if (isPositiveNumber(p.recurrenceThreshold)) out.recurrenceThreshold = p.recurrenceThreshold;
  if (typeof p.requirePin === "boolean") out.requirePin = p.requirePin;
  if (typeof p.extractFacts === "boolean") out.extractFacts = p.extractFacts;
  if (typeof p.extractDecisions === "boolean") out.extractDecisions = p.extractDecisions;
  if (typeof p.extractStrategies === "boolean") out.extractStrategies = p.extractStrategies;
  if (typeof p.extractTasks === "boolean") out.extractTasks = p.extractTasks;
  if (typeof p.skipLlmIfBelowThreshold === "boolean") {
    out.skipLlmIfBelowThreshold = p.skipLlmIfBelowThreshold;
  }
  if (p.hybridPolicy && typeof p.hybridPolicy === "object") {
    out.hybridPolicy = p.hybridPolicy as CollapsePolicy["hybridPolicy"];
  }
  return out;
}
