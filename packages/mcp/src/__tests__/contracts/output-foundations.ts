import { MnemosyneAPIError } from "@mnemo-ai/client-ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  FIXTURE_ENTITY,
  FIXTURE_FACT,
  FIXTURE_IDS,
  T0,
  T1,
  localError,
  ok,
  rejects,
  resolves,
} from "./output-fixtures.js";
import type { OpenB6Owner, OutputScenario } from "./output-types.js";
import { renderMemoryHits, renderMemoryItem } from "../../tools/render-memory.js";

const IDS = {
  decision: "00000000-0000-4000-8000-000000000006",
  episode: "00000000-0000-4000-8000-000000000007",
  strategy: "00000000-0000-4000-8000-000000000008",
  workflow: "00000000-0000-4000-8000-000000000009",
  skill: "00000000-0000-4000-8000-000000000010",
  task: "00000000-0000-4000-8000-000000000011",
  event: "00000000-0000-4000-8000-000000000012",
  reasoning: "00000000-0000-4000-8000-000000000013",
  hyperedge: "00000000-0000-4000-8000-000000000014",
  reminder: "00000000-0000-4000-8000-000000000015",
} as const;

const FIXTURE_USER_ID = "00000000-0000-4000-8000-000000000016";

const IDEMPOTENCY_KEY = "contract-idempotency-key";
const FORGET_REASON = "No longer applicable";

function textOnly(text: string, isError?: boolean): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError === undefined ? {} : { isError }),
  };
}

const NON_FACT_KINDS = [
  ["decision", IDS.decision],
  ["episode", IDS.episode],
  ["entity", FIXTURE_IDS.entity],
  ["strategy", IDS.strategy],
  ["workflow", IDS.workflow],
  ["skill", IDS.skill],
  ["task", IDS.task],
  ["event", IDS.event],
  ["reasoning", IDS.reasoning],
  ["hyperedge", IDS.hyperedge],
] as const;

const NON_FACT_FORGET_SCENARIOS = NON_FACT_KINDS.map(([kind, id]): OutputScenario => {
  const owners: readonly [OpenB6Owner, ...OpenB6Owner[]] =
    kind === "event" ? ["B6.13", "B6.14", "B6.24"] : ["B6.14", "B6.24"];
  const result = { id, kind, forgotten: true, reason: FORGET_REASON };

  return {
    kind: "baseline",
    tool: "memory_forget",
    variant: kind,
    args: {
      primitiveId: id,
      kind,
      reason: FORGET_REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: { forgetPrimitive: [resolves(false)] },
    expectedClientCalls: [
      { path: "forgetPrimitive", args: [kind, id, undefined, FORGET_REASON, IDEMPOTENCY_KEY] },
    ],
    expected: ok(result),
    classification: "contract",
  };
});

const HEALTH = {
  workspaceId: FIXTURE_IDS.workspace,
  factsLive: 10,
  factsClosed: 2,
  pinnedCount: 3,
  lastRecallAt: T0,
  lastWriteAt: T1,
  embeddings: { indexed: 9, pending: 1 },
} as const;
const SCOPE_BREAKDOWN = [
  { scopeRef: "mnemosyne", count: 7 },
  { scopeRef: "contracts", count: 3 },
] as const;
const STATS = { facts: { byScopeRef: SCOPE_BREAKDOWN } } as const;
const ME = {
  userId: "contract-user",
  personalWorkspaceId: FIXTURE_IDS.workspace,
  personalFactsLive: 4,
} as const;
const READINESS = {
  status: "ready",
  degraded: false,
  checks: { postgres: "ok", vector: "ok", cache: "ok" },
} as const;

function statusResult(
  scopeBreakdown: readonly { scopeRef: string; count: number }[],
  personal?: { workspaceId: string; factsLive: number }
): CallToolResult {
  const scopeText =
    scopeBreakdown.length > 0
      ? `\n\nFacts by project (scopeRef):\n${scopeBreakdown
          .map(({ scopeRef, count }) => `  ${scopeRef}: ${count}`)
          .join("\n")}`
      : "";
  const personalText = personal
    ? `\n\nPersonal workspace: ${personal.workspaceId} (${personal.factsLive} facts)`
    : "";
  const readinessText = `\n\nDependency health (instance-wide, not workspace-scoped): ${READINESS.status}\n${Object.entries(
    READINESS.checks
  )
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n")}`;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(HEALTH) + scopeText + personalText + readinessText,
      },
    ],
    structuredContent: {
      ...HEALTH,
      factsByScopeRef: [...scopeBreakdown],
      ...(personal ? { personal } : {}),
      dependencyHealth: READINESS,
    },
  };
}

