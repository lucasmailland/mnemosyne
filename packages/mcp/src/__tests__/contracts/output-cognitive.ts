import { MnemosyneAPIError } from "@mnemo-ai/client-ts";

import { FIXTURE_IDS, T0, T1, localError, ok, rejects, resolves } from "./output-fixtures.js";
import type { OutputScenario } from "./output-types.js";
import { formatMcpError } from "../../tools/errors.js";

const expectedHttpError = (tool: string, status: number, code: string, message: string) =>
  formatMcpError(tool, new MnemosyneAPIError({ status, code, message }));

const IDS = {
  strategy: "00000000-0000-4000-8000-000000000021",
  replacementFact: "00000000-0000-4000-8000-000000000022",
  reflectionEpisode: "00000000-0000-4000-8000-000000000023",
  hyperedge: "00000000-0000-4000-8000-000000000024",
  memberA: "00000000-0000-4000-8000-000000000025",
  memberB: "00000000-0000-4000-8000-000000000026",
  rule: "00000000-0000-4000-8000-000000000027",
} as const;

const IDEMPOTENCY_KEY = "cognitive-contract-idempotency-key";
const EDIT_REASON = "Keep the cognitive contract fixture deterministic.";
const STRATEGY_TARGET = `strategy:${IDS.strategy}`;

const applied = (
  action: "append" | "strengthen" | "weaken" | "forget" | "link",
  target: string,
  targetKind: "fact" | "strategy" | "profile"
) => ({
  applied: true,
  action,
  target,
  targetKind,
  countsAsEdit: true,
  countsAsDelete: action === "forget",
});

const approvalRequired = (
  action: "forget" | "replace",
  target: string,
  targetKind: "fact" | "strategy" | "profile",
  scope: "delete_fact" | "edit_entity"
) => ({
  applied: false,
  action,
  target,
  targetKind,
  approvalRequired: true,
  scope,
  reason: `Action '${action}' maps to approval-gated scope '${scope}'.`,
});

const FACT_REPLACEMENT = {
  applied: true,
  action: "replace",
  target: FIXTURE_IDS.fact,
  targetKind: "fact",
  replacementId: IDS.replacementFact,
  countsAsEdit: true,
  countsAsDelete: false,
} as const;

const REFLECTION = {
  applied: true,
  action: "reflect",
  episode_id: IDS.reflectionEpisode,
  strengthened: [FIXTURE_IDS.fact],
  weakened: [IDS.strategy],
} as const;

const HYPEREDGE = {
  id: IDS.hyperedge,
  workspaceId: FIXTURE_IDS.workspace,
  memberIds: [FIXTURE_IDS.fact, IDS.memberA, IDS.memberB],
  label: "contract-cluster",
  description: "Memories used by the cognitive contract harness.",
  contextQuery: "cognitive output contracts",
  activationCount: 0,
  worth: 0.5,
  validFrom: T0,
  validTo: null,
  createdAt: T0,
} as const;

const SELF_MODEL = {
  workspaceId: FIXTURE_IDS.workspace,
  generatedAt: T1,
  confidenceMap: [
    {
      entity: "MCP contracts",
      coverage: "expert",
      freshness: "current",
      factCount: 8,
      avgWorth: 0.82,
    },
  ],
  strongTopics: [{ topicKey: "MCP contracts", memoryCount: 8, avgWorth: 0.82, evidenceVolume: 13 }],
  strengths: [{ topic: "MCP contracts", avgWorth: 0.82, factCount: 8 }],
  gaps: [],
  trends: {
    recallHitRate: { current: 0.8, previous: 0.7, delta: 0.1 },
    avgRecallLatency: { current: 12, previous: 15, delta: -3 },
    sessionCollapseQuality: { current: 0.9, previous: 0.85, delta: 0.05 },
    strategySuccessRate: { current: 0.75, previous: 0.7, delta: 0.05 },
  },
  summary: {
    totalTopics: 1,
    strongTopicsCount: 1,
    gapsCount: 0,
    blindCount: 0,
    avgWorthAcrossWorkspace: 0.82,
  },
} as const;

