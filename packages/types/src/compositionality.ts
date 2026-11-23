// packages/types/src/compositionality.ts
// Composition rule DSL types and zod parsers.
import { z } from "zod";

// ── Conditions ────────────────────────────────────────────────────────────────

const FactKindClause = z.object({
  op: z.literal("fact_kind"),
  kind: z.string().min(1).max(64),
  bind: z.string().regex(/^\$[a-z][a-z0-9_]*$/i).optional(),
}).strict();

const TopicKeyInClause = z.object({
  op: z.literal("topic_key_in"),
  topicKeys: z.array(z.string().min(1).max(200)).min(1).max(32),
  bind: z.string().regex(/^\$[a-z][a-z0-9_]*$/i).optional(),
}).strict();

const TextContainsClause = z.object({
  op: z.literal("text_contains"),
  needle: z.string().min(1).max(500),
  bind: z.string().regex(/^\$[a-z][a-z0-9_]*$/i).optional(),
}).strict();

const RELATION_VERBS = [
  "related", "compatible", "scoped", "conflicts_with", "supersedes",
  "not_conflict", "derived_from", "part_of", "member_of",
] as const;

const BIND_RE = /^\$[a-z][a-z0-9_]*$/i;

const RelationClause = z.object({
  op: z.literal("relation"),
  from: z.string().regex(BIND_RE),
  to: z.string().regex(BIND_RE),
  verb: z.enum(RELATION_VERBS),
}).strict();

const NumberOrBind = z.union([z.number(), z.string().regex(BIND_RE)]);

const FactValueClause = z.object({
  op: z.literal("fact_value"),
  subject: z.string().regex(BIND_RE),
  predicate: z.string().min(1).max(128),
  valueType: z.enum(["duration", "number"]),
  compare: z.object({
    lt: NumberOrBind.optional(),
    gt: NumberOrBind.optional(),
    lte: NumberOrBind.optional(),
    gte: NumberOrBind.optional(),
  }).strict().partial().optional(),
  bind: z.string().regex(BIND_RE).optional(),
}).strict();

const ConditionClause = z.discriminatedUnion("op", [
  FactKindClause, TopicKeyInClause, TextContainsClause,
  RelationClause, FactValueClause,
]);

export const ConditionDslSchema = z.object({
  all: z.array(ConditionClause).min(1).max(8),
}).strict();

export type ConditionDsl = z.infer<typeof ConditionDslSchema>;

// ── Actions ───────────────────────────────────────────────────────────────────

const DeriveFactAction = z.object({
  op: z.literal("derive_fact"),
  statementTemplate: z.string().min(1).max(2000),
  // DSL kind: NOT a valid MnemoFact.kind — stored in metadata.inference.derivedKind.
  // Engine writes kind='other' to mnemo_fact (valid kind) and attribution='inferred'.
  kind: z.string().min(1).max(64).default("inferred"),
  topicKey: z.string().max(200).optional(),
  baseConfidence: z.number().min(0).max(1).default(0.7),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]).default("internal"),
  type: z.literal("fact").default("fact"),
}).strict();

const DeriveWarningAction = z.object({
  op: z.literal("derive_warning"),
  statementTemplate: z.string().min(1).max(2000),
  kind: z.string().min(1).max(64).default("inferred"),
  topicKey: z.string().max(200).optional(),
  baseConfidence: z.number().min(0).max(1).default(0.7),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]).default("internal"),
  type: z.literal("warning").default("warning"),
}).strict();

export const ActionDslSchema = z.discriminatedUnion("op", [DeriveFactAction, DeriveWarningAction]);
export type ActionDsl = z.infer<typeof ActionDslSchema>;

// ── Derived Inference (result shape) ─────────────────────────────────────────
// Defined here (in @mnemo-ai/types) so recall.ts can import it without
// a forbidden types→core dependency.

export interface DerivedInference {
  ruleId: string;
  ruleName: string;
  inputFactIds: string[];
  derivedKind: string;
  derivedStatement: string;
  confidence: number;
  type: "fact" | "warning";
  rationale: string;
  materialisedFactId?: string;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

export function parseConditionDsl(raw: unknown): ConditionDsl {
  return ConditionDslSchema.parse(raw);
}
export function parseActionDsl(raw: unknown): ActionDsl {
  return ActionDslSchema.parse(raw);
}
