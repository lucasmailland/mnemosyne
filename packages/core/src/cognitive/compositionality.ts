// packages/core/src/v3/compositionality.ts
// §32 Compositionality / Inference Engine — pure forward-chaining over recall results.
// HEXAGONAL PURITY: zero infrastructure dependencies. No ORM, no DB, no cache.
import { parseConditionDsl, parseActionDsl } from "@mnemo-ai/types";
import type {
  ConditionDsl,
  ActionDsl,
  RecallHit,
  DerivedInference,
  Sensitivity,
  MaterialiseInferenceInput,
} from "@mnemo-ai/types";
import type { CoreContext } from "./context.js";

const MAX_FIRINGS_PER_CALL = 50;
const MAX_HOP_DEPTH = 4;
// §32: inferences with confidence at or below this floor are dropped before
// being returned (and never re-fed as premises in the fixpoint loop). A low
// confidence means the premises themselves were low-worth, so the derivation is
// too weak to surface or to chain further.
const MIN_INFERENCE_CONFIDENCE = 0.5;

// Local sensitivity ordering — cannot import SENS_ORDER from @mnemo-ai/types (it
// doesn't exist there); the exported name is SENSITIVITY_ORDER but redefining locally
// avoids a chain import. Keep in sync with security.ts SENSITIVITY_ORDER.
const SENS_RANK: Record<string, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };
function rankToSens(n: number): string {
  return (["public", "internal", "confidential", "restricted"])[Math.max(0, Math.min(3, n))] ?? "internal";
}

export interface ComposeOpts {
  materialise?: boolean;
  triggeredByQuery?: string;
  conversationId?: string;
  /**
   * §32: inferences with confidence <= this floor are dropped. Defaults to
   * MIN_INFERENCE_CONFIDENCE (0.5) on the recall path so weak inferences are
   * never surfaced. The dry-run/preview path passes 0 so rule authors can see
   * every inference a rule WOULD produce (with its confidence shown).
   */
  minConfidence?: number;
}

// exported for H4 dry-run (evaluateRule is called directly on a single rule)
export interface SyntheticRule {
  id: string;
  name: string;
  conditionDsl: unknown;
  actionDsl: unknown;
  priority: number;
  isActive: boolean;
  executionCount: number;
}

/**
 * Evaluate a single rule against a set of recall hits.
 * Used by composeInferences (in a loop over all active rules) and by
 * H4 dryRunComposition (on a single saved or synthetic inline rule).
 * Always forces materialise:false in dry-run (H4) — set opts.materialise=false.
 */