const ANTICIPATION_FEED = {
  workspaceId: FIXTURE_IDS.workspace,
  generatedAt: T1,
  cue: { recentlyRecalledId: FIXTURE_IDS.fact },
  items: [
    {
      id: IDS.strategy,
      score: 0.28,
      source: "sequential",
      rationale: `Follows ${FIXTURE_IDS.fact} 80% of the time (avg lag 30s).`,
    },
  ],
} as const;

const CONDITION_DSL = {
  all: [{ op: "text_contains", needle: "contract", bind: "$fact" }],
} as const;
const ACTION_DSL = {
  op: "derive_fact",
  statementTemplate: "A cognitive contract was verified.",
  kind: "inferred",
  baseConfidence: 0.8,
  sensitivity: "internal",
} as const;
const HIT = {
  id: FIXTURE_IDS.fact,
  primitive: "fact",
  content: "The cognitive contract uses exact deterministic fixtures.",
  score: 0.9,
  factKind: "preference",
  worth: 0.8,
  tags: ["contracts/mcp"],
} as const;

const COMPOSITION_RULE = {
  id: IDS.rule,
  workspaceId: FIXTURE_IDS.workspace,
  name: "Cognitive contract rule",
  description: "Derive a verification fact from matching contract memories.",
  conditionDsl: CONDITION_DSL,
  actionDsl: ACTION_DSL,
  priority: 25,
  isActive: true,
  executionCount: 4,
  source: "manual",
  createdBy: "contract-agent",
  metadata: { suite: "output-cognitive" },
  createdAt: T0,
  updatedAt: T1,
} as const;

const NEW_COMPOSITION_RULE = {
  id: IDS.rule,
  workspaceId: FIXTURE_IDS.workspace,
  name: COMPOSITION_RULE.name,
  description: COMPOSITION_RULE.description,
  conditionDsl: CONDITION_DSL,
  actionDsl: ACTION_DSL,
  priority: 25,
  isActive: true,
  executionCount: 0,
  source: "manual",
  metadata: {},
  createdAt: T0,
  updatedAt: T0,
} as const;

const COMPOSITION_PAGE = {
  items: [{ ...COMPOSITION_RULE, isActive: false }],
  total: 6,
  offset: 5,
  limit: 10,
  hasMore: false,
} as const;

const DRY_RUN = {
  inferences: [
    {
      ruleId: IDS.rule,
      ruleName: COMPOSITION_RULE.name,
      inputFactIds: [FIXTURE_IDS.fact],
      derivedKind: "inferred",
      derivedStatement: "A cognitive contract was verified.",
      confidence: 0.64,
      type: "fact",
      rationale: `Rule "${COMPOSITION_RULE.name}" matched 1 premise(s); confidence = 0.640.`,
    },
  ],
  ruleId: IDS.rule,
  ruleName: COMPOSITION_RULE.name,
} as const;

const INLINE_DRY_RUN = {
  ...DRY_RUN,
  inferences: DRY_RUN.inferences.map((inference) => ({
    ...inference,
    ruleId: "dry-run-inline",
    ruleName: "Inline cognitive rule",
  })),
  ruleId: "dry-run-inline",
  ruleName: "Inline cognitive rule",
} as const;