const STATUS_CALLS = [
  { path: "health", args: [] },
  { path: "getStats", args: [] },
  { path: "getMe", args: [] },
  { path: "healthReady", args: [] },
] as const;

const CONSOLIDATION_RESULT = {
  accepted: true,
  workspaceId: FIXTURE_IDS.workspace,
  mode: "fast",
  dryRun: false,
  candidatesProcessed: 4,
  mergedPairs: 1,
  skippedPairs: 2,
  errors: 1,
  tookMs: 17,
} as const;
const CONSOLIDATION_TEXT = [
  "Consolidation pass complete.",
  "  mode:       fast",
  "  candidates: 4",
  "  merged:     1 pair(s)",
  "  skipped:    2 pair(s)",
  "  errors:     1",
  "  took:       17 ms",
].join("\n");

function consolidationError(code: string, message: string): MnemosyneAPIError {
  return new MnemosyneAPIError({ status: 422, code, message });
}

function consolidationErrorResult(code: string, message: string): CallToolResult {
  return textOnly(`memory_consolidate failed: HTTP 422 (${code}): ${message}`, true);
}

export const FOUNDATION_OUTPUT_SCENARIOS = [
  {
    kind: "baseline",
    tool: "memory_recall",
    variant: "recall",
    args: {
      query: "deterministic fixtures",
      limit: 2,
      asOf: T0,
      scope: "personal",
      scopeRef: "mnemosyne",
      actorId: "contract-user",
      // Fixed so the reported id is deterministic (otherwise generated per call).
      requestId: "contract-recall",
    },
    stubs: {
      recall: [
        resolves({
          hits: [
            {
              id: FIXTURE_IDS.fact,
              content: FIXTURE_FACT.statement,
              score: 0.91,
              validFrom: T0,
              validTo: null,
              actorId: "contract-user",
            },
          ],
          debug: { embedded: true, latencyMs: 8 },
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "recall",
        args: [
          {
            // P67: the MCP surface defaults to compact — this is where an LLM
            // pays per token. HTTP keeps `full`.
            projection: "compact",
            query: "deterministic fixtures",
            topK: 2,
            asOf: T0,
            scope: "personal",
            scopeRef: "mnemosyne",
            actorId: "contract-user",
          },
        ],
      },
    ],
    expected: {
      ...ok({
        // APP-020: the compact fields the text shows, not the wire hit again.
        memories: [
          {
            id: FIXTURE_IDS.fact,
            content: FIXTURE_FACT.statement,
            score: 0.91,
            validFrom: T0,
          },
        ],
        debug: { embedded: true, latencyMs: 8 },
        requestId: "contract-recall",
        _mnemo_label: "untrusted_external_content",
        _mnemo_version: "3.0",
      }),
      content: [
        {
          type: "text",
          text: renderMemoryHits(
            [
              {
                id: FIXTURE_IDS.fact,
                content: FIXTURE_FACT.statement,
                score: 0.91,
                validFrom: T0,
                validTo: null,
                actorId: "contract-user",
              },
            ],
            { compact: true }
          ),
        },
      ],
    },
    classification: "known_defect",
    owners: ["B6.4", "B6.5"],
  },
  {
    kind: "baseline",
    tool: "memory_remember",
    variant: "remember",
    args: {
      statement: FIXTURE_FACT.statement,
      subject: "contract-harness",
      kind: "preference",
      confidence: 0.9,
      agentId: "contract-agent",
      conversationId: "conversation-dropped-by-handler",
      idempotencyKey: IDEMPOTENCY_KEY,
      scope: "global",
      scopeRef: "mnemosyne",
      scopeOwner: `workspace:${FIXTURE_IDS.workspace}`,
      targetWorkspaceId: FIXTURE_IDS.workspace,
    },
    stubs: {
      remember: [
        resolves({
          id: FIXTURE_IDS.fact,
          workspaceId: FIXTURE_IDS.workspace,
          statement: FIXTURE_FACT.statement,
          status: "active",
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "remember",
        args: [
          {
            statement: FIXTURE_FACT.statement,
            subject: "contract-harness",
            kind: "preference",
            confidence: 0.9,
            agentId: "contract-agent",
            conversationId: "conversation-dropped-by-handler",
            tags: ["preference"],
            scope: "global",
            scopeRef: "mnemosyne",
            scopeOwner: `workspace:${FIXTURE_IDS.workspace}`,
            targetWorkspaceId: FIXTURE_IDS.workspace,
          },
          undefined,
          IDEMPOTENCY_KEY,
        ],
      },
    ],
    expected: ok({
      id: FIXTURE_IDS.fact,
      workspaceId: FIXTURE_IDS.workspace,
      statement: FIXTURE_FACT.statement,
      status: "active",
    }),
    classification: "known_defect",
    owners: ["B6.3"],
  },
  {
    kind: "baseline",
    // P67 — the escalation half of compact recall. A tool with no baseline
    // output scenario is a tool whose response shape nobody pinned.
    tool: "memory_fact",
    variant: "by id",
    args: { factId: FIXTURE_IDS.fact },
    stubs: { getFact: [resolves(FIXTURE_FACT)] },
    // APP-019a: closed facts open too; the text says when one is closed.
    expectedClientCalls: [
      { path: "getFact", args: [FIXTURE_IDS.fact, undefined, { includeClosed: true }] },
    ],
    expected: {
      ...ok(FIXTURE_FACT),
      content: [{ type: "text", text: renderMemoryItem(FIXTURE_FACT) }],
    },
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_pin",
    variant: "pin",
    args: { factId: FIXTURE_IDS.fact, idempotencyKey: IDEMPOTENCY_KEY },
    stubs: { pinFact: [resolves({ ...FIXTURE_FACT, pinned: true })] },
    expectedClientCalls: [
      {
        path: "pinFact",
        args: [FIXTURE_IDS.fact, undefined, IDEMPOTENCY_KEY],
      },
    ],
    expected: ok({ ...FIXTURE_FACT, pinned: true }),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_pin",
    variant: "unpin",
    args: {
      factId: FIXTURE_IDS.fact,
      unpin: true,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: { unpinFact: [resolves({ ...FIXTURE_FACT, pinned: false })] },
    expectedClientCalls: [
      {
        path: "unpinFact",
        args: [FIXTURE_IDS.fact, undefined, IDEMPOTENCY_KEY],
      },
    ],
    expected: ok({ ...FIXTURE_FACT, pinned: false }),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_forget",
    variant: "fact",
    args: { factId: FIXTURE_IDS.fact, idempotencyKey: IDEMPOTENCY_KEY },
    stubs: { forgetFact: [resolves(undefined)] },
    expectedClientCalls: [
      {
        path: "forgetFact",
        args: [FIXTURE_IDS.fact, undefined, IDEMPOTENCY_KEY],
      },
    ],
    expected: ok({
      id: FIXTURE_IDS.fact,
      kind: "fact",
      forgotten: true,
      reason: "mcp_forget",
    }),
    classification: "contract",
  },
  ...NON_FACT_FORGET_SCENARIOS,
  {
    // P72 — the one-step remediation for a fact written into the wrong
    // workspace. The id CHANGES: this is a close-plus-successor, not an
    // in-place `workspace_id` update, so both ids must reach the caller or
    // there is no way to follow the fact to where it went.
    kind: "baseline",
    tool: "memory_relocate",
    variant: "relocate",
    args: { factId: FIXTURE_IDS.fact, targetWorkspaceId: FIXTURE_IDS.workspace },
    stubs: {
      relocateFact: [resolves({ previousId: FIXTURE_IDS.fact, newId: "mfact_relocated" })],
    },
    expectedClientCalls: [
      {
        path: "relocateFact",
        args: [FIXTURE_IDS.fact, FIXTURE_IDS.workspace, undefined],
      },
    ],
    // The text is prose, not the JSON blob, on purpose: the id CHANGED, and
    // an agent reading past this line needs to know which id to use next.
    expected: {
      content: [
        {
          type: "text",
          text: `Fact relocated to workspace ${FIXTURE_IDS.workspace}. previousId: ${FIXTURE_IDS.fact} → newId: mfact_relocated. The original is closed in the source workspace and linked to the successor by \`supersedes\`.`,
        },
      ],
      structuredContent: { previousId: FIXTURE_IDS.fact, newId: "mfact_relocated" },
    },
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_timeline",
    variant: "timeline",
    args: { limit: 3, sinceIso: T0 },
    stubs: {
      timeline: [
        resolves({
          events: [
            {
              id: IDS.event,
              at: T1,
              kind: "updated",
              factId: FIXTURE_IDS.fact,
              actor: "contract-agent",
              summary: "Fixture updated",
            },
          ],
          nextCursor: null,
        }),
      ],
    },
    expectedClientCalls: [{ path: "timeline", args: [{ limit: 3, since: T0 }] }],
    expected: ok({
      events: [
        {
          id: IDS.event,
          at: T1,
          kind: "updated",
          factId: FIXTURE_IDS.fact,
          actor: "contract-agent",
          summary: "Fixture updated",
        },
      ],
      nextCursor: null,
    }),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_search",
    variant: "search",
    args: {
      query: "contract fixtures",
      limit: 2,
      scope: "global",
      scopeRef: "mnemosyne",
      actorId: "contract-user",
    },
    stubs: {
      recall: [
        resolves({
          hits: [
            {
              id: FIXTURE_IDS.fact,
              content: FIXTURE_FACT.statement,
              score: 0.88,
              validFrom: T0,
              validTo: null,
              actorId: "contract-user",
            },
          ],
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "recall",
        args: [
          {
            query: "contract fixtures",
            topK: 2,
            // APP-020: same compact budget as memory_recall.
            projection: "compact",
            // MCP-1 fix (2026-07-29): memory_search no longer forces
            // mode/vectorWeight — see search.ts's fix note.
            scope: "global",
            scopeRef: "mnemosyne",
            actorId: "contract-user",
          },
        ],
      },
    ],
    expected: {
      content: [
        {
          type: "text",
          text: renderMemoryHits(
            [
              {
                id: FIXTURE_IDS.fact,
                content: FIXTURE_FACT.statement,
                score: 0.88,
                validFrom: T0,
                validTo: null,
                actorId: "contract-user",
              },
            ],
            { compact: true, heading: "Found 1 semantic memories." }
          ),
        },
      ],
      structuredContent: {
        memories: [
          {
            id: FIXTURE_IDS.fact,
            content: FIXTURE_FACT.statement,
            score: 0.88,
            validFrom: T0,
          },
        ],
        _mnemo_label: "untrusted_external_content",
        _mnemo_version: "3.0",
      },
    },
    classification: "known_defect",
    owners: ["B6.5"],
  },
  {
    kind: "baseline",
    tool: "memory_relate",
    variant: "create",
    args: {
      sourceKind: "fact",
      from: FIXTURE_IDS.fact,
      targetKind: "entity",
      to: FIXTURE_IDS.entity,
      verb: "related",
      reason: "Fixture relationship",
      confidence: 0.8,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: {
      createRelation: [
        resolves({
          id: FIXTURE_IDS.relation,
          sourceKind: "fact",
          sourceId: FIXTURE_IDS.fact,
          targetKind: "entity",
          targetId: FIXTURE_IDS.entity,
          relation: "related",
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "createRelation",
        args: [
          {
            sourceKind: "fact",
            sourceId: FIXTURE_IDS.fact,
            targetKind: "entity",
            targetId: FIXTURE_IDS.entity,
            relation: "related",
            markedByKind: "agent",
            reason: "Fixture relationship",
            confidence: 0.8,
          },
          undefined,
          IDEMPOTENCY_KEY,
        ],
      },
    ],
    expected: ok({
      id: FIXTURE_IDS.relation,
      sourceKind: "fact",
      sourceId: FIXTURE_IDS.fact,
      targetKind: "entity",
      targetId: FIXTURE_IDS.entity,
      relation: "related",
    }),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_relate",
    variant: "history",
    args: {
      action: "history",
      sourceKind: "fact",
      from: FIXTURE_IDS.fact,
    },
    stubs: {
      relationsTraverse: [
        resolves({
          nodes: [
            { id: FIXTURE_IDS.fact, kind: "fact" },
            { id: IDS.decision, kind: "decision" },
          ],
          edges: [
            {
              id: FIXTURE_IDS.relation,
              sourceKind: "fact",
              sourceId: FIXTURE_IDS.fact,
              targetKind: "decision",
              targetId: IDS.decision,
              relation: "supersedes",
            },
          ],
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "relationsTraverse",
        args: [
          {
            rootId: FIXTURE_IDS.fact,
            rootKind: "fact",
            maxDepth: 5,
            verbs: ["supersedes", "derived_from"],
          },
        ],
      },
    ],
    expected: ok({
      nodes: [
        { id: FIXTURE_IDS.fact, kind: "fact" },
        { id: IDS.decision, kind: "decision" },
      ],
      edges: [
        {
          id: FIXTURE_IDS.relation,
          sourceKind: "fact",
          sourceId: FIXTURE_IDS.fact,
          targetKind: "decision",
          targetId: IDS.decision,
          relation: "supersedes",
        },
      ],
    }),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_decide",
    variant: "create",
    args: {
      kind: "architecture",
      title: "Use deterministic contract fixtures",
      body: "They make exact MCP envelopes reproducible.",
      topicKey: "testing/deterministic-fixtures",
      conversationId: "contract-conversation",
      scopeRef: "mnemosyne",
      sensitivity: "confidential",
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: {
      createDecision: [
        resolves({
          id: IDS.decision,
          kind: "architecture",
          title: "Use deterministic contract fixtures",
          body: "They make exact MCP envelopes reproducible.",
          createdAt: T0,
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "createDecision",
        args: [
          {
            kind: "architecture",
            title: "Use deterministic contract fixtures",
            body: "They make exact MCP envelopes reproducible.",
            topicKey: "testing/deterministic-fixtures",
            conversationId: "contract-conversation",
            scopeRef: "mnemosyne",
            sensitivity: "confidential",
          },
          undefined,
          IDEMPOTENCY_KEY,
        ],
      },
    ],
    expected: ok({
      id: IDS.decision,
      kind: "architecture",
      title: "Use deterministic contract fixtures",
      body: "They make exact MCP envelopes reproducible.",
      createdAt: T0,
    }),
    classification: "known_defect",
    owners: ["B6.16", "B6.19"],
  },
  {
    kind: "baseline",
    tool: "memory_entity",
    variant: "create",
    args: {
      name: FIXTURE_ENTITY.name,
      kind: FIXTURE_ENTITY.kind,
      description: "Entity used by the MCP contract harness.",
      aliases: ["Fixture"],
      metadata: { deterministic: true },
      sensitivity: "confidential",
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: { createEntity: [resolves(FIXTURE_ENTITY)] },
    expectedClientCalls: [
      {
        path: "createEntity",
        args: [
          {
            name: FIXTURE_ENTITY.name,
            kind: FIXTURE_ENTITY.kind,
            description: "Entity used by the MCP contract harness.",
            aliases: ["Fixture"],
            sensitivity: "confidential",
            metadata: { deterministic: true },
          },
          undefined,
          IDEMPOTENCY_KEY,
        ],
      },
    ],
    expected: ok(FIXTURE_ENTITY),
    classification: "known_defect",
    owners: ["B6.16"],
  },
  {
    kind: "baseline",
    tool: "memory_entity",
    variant: "link_user",
    args: {
      action: "link_user",
      id: FIXTURE_IDS.entity,
      userId: FIXTURE_USER_ID,
    },
    stubs: {
      linkEntityUser: [
        resolves({ ...FIXTURE_ENTITY, kind: "person", linkedUserId: FIXTURE_USER_ID }),
      ],
    },
    expectedClientCalls: [
      { path: "linkEntityUser", args: [FIXTURE_IDS.entity, { userId: FIXTURE_USER_ID }] },
    ],
    expected: ok({ ...FIXTURE_ENTITY, kind: "person", linkedUserId: FIXTURE_USER_ID }),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_entity",
    variant: "unlink_user",
    args: {
      action: "unlink_user",
      id: FIXTURE_IDS.entity,
    },
    stubs: {
      unlinkEntityUser: [resolves({ ...FIXTURE_ENTITY, kind: "person", linkedUserId: null })],
    },
    expectedClientCalls: [{ path: "unlinkEntityUser", args: [FIXTURE_IDS.entity] }],
    expected: ok({ ...FIXTURE_ENTITY, kind: "person", linkedUserId: null }),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_status",
    variant: "status",
    args: {},
    stubs: {
      health: [resolves(HEALTH)],
      getStats: [resolves(STATS)],
      getMe: [resolves(ME)],
      healthReady: [resolves(READINESS)],
    },
    expectedClientCalls: STATUS_CALLS,
    expected: statusResult(SCOPE_BREAKDOWN, {
      workspaceId: FIXTURE_IDS.workspace,
      factsLive: 4,
    }),
    classification: "known_defect",
    owners: ["B6.23", "B6.24", "B6.25", "B6.32"],
  },
  {
    kind: "baseline",
    tool: "memory_remind_when",
    variant: "create",
    args: {
      content: "Review the contract harness",
      condition: "when Task 5 is complete",
      triggerAt: T1,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: {
      createReminder: [
        resolves({
          id: IDS.reminder,
          content: "Review the contract harness",
          condition: "when Task 5 is complete",
          triggerAt: T1,
          status: "pending",
          createdAt: T0,
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "createReminder",
        args: [
          {
            content: "Review the contract harness",
            condition: "when Task 5 is complete",
            triggerAt: T1,
          },
          undefined,
          IDEMPOTENCY_KEY,
        ],
      },
    ],
    expected: ok({
      id: IDS.reminder,
      content: "Review the contract harness",
      condition: "when Task 5 is complete",
      triggerAt: T1,
      status: "pending",
      createdAt: T0,
    }),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_episode_start",
    variant: "start",
    args: {
      agentId: "contract-agent",
      label: "Contract episode",
      metadata: { project: "mnemosyne" },
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: {
      createSession: [
        resolves({
          id: FIXTURE_IDS.session,
          agentId: "contract-agent",
          status: "active",
          createdAt: T0,
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "createSession",
        args: [
          {
            agentId: "contract-agent",
            label: "Contract episode",
            metadata: { project: "mnemosyne" },
          },
          undefined,
          IDEMPOTENCY_KEY,
        ],
      },
    ],
    expected: textOnly(`Episode started. sessionId: ${FIXTURE_IDS.session}`, false),
    classification: "known_defect",
    owners: ["B6.10", "B6.24"],
  },
  {
    kind: "baseline",
    tool: "memory_episode_end",
    variant: "end",
    args: {
      sessionId: FIXTURE_IDS.session,
      collapseHint: "Prioritize decisions",
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: {
      collapseSession: [resolves({ accepted: false, sessionId: FIXTURE_IDS.session })],
    },
    expectedClientCalls: [
      {
        path: "collapseSession",
        args: [
          FIXTURE_IDS.session,
          { strategy: "explicit", collapseHint: "Prioritize decisions" },
          undefined,
          IDEMPOTENCY_KEY,
        ],
      },
    ],
    // The tool now carries the pipeline's verdict out instead of announcing
    // "collapsed" no matter what came back — see
    // `contracts/episode-end-status.test.ts` for the skip paths this unblocks.
    // This stub sends no `status`, i.e. a pre-P115 server, which reads as
    // completed.
    expected: {
      content: [
        { type: "text", text: `Episode ended and collapsed. sessionId: ${FIXTURE_IDS.session}` },
      ],
      structuredContent: { sessionId: FIXTURE_IDS.session, status: "completed" },
      isError: false,
    },
    classification: "known_defect",
    owners: ["B6.9", "B6.24"],
  },
  {
    kind: "baseline",
    tool: "memory_session",
    variant: "pin",
    args: {
      action: "pin",
      factId: FIXTURE_IDS.fact,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: { pinFact: [resolves({ ...FIXTURE_FACT, pinned: true })] },
    expectedClientCalls: [
      {
        path: "pinFact",
        args: [FIXTURE_IDS.fact, undefined, IDEMPOTENCY_KEY],
      },
    ],
    expected: ok({ ...FIXTURE_FACT, pinned: true }),
    classification: "known_defect",
    owners: ["B6.8"],
  },
  {
    kind: "baseline",
    tool: "memory_session",
    variant: "scratch",
    args: {
      action: "scratch",
      sessionId: FIXTURE_IDS.session,
      content: "Original note",
      role: "assistant",
      metadata: { note: "Metadata overwrites content", source: "contract" },
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: { updateSessionScratch: [resolves(undefined)] },
    expectedClientCalls: [
      {
        path: "updateSessionScratch",
        args: [
          FIXTURE_IDS.session,
          { note: "Metadata overwrites content", role: "assistant", source: "contract" },
        ],
      },
    ],
    expected: ok({ scratched: true, sessionId: FIXTURE_IDS.session }),
    classification: "known_defect",
    owners: ["B6.10", "B6.34"],
  },
  {
    kind: "baseline",
    tool: "memory_session",
    variant: "collapse",
    args: {
      action: "collapse",
      sessionId: FIXTURE_IDS.session,
      collapseHint: "Prioritize decisions",
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: {
      collapseSession: [resolves({ accepted: false, sessionId: FIXTURE_IDS.session })],
    },
    expectedClientCalls: [
      {
        path: "collapseSession",
        args: [
          FIXTURE_IDS.session,
          { strategy: "explicit", collapseHint: "Prioritize decisions" },
          undefined,
          IDEMPOTENCY_KEY,
        ],
      },
    ],
    expected: ok({ accepted: false, sessionId: FIXTURE_IDS.session }),
    classification: "known_defect",
    owners: ["B6.9", "B6.24"],
  },
  {
    kind: "baseline",
    tool: "memory_session",
    variant: "discard",
    args: {
      action: "discard",
      sessionId: FIXTURE_IDS.session,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: { discardSession: [resolves(undefined)] },
    expectedClientCalls: [{ path: "discardSession", args: [FIXTURE_IDS.session] }],
    expected: ok({ discarded: true, sessionId: FIXTURE_IDS.session }),
    classification: "known_defect",
    owners: ["B6.10"],
  },
  {
    kind: "baseline",
    tool: "memory_consolidate",
    variant: "fast_false",
    args: {
      mode: "fast",
      dryRun: false,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: { triggerConsolidation: [resolves(CONSOLIDATION_RESULT)] },
    expectedClientCalls: [
      {
        path: "triggerConsolidation",
        args: [{ mode: "fast", dryRun: false }, undefined, IDEMPOTENCY_KEY],
      },
    ],
    expected: textOnly(CONSOLIDATION_TEXT),
    classification: "known_defect",
    owners: ["B6.35"],
  },
  {
    kind: "baseline",
    tool: "memory_consolidate",
    variant: "deep_false",
    args: {
      mode: "deep",
      dryRun: false,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: {
      triggerConsolidation: [
        rejects(
          consolidationError(
            "deep_mode_not_supported",
            "Manual deep consolidation is not supported yet; no changes were made."
          )
        ),
      ],
    },
    expectedClientCalls: [
      {
        path: "triggerConsolidation",
        args: [{ mode: "deep", dryRun: false }, undefined, IDEMPOTENCY_KEY],
      },
    ],
    expected: consolidationErrorResult(
      "deep_mode_not_supported",
      "Manual deep consolidation is not supported yet; no changes were made."
    ),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_consolidate",
    variant: "fast_true",
    args: {
      mode: "fast",
      dryRun: true,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: {
      triggerConsolidation: [
        rejects(
          consolidationError(
            "dry_run_not_supported",
            "Consolidation dry-run is not supported yet; no changes were made."
          )
        ),
      ],
    },
    expectedClientCalls: [
      {
        path: "triggerConsolidation",
        args: [{ mode: "fast", dryRun: true }, undefined, IDEMPOTENCY_KEY],
      },
    ],
    expected: consolidationErrorResult(
      "dry_run_not_supported",
      "Consolidation dry-run is not supported yet; no changes were made."
    ),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_consolidate",
    variant: "deep_true",
    args: {
      mode: "deep",
      dryRun: true,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: {
      triggerConsolidation: [
        rejects(
          consolidationError(
            "dry_run_not_supported",
            "Consolidation dry-run is not supported yet; no changes were made."
          )
        ),
      ],
    },
    expectedClientCalls: [
      {
        path: "triggerConsolidation",
        args: [{ mode: "deep", dryRun: true }, undefined, IDEMPOTENCY_KEY],
      },
    ],
    expected: consolidationErrorResult(
      "dry_run_not_supported",
      "Consolidation dry-run is not supported yet; no changes were made."
    ),
    classification: "contract",
  },
  {
    kind: "additional",
    tool: "memory_forget",
    variant: "fact",
    caseName: "rejects a missing fact target without a client call",
    args: { kind: "fact" },
    stubs: {},
    expectedClientCalls: [],
    expected: localError("memory_forget failed: primitiveId (or factId for facts) is required."),
    classification: "contract",
  },
  {
    kind: "additional",
    tool: "memory_forget",
    variant: "decision",
    caseName: "rejects factId as a non-fact target without a client call",
    args: { kind: "decision", factId: FIXTURE_IDS.fact },
    stubs: {},
    expectedClientCalls: [],
    expected: localError("memory_forget failed: primitiveId (or factId for facts) is required."),
    classification: "contract",
  },
  {
    kind: "additional",
    tool: "memory_session",
    variant: "pin",
    caseName: "requires factId without a client call",
    args: { action: "pin" },
    stubs: {},
    expectedClientCalls: [],
    expected: localError("pin requires `factId`."),
    classification: "contract",
  },
  {
    kind: "additional",
    tool: "memory_session",
    variant: "scratch",
    caseName: "requires sessionId without a client call",
    args: { action: "scratch", content: "note" },
    stubs: {},
    expectedClientCalls: [],
    expected: localError("scratch requires `sessionId` and `content`."),
    classification: "contract",
  },
  {
    kind: "additional",
    tool: "memory_session",
    variant: "scratch",
    caseName: "requires content without a client call",
    args: { action: "scratch", sessionId: FIXTURE_IDS.session },
    stubs: {},
    expectedClientCalls: [],
    expected: localError("scratch requires `sessionId` and `content`."),
    classification: "contract",
  },
  {
    kind: "additional",
    tool: "memory_session",
    variant: "collapse",
    caseName: "requires sessionId without a client call",
    args: { action: "collapse" },
    stubs: {},
    expectedClientCalls: [],
    expected: localError("collapse requires `sessionId`."),
    classification: "contract",
  },
  {
    kind: "additional",
    tool: "memory_session",
    variant: "discard",
    caseName: "requires sessionId without a client call",
    args: { action: "discard" },
    stubs: {},
    expectedClientCalls: [],
    expected: localError("discard requires `sessionId`."),
    classification: "contract",
  },
  {
    kind: "additional",
    tool: "memory_status",
    variant: "status",
    caseName: "swallows stats failure but preserves personal status",
    args: {},
    stubs: {
      health: [resolves(HEALTH)],
      getStats: [rejects(new Error("stats unavailable"))],
      getMe: [resolves(ME)],
      healthReady: [resolves(READINESS)],
    },
    expectedClientCalls: STATUS_CALLS,
    expected: statusResult([], {
      workspaceId: FIXTURE_IDS.workspace,
      factsLive: 4,
    }),
    classification: "known_defect",
    owners: ["B6.23", "B6.24", "B6.25", "B6.32"],
  },
  {
    kind: "additional",
    tool: "memory_status",
    variant: "status",
    caseName: "swallows identity failure but preserves scope status",
    args: {},
    stubs: {
      health: [resolves(HEALTH)],
      getStats: [resolves(STATS)],
      getMe: [rejects(new Error("identity unavailable"))],
      healthReady: [resolves(READINESS)],
    },
    expectedClientCalls: STATUS_CALLS,
    expected: statusResult(SCOPE_BREAKDOWN),
    classification: "known_defect",
    owners: ["B6.23", "B6.24", "B6.25", "B6.32"],
  },
  {
    kind: "additional",
    tool: "memory_session",
    variant: "pin",
    caseName: "delegates unpin through the unified session handler",
    args: {
      action: "pin",
      factId: FIXTURE_IDS.fact,
      unpin: true,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: { unpinFact: [resolves({ ...FIXTURE_FACT, pinned: false })] },
    expectedClientCalls: [
      {
        path: "unpinFact",
        args: [FIXTURE_IDS.fact, undefined, IDEMPOTENCY_KEY],
      },
    ],
    expected: ok({ ...FIXTURE_FACT, pinned: false }),
    classification: "known_defect",
    owners: ["B6.8"],
  },
  {
    kind: "additional",
    tool: "memory_session",
    variant: "collapse",
    caseName: "uses automatic strategy when no collapse hint is supplied",
    args: { action: "collapse", sessionId: FIXTURE_IDS.session },
    stubs: { collapseSession: [resolves({ accepted: true, sessionId: FIXTURE_IDS.session })] },
    expectedClientCalls: [
      {
        path: "collapseSession",
        args: [FIXTURE_IDS.session, { strategy: "auto" }, undefined, undefined],
      },
    ],
    expected: ok({ accepted: true, sessionId: FIXTURE_IDS.session }),
    classification: "contract",
  },
  {
    kind: "additional",
    tool: "memory_consolidate",
    variant: "fast_false",
    caseName: "reports when no eligible candidates exist",
    args: { mode: "fast", dryRun: false },
    stubs: {
      triggerConsolidation: [
        resolves({
          ...CONSOLIDATION_RESULT,
          candidatesProcessed: 0,
          mergedPairs: 0,
          skippedPairs: 0,
          errors: 0,
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "triggerConsolidation",
        args: [{ mode: "fast", dryRun: false }, undefined, undefined],
      },
    ],
    expected: textOnly(
      [
        "Consolidation pass complete.",
        "  mode:       fast",
        "  candidates: 0",
        "  merged:     0 pair(s)",
        "  skipped:    0 pair(s)",
        "  errors:     0",
        "  took:       17 ms",
        "",
        "No eligible candidates were found in the current bounded pass.",
      ].join("\n")
    ),
    classification: "known_defect",
    owners: ["B6.35"],
  },
  {
    kind: "additional",
    tool: "memory_consolidate",
    variant: "fast_false",
    caseName: "reports when inspected candidates form no mergeable clusters",
    args: { mode: "fast", dryRun: false },
    stubs: {
      triggerConsolidation: [
        resolves({
          ...CONSOLIDATION_RESULT,
          candidatesProcessed: 3,
          mergedPairs: 0,
          skippedPairs: 0,
          errors: 0,
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "triggerConsolidation",
        args: [{ mode: "fast", dryRun: false }, undefined, undefined],
      },
    ],
    expected: textOnly(
      [
        "Consolidation pass complete.",
        "  mode:       fast",
        "  candidates: 3",
        "  merged:     0 pair(s)",
        "  skipped:    0 pair(s)",
        "  errors:     0",
        "  took:       17 ms",
        "",
        "No merge-eligible clusters were found among the inspected candidates in this bounded pass.",
      ].join("\n")
    ),
    classification: "known_defect",
    owners: ["B6.35"],
  },
] satisfies readonly OutputScenario[];