export async function evaluateRule(
  ctx: CoreContext,
  rule: SyntheticRule,
  workspaceId: string,
  hits: RecallHit[],
  opts: ComposeOpts,
  // Optional cross-call dedup set. When provided (by the composeInferences
  // fixpoint loop), a `${ruleId}::${statement}` key already present is skipped
  // BEFORE any materialise/append side-effect — so re-evaluating the same
  // premises across hops never double-writes. When omitted (dry-run route,
  // single-rule tests), a fresh local set is used per call.
  seen?: Set<string>,
): Promise<DerivedInference[]> {
  let condition: ConditionDsl;
  let action: ActionDsl;
  try {
    condition = parseConditionDsl(rule.conditionDsl);
    action = parseActionDsl(rule.actionDsl);
  } catch (err) {
    ctx.logger.warn("composition.rule.invalid_dsl", {
      error: { type: "invalid_dsl", message: String(err) },
      ruleId: rule.id,
    });
    return [];
  }

  const matches = matchClauses(condition, hits);
  const out: DerivedInference[] = [];
  const seenStatements = seen ?? new Set<string>();

  for (const bindings of matches) {
    const premises = Object.values(bindings);
    const inputFactIds = premises.map((h) => h.id);

    const statement = expandTemplate(action.statementTemplate, bindings, workspaceId);
    const dedupKey = `${rule.id}::${statement}`;
    if (seenStatements.has(dedupKey)) continue;
    seenStatements.add(dedupKey);

    const premiseAvgWorth =
      premises.length === 0
        ? 0.5
        : premises.reduce((acc, h) => acc + (h.worth ?? h.score ?? 0.5), 0) / premises.length;
    // Priority is ORDERING only, not a confidence multiplier.
    const confidence = Math.max(0, Math.min(1, action.baseConfidence * premiseAvgWorth));

    // §32 confidence filter: drop weak derivations BEFORE any materialise/append
    // side-effect. A sub-threshold inference must neither be persisted nor surfaced
    // nor re-fed as a premise in a later hop. Skipping here (after marking the
    // statement seen) prevents the same weak derivation being re-attempted.
    if (confidence <= (opts.minConfidence ?? MIN_INFERENCE_CONFIDENCE)) continue;

    // Sensitivity ceiling: cannot exceed lowest of premises.
    const actionRank = SENS_RANK[action.sensitivity] ?? 1;
    const premiseFloor = premises.reduce(
      (acc, h) => Math.min(acc, SENS_RANK[h.sensitivity ?? "internal"] ?? 1),
      actionRank,
    );
    const derivedSensitivity = rankToSens(premiseFloor);

    const rationale = `Rule "${rule.name}" matched ${premises.length} premise(s); confidence = ${confidence.toFixed(3)}.`;

    const inf: DerivedInference = {
      ruleId: rule.id,
      ruleName: rule.name,
      inputFactIds,
      derivedKind: action.kind,
      derivedStatement: statement,
      confidence,
      type: action.type,
      rationale,
    };

    if (opts.materialise === true) {
      // ── Verb branch: derive_fact vs derive_warning ──────────────────────────
      // derive_fact: persist a new fact via materialiseInference (atomic TX).
      // derive_warning: surface only — log the inference but do NOT write a fact.
      //   Warnings are ephemeral signals for the caller; persisting them as facts
      //   would pollute recall results and distort worth propagation.
      if (action.op === "derive_fact") {
        try {
          const matInput: MaterialiseInferenceInput = {
            ruleId: rule.id,
            workspaceId,
            fact: {
              scope: "global",
              kind: "other",
              subject: "workspace",
              statement,
              attribution: "inferred",
              sensitivity: derivedSensitivity as Sensitivity,
              metadata: {
                inference: { ruleId: rule.id, premises: inputFactIds, confidence, derivedKind: action.kind, type: action.type },
                ...(action.topicKey ? { topicKey: action.topicKey } : {}),
              },
            },
            inferenceLog: {
              inputFactIds,
              derivedKind: action.kind,
              confidence,
              rationale,
              ...(opts.triggeredByQuery ? { triggeredByQuery: opts.triggeredByQuery } : {}),
              ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
            },
          };
          const fact = await ctx.storage.materialiseInference(matInput);
          inf.materialisedFactId = fact.id;
        } catch (err) {
          ctx.logger.warn("composition.materialise_failed", {
            error: { type: "materialise_failed", message: String(err) },
            ruleId: rule.id,
          });
        }
      } else {
        // derive_warning: log without persisting a fact.
        try {
          await ctx.storage.appendInference({
            workspaceId,
            ruleId: rule.id,
            inputFactIds,
            derivedKind: action.kind,
            confidence,
            rationale,
            ...(opts.triggeredByQuery ? { triggeredByQuery: opts.triggeredByQuery } : {}),
            ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
          });
          await ctx.storage.bumpCompositionExecution(rule.id, workspaceId);
        } catch (err) {
          ctx.logger.warn("composition.warning_log_failed", {
            error: { type: "warning_log_failed", message: String(err) },
            ruleId: rule.id,
          });
        }
      }
      out.push(inf);
      continue;
    }

    // Dry-run path: log best-effort, swallow errors.
    try {
      await ctx.storage.appendInference({
        workspaceId,
        ruleId: rule.id,
        inputFactIds,
        derivedKind: action.kind,
        confidence,
        rationale,
        ...(opts.triggeredByQuery ? { triggeredByQuery: opts.triggeredByQuery } : {}),
        ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
      });
      await ctx.storage.bumpCompositionExecution(rule.id, workspaceId);
    } catch (err) {
      ctx.logger.warn("composition.log_failed", {
        error: { type: "log_failed", message: String(err) },
        ruleId: rule.id,
      });
    }
    out.push(inf);
  }

  return out;
}