export const COGNITIVE_OUTPUT_SCENARIOS: readonly OutputScenario[] = [
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_self_edit",
    variant: "append",
    args: {
      action: "append",
      target: FIXTURE_IDS.fact,
      content: "Append exact output evidence.",
      reason: EDIT_REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: { selfEdit: [resolves(applied("append", FIXTURE_IDS.fact, "fact"))] },
    expectedClientCalls: [
      {
        path: "selfEdit",
        args: [
          {
            action: "append",
            target: FIXTURE_IDS.fact,
            content: "Append exact output evidence.",
            reason: EDIT_REASON,
          },
          undefined,
          IDEMPOTENCY_KEY,
        ],
      },
    ],
    expected: ok(applied("append", FIXTURE_IDS.fact, "fact")),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_self_edit",
    variant: "replace",
    args: {
      action: "replace",
      target: FIXTURE_IDS.fact,
      content: "Replacement contract statement.",
      reason: EDIT_REASON,
    },
    stubs: { selfEdit: [resolves(FACT_REPLACEMENT)] },
    expectedClientCalls: [
      {
        path: "selfEdit",
        args: [
          {
            action: "replace",
            target: FIXTURE_IDS.fact,
            content: "Replacement contract statement.",
            reason: EDIT_REASON,
          },
          undefined,
          undefined,
        ],
      },
    ],
    expected: ok(FACT_REPLACEMENT),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_self_edit",
    variant: "strengthen",
    args: { action: "strengthen", target: FIXTURE_IDS.fact, reason: EDIT_REASON },
    stubs: { selfEdit: [resolves(applied("strengthen", FIXTURE_IDS.fact, "fact"))] },
    expectedClientCalls: [
      {
        path: "selfEdit",
        args: [
          { action: "strengthen", target: FIXTURE_IDS.fact, reason: EDIT_REASON },
          undefined,
          undefined,
        ],
      },
    ],
    expected: ok(applied("strengthen", FIXTURE_IDS.fact, "fact")),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_self_edit",
    variant: "weaken",
    args: { action: "weaken", target: STRATEGY_TARGET, reason: EDIT_REASON },
    stubs: { selfEdit: [resolves(applied("weaken", STRATEGY_TARGET, "strategy"))] },
    expectedClientCalls: [
      {
        path: "selfEdit",
        args: [
          { action: "weaken", target: STRATEGY_TARGET, reason: EDIT_REASON },
          undefined,
          undefined,
        ],
      },
    ],
    expected: ok(applied("weaken", STRATEGY_TARGET, "strategy")),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_self_edit",
    variant: "forget",
    args: { action: "forget", target: FIXTURE_IDS.fact, reason: EDIT_REASON },
    stubs: {
      selfEdit: [resolves(approvalRequired("forget", FIXTURE_IDS.fact, "fact", "delete_fact"))],
    },
    expectedClientCalls: [
      {
        path: "selfEdit",
        args: [
          { action: "forget", target: FIXTURE_IDS.fact, reason: EDIT_REASON },
          undefined,
          undefined,
        ],
      },
    ],
    expected: ok(approvalRequired("forget", FIXTURE_IDS.fact, "fact", "delete_fact")),
  },
  {
    kind: "baseline",
    classification: "known_defect",
    owners: ["B6.20"],
    tool: "memory_self_edit",
    variant: "reflect",
    args: { action: "reflect", target: "profile", reason: EDIT_REASON },
    stubs: { selfEdit: [resolves(REFLECTION)] },
    expectedClientCalls: [
      {
        path: "selfEdit",
        args: [{ action: "reflect", target: "profile", reason: EDIT_REASON }, undefined, undefined],
      },
    ],
    expected: ok(REFLECTION),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_self_edit",
    variant: "link",
    args: {
      action: "link",
      target: FIXTURE_IDS.fact,
      content: `${IDS.memberA}, ${IDS.memberB}`,
      reason: EDIT_REASON,
    },
    stubs: { selfEdit: [resolves(applied("link", FIXTURE_IDS.fact, "fact"))] },
    expectedClientCalls: [
      {
        path: "selfEdit",
        args: [
          {
            action: "link",
            target: FIXTURE_IDS.fact,
            content: `${IDS.memberA}, ${IDS.memberB}`,
            reason: EDIT_REASON,
          },
          undefined,
          undefined,
        ],
      },
    ],
    expected: ok(applied("link", FIXTURE_IDS.fact, "fact")),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_hyperedge",
    variant: "create",
    args: {
      action: "create",
      memberIds: HYPEREDGE.memberIds,
      label: HYPEREDGE.label,
      description: HYPEREDGE.description,
      contextQuery: HYPEREDGE.contextQuery,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: { createHyperedge: [resolves(HYPEREDGE)] },
    expectedClientCalls: [
      {
        path: "createHyperedge",
        args: [
          {
            memberIds: HYPEREDGE.memberIds,
            label: HYPEREDGE.label,
            description: HYPEREDGE.description,
            contextQuery: HYPEREDGE.contextQuery,
          },
          undefined,
          IDEMPOTENCY_KEY,
        ],
      },
    ],
    expected: ok(HYPEREDGE),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_hyperedge",
    variant: "get",
    args: { action: "get", id: IDS.hyperedge },
    stubs: { getHyperedge: [resolves(HYPEREDGE)] },
    expectedClientCalls: [{ path: "getHyperedge", args: [IDS.hyperedge] }],
    expected: ok(HYPEREDGE),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_hyperedge",
    variant: "list",
    args: {
      action: "list",
      memberIdFilter: FIXTURE_IDS.fact,
      labelFilter: "contract-cluster",
      limit: 20,
    },
    stubs: {
      listHyperedges: [
        resolves({ items: [HYPEREDGE], total: 1, offset: 0, limit: 20, hasMore: false }),
      ],
    },
    expectedClientCalls: [
      {
        path: "listHyperedges",
        args: [{ memberId: FIXTURE_IDS.fact, label: "contract-cluster", limit: 20 }],
      },
    ],
    expected: ok({ items: [HYPEREDGE], total: 1, offset: 0, limit: 20, hasMore: false }),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_hyperedge",
    variant: "patch",
    args: {
      action: "patch",
      id: IDS.hyperedge,
      label: "verified-cluster",
      description: "Updated cognitive contract cluster.",
      contextQuery: "verified cognitive contracts",
    },
    stubs: {
      patchHyperedge: [
        resolves({
          ...HYPEREDGE,
          label: "verified-cluster",
          description: "Updated cognitive contract cluster.",
          contextQuery: "verified cognitive contracts",
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "patchHyperedge",
        args: [
          IDS.hyperedge,
          {
            label: "verified-cluster",
            description: "Updated cognitive contract cluster.",
            contextQuery: "verified cognitive contracts",
          },
        ],
      },
    ],
    expected: ok({
      ...HYPEREDGE,
      label: "verified-cluster",
      description: "Updated cognitive contract cluster.",
      contextQuery: "verified cognitive contracts",
    }),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_hyperedge",
    variant: "archive",
    args: { action: "archive", id: IDS.hyperedge },
    stubs: { archiveHyperedge: [resolves(undefined)] },
    expectedClientCalls: [{ path: "archiveHyperedge", args: [IDS.hyperedge] }],
    expected: ok({ id: IDS.hyperedge, archived: true }),
  },
  {
    kind: "baseline",
    classification: "known_defect",
    owners: ["B6.23"],
    tool: "memory_introspect",
    variant: "introspect",
    args: { aspect: "health", entity: "MCP", limit: 7 },
    stubs: { getSelfModel: [resolves(SELF_MODEL)] },
    expectedClientCalls: [
      { path: "getSelfModel", args: [{ aspect: "all", entity: "MCP", limit: 7 }] },
    ],
    expected: ok(SELF_MODEL),
  },
  {
    kind: "baseline",
    classification: "known_defect",
    owners: ["B6.23"],
    tool: "memory_anticipate",
    variant: "anticipate",
    args: {
      recentlyRecalledId: FIXTURE_IDS.fact,
      context: "cognitive output contracts",
      lookAhead: 45,
      limit: 6,
    },
    stubs: { getAnticipationFeed: [resolves(ANTICIPATION_FEED)] },
    expectedClientCalls: [
      {
        path: "getAnticipationFeed",
        args: [
          {
            recentlyRecalledId: FIXTURE_IDS.fact,
            context: "cognitive output contracts",
            lookAhead: 45,
            limit: 6,
          },
        ],
      },
    ],
    expected: ok(ANTICIPATION_FEED),
  },
  {
    kind: "baseline",
    classification: "known_defect",
    owners: ["B6.23"],
    tool: "memory_compose",
    variant: "list",
    args: { action: "list", isActive: false, offset: 5, limit: 10 },
    stubs: { "composition.listRules": [resolves(COMPOSITION_PAGE)] },
    expectedClientCalls: [
      { path: "composition.listRules", args: [{ isActive: false, offset: 5, limit: 10 }] },
    ],
    expected: ok(COMPOSITION_PAGE),
  },
  {
    kind: "baseline",
    classification: "known_defect",
    owners: ["B6.23"],
    tool: "memory_compose",
    variant: "create",
    args: {
      action: "create",
      name: COMPOSITION_RULE.name,
      description: COMPOSITION_RULE.description,
      conditionDsl: CONDITION_DSL,
      actionDsl: ACTION_DSL,
      priority: 25,
      isActiveOnCreate: false,
    },
    stubs: { "composition.createRule": [resolves({ ...NEW_COMPOSITION_RULE, isActive: false })] },
    expectedClientCalls: [
      {
        path: "composition.createRule",
        args: [
          {
            name: COMPOSITION_RULE.name,
            conditionDsl: CONDITION_DSL,
            actionDsl: ACTION_DSL,
            description: COMPOSITION_RULE.description,
            priority: 25,
            isActive: false,
          },
        ],
      },
    ],
    expected: ok({ ...NEW_COMPOSITION_RULE, isActive: false }),
  },
  {
    kind: "baseline",
    classification: "known_defect",
    owners: ["B6.23"],
    tool: "memory_compose",
    variant: "get",
    args: { action: "get", ruleId: IDS.rule },
    stubs: { "composition.getRule": [resolves(COMPOSITION_RULE)] },
    expectedClientCalls: [{ path: "composition.getRule", args: [IDS.rule] }],
    expected: ok(COMPOSITION_RULE),
  },
  {
    kind: "baseline",
    classification: "known_defect",
    owners: ["B6.23"],
    tool: "memory_compose",
    variant: "patch",
    args: {
      action: "patch",
      ruleId: IDS.rule,
      name: "Updated cognitive contract rule",
      priority: 30,
      isActive: false,
    },
    stubs: {
      "composition.patchRule": [
        resolves({
          ...COMPOSITION_RULE,
          name: "Updated cognitive contract rule",
          priority: 30,
          isActive: false,
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "composition.patchRule",
        args: [
          IDS.rule,
          { name: "Updated cognitive contract rule", priority: 30, isActive: false },
        ],
      },
    ],
    expected: ok({
      ...COMPOSITION_RULE,
      name: "Updated cognitive contract rule",
      priority: 30,
      isActive: false,
    }),
  },
  {
    kind: "baseline",
    classification: "known_defect",
    owners: ["B6.17", "B6.23"],
    tool: "memory_compose",
    variant: "dry_run",
    args: {
      action: "dry_run",
      ruleId: IDS.rule,
      name: "Ignored inline name",
      conditionDsl: { all: [] },
      actionDsl: { op: "emit_warning" },
      priority: 999,
      hits: [HIT],
      limit: 1,
    },
    stubs: { "composition.dryRun": [resolves(DRY_RUN)] },
    expectedClientCalls: [
      { path: "composition.dryRun", args: [{ hits: [HIT], ruleId: IDS.rule }] },
    ],
    expected: ok(DRY_RUN),
  },
  {
    kind: "additional",
    classification: "contract",
    tool: "memory_self_edit",
    variant: "forget",
    caseName: "returns the approval-required response member",
    args: { action: "forget", target: FIXTURE_IDS.fact, reason: EDIT_REASON },
    stubs: {
      selfEdit: [resolves(approvalRequired("forget", FIXTURE_IDS.fact, "fact", "delete_fact"))],
    },
    expectedClientCalls: [
      {
        path: "selfEdit",
        args: [
          { action: "forget", target: FIXTURE_IDS.fact, reason: EDIT_REASON },
          undefined,
          undefined,
        ],
      },
    ],
    expected: ok(approvalRequired("forget", FIXTURE_IDS.fact, "fact", "delete_fact")),
  },
  {
    kind: "additional",
    classification: "known_defect",
    owners: ["B6.24"],
    tool: "memory_self_edit",
    variant: "replace",
    caseName: "returns approval-required for a non-fact replacement",
    args: {
      action: "replace",
      target: STRATEGY_TARGET,
      content: "Use exact output envelopes.",
      reason: EDIT_REASON,
    },
    stubs: {
      selfEdit: [resolves(approvalRequired("replace", STRATEGY_TARGET, "strategy", "edit_entity"))],
    },
    expectedClientCalls: [
      {
        path: "selfEdit",
        args: [
          {
            action: "replace",
            target: STRATEGY_TARGET,
            content: "Use exact output envelopes.",
            reason: EDIT_REASON,
          },
          undefined,
          undefined,
        ],
      },
    ],
    expected: ok(approvalRequired("replace", STRATEGY_TARGET, "strategy", "edit_entity")),
  },
  {
    kind: "additional",
    classification: "known_defect",
    owners: ["B6.24"],
    tool: "memory_self_edit",
    variant: "append",
    caseName: "reports applied when missing content can produce no mutation",
    args: { action: "append", target: FIXTURE_IDS.fact, reason: EDIT_REASON },
    stubs: { selfEdit: [resolves(applied("append", FIXTURE_IDS.fact, "fact"))] },
    expectedClientCalls: [
      {
        path: "selfEdit",
        args: [
          { action: "append", target: FIXTURE_IDS.fact, reason: EDIT_REASON },
          undefined,
          undefined,
        ],
      },
    ],
    expected: ok(applied("append", FIXTURE_IDS.fact, "fact")),
  },
  {
    kind: "additional",
    classification: "known_defect",
    owners: ["B6.24"],
    tool: "memory_self_edit",
    variant: "forget",
    caseName: "approval-gates profile forget before the no-op branch",
    args: { action: "forget", target: "profile", reason: EDIT_REASON },
    stubs: {
      selfEdit: [resolves(approvalRequired("forget", "profile", "profile", "delete_fact"))],
    },
    expectedClientCalls: [
      {
        path: "selfEdit",
        args: [{ action: "forget", target: "profile", reason: EDIT_REASON }, undefined, undefined],
      },
    ],
    expected: ok(approvalRequired("forget", "profile", "profile", "delete_fact")),
  },
  {
    kind: "additional",
    classification: "contract",
    tool: "memory_hyperedge",
    variant: "create",
    caseName: "requires at least three member IDs without a client call",
    args: { action: "create" },
    stubs: {},
    expectedClientCalls: [],
    expected: localError("create requires `memberIds` with at least 3 entries."),
  },
  {
    kind: "additional",
    classification: "contract",
    tool: "memory_hyperedge",
    variant: "get",
    caseName: "requires id without a client call",
    args: { action: "get" },
    stubs: {},
    expectedClientCalls: [],
    expected: localError("get requires `id`."),
  },
  {
    kind: "additional",
    classification: "contract",
    tool: "memory_hyperedge",
    variant: "patch",
    caseName: "requires id without a client call",
    args: { action: "patch", label: "unused" },
    stubs: {},
    expectedClientCalls: [],
    expected: localError("patch requires `id`."),
  },
  {
    kind: "additional",
    classification: "contract",
    tool: "memory_hyperedge",
    variant: "archive",
    caseName: "requires id without a client call",
    args: { action: "archive" },
    stubs: {},
    expectedClientCalls: [],
    expected: localError("archive requires `id`."),
  },
  {
    kind: "additional",
    classification: "known_defect",
    owners: ["B6.24"],
    tool: "memory_hyperedge",
    variant: "patch",
    caseName: "flattens the downstream empty-patch error",
    args: { action: "patch", id: IDS.hyperedge },
    stubs: {
      patchHyperedge: [
        rejects(
          new MnemosyneAPIError({
            status: 500,
            code: "internal_error",
            message: "Internal server error",
          })
        ),
      ],
    },
    expectedClientCalls: [{ path: "patchHyperedge", args: [IDS.hyperedge, {}] }],
    expected: expectedHttpError("memory_hyperedge", 500, "internal_error", "Internal server error"),
  },
  {
    kind: "additional",
    classification: "known_defect",
    owners: ["B6.17", "B6.23"],
    tool: "memory_compose",
    variant: "dry_run",
    caseName: "delegates an inline rule with the runtime dry-run response",
    args: {
      action: "dry_run",
      name: "Inline cognitive rule",
      conditionDsl: CONDITION_DSL,
      actionDsl: ACTION_DSL,
      priority: 40,
      hits: [HIT],
    },
    stubs: { "composition.dryRun": [resolves(INLINE_DRY_RUN)] },
    expectedClientCalls: [
      {
        path: "composition.dryRun",
        args: [
          {
            hits: [HIT],
            rule: {
              name: "Inline cognitive rule",
              conditionDsl: CONDITION_DSL,
              actionDsl: ACTION_DSL,
              priority: 40,
            },
          },
        ],
      },
    ],
    expected: ok(INLINE_DRY_RUN),
  },
  {
    kind: "additional",
    classification: "known_defect",
    owners: ["B6.17", "B6.24"],
    tool: "memory_compose",
    variant: "dry_run",
    caseName: "forwards an incomplete inline rule and flattens downstream rejection",
    args: { action: "dry_run", conditionDsl: CONDITION_DSL, hits: [HIT] },
    stubs: {
      "composition.dryRun": [
        rejects(
          new MnemosyneAPIError({
            status: 400,
            code: "validation_error",
            message:
              "Invalid actionDsl: <root>: Invalid input: expected object, received undefined",
          })
        ),
      ],
    },
    expectedClientCalls: [
      {
        path: "composition.dryRun",
        args: [
          {
            hits: [HIT],
            rule: {
              name: "inline-dry-run",
              conditionDsl: CONDITION_DSL,
              actionDsl: undefined,
            },
          },
        ],
      },
    ],
    expected: expectedHttpError(
      "memory_compose",
      400,
      "validation_error",
      "Invalid actionDsl: <root>: Invalid input: expected object, received undefined"
    ),
  },
  {
    kind: "additional",
    classification: "known_defect",
    owners: ["B6.24"],
    tool: "memory_compose",
    variant: "patch",
    caseName: "accepts a downstream timestamp-only empty patch",
    args: { action: "patch", ruleId: IDS.rule },
    stubs: { "composition.patchRule": [resolves(COMPOSITION_RULE)] },
    expectedClientCalls: [{ path: "composition.patchRule", args: [IDS.rule, {}] }],
    expected: ok(COMPOSITION_RULE),
  },
  {
    kind: "additional",
    classification: "known_defect",
    owners: ["B6.24"],
    tool: "memory_compose",
    variant: "patch",
    caseName: "silently drops explicit-null DSL fields into an empty patch",
    args: { action: "patch", ruleId: IDS.rule, conditionDsl: null, actionDsl: null },
    stubs: { "composition.patchRule": [resolves(COMPOSITION_RULE)] },
    expectedClientCalls: [{ path: "composition.patchRule", args: [IDS.rule, {}] }],
    expected: ok(COMPOSITION_RULE),
  },
  {
    kind: "additional",
    classification: "contract",
    tool: "memory_compose",
    variant: "get",
    caseName: "requires ruleId without a client call",
    args: { action: "get" },
    stubs: {},
    expectedClientCalls: [],
    expected: localError("memory_compose failed: ruleId is required for action='get'"),
  },
  {
    kind: "additional",
    classification: "contract",
    tool: "memory_compose",
    variant: "patch",
    caseName: "requires ruleId without a client call",
    args: { action: "patch", isActive: false },
    stubs: {},
    expectedClientCalls: [],
    expected: localError("memory_compose failed: ruleId is required for action='patch'"),
  },
  {
    kind: "additional",
    classification: "contract",
    tool: "memory_compose",
    variant: "dry_run",
    caseName: "requires a stored or inline rule without a client call",
    args: { action: "dry_run", hits: [HIT] },
    stubs: {},
    expectedClientCalls: [],
    expected: localError(
      "memory_compose failed: Provide ruleId or conditionDsl+actionDsl for action='dry_run'"
    ),
  },
  {
    kind: "additional",
    classification: "contract",
    tool: "memory_compose",
    variant: "create",
    caseName: "requires name without a client call",
    args: { action: "create", conditionDsl: CONDITION_DSL, actionDsl: ACTION_DSL },
    stubs: {},
    expectedClientCalls: [],
    expected: localError("memory_compose failed: name is required for action='create'"),
  },
  {
    kind: "additional",
    classification: "known_defect",
    owners: ["B6.24"],
    tool: "memory_compose",
    variant: "patch",
    caseName: "flattens a missing downstream target into a generic error",
    args: { action: "patch", ruleId: IDS.rule, isActive: false },
    stubs: {
      "composition.patchRule": [
        rejects(
          new MnemosyneAPIError({
            status: 500,
            code: "internal_error",
            message: "Internal server error",
          })
        ),
      ],
    },
    expectedClientCalls: [{ path: "composition.patchRule", args: [IDS.rule, { isActive: false }] }],
    expected: expectedHttpError("memory_compose", 500, "internal_error", "Internal server error"),
  },
];