export async function composeInferences(
  ctx: CoreContext,
  workspaceId: string,
  hits: RecallHit[],
  opts: ComposeOpts = {},
): Promise<DerivedInference[]> {
  if (hits.length === 0) return [];

  const rulesPage = await ctx.storage.queryCompositionRules({
    workspaceId,
    isActive: true,
    limit: 500,
  });

  // Sort by priority DESC (higher priority = evaluated first).
  const sortedRules = [...rulesPage.items].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  const out: DerivedInference[] = [];
  const seenGlobal = new Set<string>();
  let firings = 0;
  let workingHits = [...hits];

  // Forward-chaining fixpoint: each hop re-feeds the facts derived in the
  // previous hop as new premises, so a derived fact can satisfy a downstream
  // rule. Confidence compounds per hop (premiseAvgWorth on the derived facts
  // is lower), so STEP_n < STEP_{n-1}. Bounded by MAX_HOP_DEPTH and
  // MAX_FIRINGS_PER_CALL; terminates early when a hop derives nothing new.
  for (let hop = 0; hop < MAX_HOP_DEPTH && firings < MAX_FIRINGS_PER_CALL; hop++) {
    const derivedThisHop: DerivedInference[] = [];

    for (const rule of sortedRules) {
      if (firings >= MAX_FIRINGS_PER_CALL) break;
      // Pass seenGlobal so evaluateRule skips (and never materialises) any
      // ${ruleId}::${statement} already emitted in an earlier hop. Every
      // inference returned here is therefore genuinely new.
      const infs = await evaluateRule(ctx, rule as SyntheticRule, workspaceId, workingHits, opts, seenGlobal);
      for (const inf of infs) {
        if (firings >= MAX_FIRINGS_PER_CALL) break;
        out.push(inf);
        derivedThisHop.push(inf);
        firings++;
      }
    }

    if (derivedThisHop.length === 0) break;

    const synthetic: RecallHit[] = derivedThisHop.map((inf) => ({
      id: inf.materialisedFactId ?? `derived:${inf.ruleId}:${seenGlobal.size}`,
      primitive: "fact",
      content: inf.derivedStatement,
      score: inf.confidence,
      sensitivity: "internal",
      injectionScore: 0,
      provenance: "inferred",
      origin: "local",
      contested: false,
      validFrom: new Date(),
      validTo: null,
      tags: [],
      relations: [],
      worth: inf.confidence,
      factKind: inf.derivedKind,
    } as unknown as RecallHit));
    workingHits = [...workingHits, ...synthetic];
  }

  return resolveConflicts(out, sortedRules);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function expandTemplate(
  tpl: string,
  bindings: Record<string, RecallHit>,
  workspaceId: string,
): string {
  return tpl.replace(/\$ws|\$[a-z][a-z0-9_]*/gi, (token) => {
    if (token === "$ws") return workspaceId;
    const hit = bindings[token];
    return hit ? hit.content : token;
  });
}

type Bindings = Record<string, RecallHit>;

function parseFactValue(content: string, valueType: "duration" | "number"): number | null {
  if (valueType === "number") {
    const m = content.match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
  const m = content.match(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)\b/i);
  if (!m) {
    const bare = content.match(/-?\d+(\.\d+)?/);
    return bare ? Number(bare[0]) : null;
  }
  const n = Number(m[1]);
  switch (m[2]!.toLowerCase()) {
    case "ms": return n;
    case "s": return n * 1000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    default: return n;
  }
}

function compareOk(
  value: number,
  compare: { lt?: number | string; gt?: number | string; lte?: number | string; gte?: number | string } | undefined,
  resolve: (ref: number | string) => number | null,
): boolean {
  if (!compare) return true;
  for (const [k, ref] of Object.entries(compare)) {
    if (ref === undefined) continue;
    const rhs = resolve(ref as number | string);
    if (rhs === null) return false;
    if (k === "lt" && !(value < rhs)) return false;
    if (k === "gt" && !(value > rhs)) return false;
    if (k === "lte" && !(value <= rhs)) return false;
    if (k === "gte" && !(value >= rhs)) return false;
  }
  return true;
}

function matchClauses(cond: ConditionDsl, hits: RecallHit[]): Bindings[] {
  const results: Bindings[] = [];
  const byId = new Map(hits.map((h) => [h.id, h]));
  const valueCache = new Map<string, number | null>();

  function backtrack(idx: number, bindings: Bindings): void {
    if (idx === cond.all.length) {
      results.push({ ...bindings });
      return;
    }
    const clause = cond.all[idx]!;

    if (clause.op === "relation") {
      const fromCandidates = bindings[clause.from] ? [bindings[clause.from]!] : hits;
      for (const fromHit of fromCandidates) {
        if (bindings[clause.from] && bindings[clause.from]!.id !== fromHit.id) continue;
        for (const rel of fromHit.relations ?? []) {
          if (rel.verb !== clause.verb) continue;
          const toHit = byId.get(rel.targetId);
          if (!toHit) continue;
          if (bindings[clause.to] && bindings[clause.to]!.id !== toHit.id) continue;
          if (fromHit.id === toHit.id) continue;
          const setFrom = bindings[clause.from] === undefined;
          const setTo = bindings[clause.to] === undefined;
          bindings[clause.from] = fromHit;
          bindings[clause.to] = toHit;
          backtrack(idx + 1, bindings);
          if (setFrom) delete bindings[clause.from];
          if (setTo) delete bindings[clause.to];
        }
      }
      return;
    }

    if (clause.op === "fact_value") {
      const subjCandidates = bindings[clause.subject] ? [bindings[clause.subject]!] : hits;
      for (const h of subjCandidates) {
        if (bindings[clause.subject] && bindings[clause.subject]!.id !== h.id) continue;
        // Also enforce bind consistency if set
        const bindVar = (clause as { bind?: string }).bind;
        if (bindVar && bindings[bindVar] && bindings[bindVar]!.id !== h.id) continue;
        const setSubj = bindings[clause.subject] === undefined;
        const setBind = bindVar !== undefined && bindings[bindVar] === undefined;
        bindings[clause.subject] = h;
        if (bindVar) bindings[bindVar] = h;
        const ck = `${h.id}::${clause.valueType}`;
        if (!valueCache.has(ck)) valueCache.set(ck, parseFactValue(h.content, clause.valueType));
        const v = valueCache.get(ck)!;
        if (v !== null) {
          const ok = compareOk(v, clause.compare, (ref) =>
            typeof ref === "number" ? ref : (() => {
              const rh = bindings[ref];
              if (!rh) return null;
              const rck = `${rh.id}::${clause.valueType}`;
              if (!valueCache.has(rck)) valueCache.set(rck, parseFactValue(rh.content, clause.valueType));
              return valueCache.get(rck) ?? null;
            })(),
          );
          if (ok) backtrack(idx + 1, bindings);
        }
        if (setSubj) delete bindings[clause.subject];
        if (setBind && bindVar) delete bindings[bindVar];
      }
      return;
    }

    // Single-hit clauses (fact_kind / topic_key_in / text_contains)
    for (const h of hits) {
      if (!singleClauseMatches(clause, h)) continue;
      const bindVar = (clause as { bind?: string }).bind;
      if (bindVar && bindings[bindVar] && bindings[bindVar]!.id !== h.id) continue;
      const set = bindVar !== undefined && bindings[bindVar] === undefined;
      if (bindVar) bindings[bindVar] = h;
      backtrack(idx + 1, bindings);
      if (set && bindVar) delete bindings[bindVar];
    }
  }

  backtrack(0, {});
  return results;
}

function singleClauseMatches(
  clause: Extract<ConditionDsl["all"][number], { op: "fact_kind" | "topic_key_in" | "text_contains" }>,
  hit: RecallHit,
): boolean {
  switch (clause.op) {
    case "fact_kind":
      return hit.factKind === clause.kind || hit.primitive === clause.kind;
    case "topic_key_in":
      return clause.topicKeys.some((t: string) => hit.tags?.includes(t));
    case "text_contains":
      return hit.content.toLowerCase().includes(clause.needle.toLowerCase());
  }
}

// Conflict resolution: group derived statements by a polarity-stripped
// signature; within a group that contains BOTH a positive and a negative
// polarity, keep only the winner ranked by (rule priority, confidence) and
// drop the contradicting derivations.
function resolveConflicts(infs: DerivedInference[], rules: Array<{ id: string; priority?: number | null }>): DerivedInference[] {
  const priorityOf = new Map(rules.map((r) => [r.id, r.priority ?? 0]));
  const NEG = /\b(not|no|never|isn'?t|aren'?t|won'?t|can'?t)\b/i;

  function signature(s: string): string {
    return s.toLowerCase().replace(NEG, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  }
  function polarity(s: string): 1 | 0 {
    return NEG.test(s) ? 0 : 1;
  }

  const bySig = new Map<string, DerivedInference[]>();
  for (const inf of infs) {
    const sig = signature(inf.derivedStatement);
    const arr = bySig.get(sig) ?? [];
    arr.push(inf);
    bySig.set(sig, arr);
  }

  const dropped = new Set<DerivedInference>();
  for (const group of bySig.values()) {
    if (group.length < 2) continue;
    const polarities = new Set(group.map((g) => polarity(g.derivedStatement)));
    if (polarities.size < 2) continue;
    const winner = [...group].sort((a, b) => {
      const pa = priorityOf.get(a.ruleId) ?? 0;
      const pb = priorityOf.get(b.ruleId) ?? 0;
      if (pb !== pa) return pb - pa;
      return b.confidence - a.confidence;
    })[0]!;
    for (const g of group) if (g !== winner) dropped.add(g);
  }

  return infs.filter((i) => !dropped.has(i));
}
