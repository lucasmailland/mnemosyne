import { FIXTURE_IDS, T0, T1, localError, ok, rejects, resolves } from "./output-fixtures.js";
import type { ExpectedToolName, OutputScenario } from "./output-types.js";

const IDS = {
  task: "00000000-0000-4000-8000-000000000011",
  event: "00000000-0000-4000-8000-000000000012",
  reasoning: "00000000-0000-4000-8000-000000000013",
  strategy: "00000000-0000-4000-8000-000000000014",
  parentTask: "00000000-0000-4000-8000-000000000015",
  supersededStrategy: "00000000-0000-4000-8000-000000000016",
  similarReasoning: "00000000-0000-4000-8000-000000000017",
} as const;

const IDEMPOTENCY_KEY = "contract-idempotency-key";
const AGENT_ID = "contract-agent";
const ASSIGNEE = "contract-assignee";
const TOPIC_KEY = "contracts/output-primitives";
const CHAIN = [
  {
    step: 0,
    reasoning: "Inspect the active handler before asserting its contract.",
    conclusion: "Use the exact current delegation.",
  },
  {
    step: 1,
    reasoning: "Compare the complete MCP envelope with the deterministic fixture.",
  },
] as const;

const TASK = {
  id: IDS.task,
  workspaceId: FIXTURE_IDS.workspace,
  title: "Verify primitive output contracts",
  description: "Exercise every task handler field.",
  status: "pending",
  priority: "high",
  assignedTo: ASSIGNEE,
  sensitivity: "confidential",
  parentTaskId: IDS.parentTask,
  blockedBy: [],
  subtaskIds: [],
  relatedFacts: [FIXTURE_IDS.fact],
  relatedEntities: [FIXTURE_IDS.entity],
  sessionId: FIXTURE_IDS.session,
  dueAt: T1,
  createdAt: T0,
  updatedAt: T1,
  metadata: { suite: "primitive-contracts" },
} as const;

const EVENT = {
  id: IDS.event,
  workspaceId: FIXTURE_IDS.workspace,
  type: "system",
  name: "contracts.verified",
  description: "Primitive output contracts were verified.",
  occurredAt: T0,
  durationS: 60,
  source: "contract-harness",
  relatedEntities: [FIXTURE_IDS.entity],
  annotations: [],
  sensitivity: "confidential",
  createdAt: T1,
  metadata: { deterministic: true },
} as const;

const REASONING = {
  id: IDS.reasoning,
  workspaceId: FIXTURE_IDS.workspace,
  agentId: AGENT_ID,
  question: "How should primitive MCP outputs be verified?",
  chain: CHAIN,
  conclusion: "Invoke the real handler with deterministic client stubs.",
  successCount: 3,
  failureCount: 1,
  worth: 0.7,
  topicKey: TOPIC_KEY,
  status: "golden",
  sensitivity: "confidential",
  lastUsedAt: T1,
  usageCount: 4,
  createdAt: T0,
  updatedAt: T1,
  metadata: { deterministic: true },
} as const;

const NEW_REASONING = {
  id: IDS.reasoning,
  workspaceId: FIXTURE_IDS.workspace,
  agentId: AGENT_ID,
  question: REASONING.question,
  chain: CHAIN,
  conclusion: REASONING.conclusion,
  successCount: 0,
  failureCount: 0,
  worth: 0.5,
  topicKey: TOPIC_KEY,
  status: "active",
  sensitivity: "confidential",
  usageCount: 0,
  createdAt: T0,
  updatedAt: T0,
  metadata: { deterministic: true },
} as const;

const RECORDED_REASONING = {
  ...NEW_REASONING,
  successCount: 1,
  worth: 2 / 3,
  sensitivity: "internal",
  updatedAt: T1,
  metadata: {},
} as const;

const ACTIVE_REASONING = { ...REASONING, status: "active" } as const;

const STRATEGY = {
  id: IDS.strategy,
  workspaceId: FIXTURE_IDS.workspace,
  agentId: AGENT_ID,
  trigger: "When an MCP output contract changes",
  action: "Run the focused contract family",
  context: "Primitive contract verification",
  scopeRef: "mnemosyne",
  sensitivity: "confidential",
  successCount: 2,
  failureCount: 1,
  worth: 2 / 3,
  supersedesId: IDS.supersededStrategy,
  status: "active",
  embeddingStale: false,
  validFrom: T0,
  createdAt: T0,
  updatedAt: T1,
  metadata: { deterministic: true },
} as const;

const NEW_STRATEGY = {
  ...STRATEGY,
  successCount: 0,
  failureCount: 0,
  worth: 0.5,
  updatedAt: T0,
} as const;

const SUPERSEDED_STRATEGY = {
  ...STRATEGY,
  status: "superseded",
  validTo: T1,
} as const;

function requiredFieldScenario(
  tool: ExpectedToolName,
  variant: string,
  caseName: string,
  args: Record<string, unknown>,
  message: string
): OutputScenario {
  return {
    kind: "additional",
    tool,
    variant,
    caseName,
    args,
    stubs: {},
    expectedClientCalls: [],
    expected: localError(message),
    classification: "contract",
  };
}

function downstreamErrorScenario(
  tool: ExpectedToolName,
  variant: string,
  args: Record<string, unknown>,
  path: string,
  callArgs: readonly unknown[]
): OutputScenario {
  return {
    kind: "additional",
    tool,
    variant,
    caseName: "flattens a downstream error into the current text-only envelope",
    args,
    stubs: { [path]: [rejects(new Error("downstream unavailable"))] },
    expectedClientCalls: [{ path, args: callArgs }],
    expected: localError(`${tool} failed: downstream unavailable`),
    classification: "known_defect",
    owners: ["B6.24"],
  } satisfies OutputScenario;
}

const TASK_BASELINES: readonly OutputScenario[] = [
  {
    kind: "baseline",
    tool: "memory_task",
    variant: "create",
    args: {
      action: "create",
      title: TASK.title,
      description: TASK.description,
      priority: TASK.priority,
      assignedTo: TASK.assignedTo,
      sessionId: TASK.sessionId,
      parentTaskId: TASK.parentTaskId,
      dueAt: TASK.dueAt,
      sensitivity: TASK.sensitivity,
      metadata: TASK.metadata,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: { createTask: [resolves(TASK)] },
    expectedClientCalls: [
      {
        path: "createTask",
        args: [
          {
            title: TASK.title,
            assignedTo: TASK.assignedTo,
            description: TASK.description,
            priority: TASK.priority,
            sessionId: TASK.sessionId,
            parentTaskId: TASK.parentTaskId,
            dueAt: TASK.dueAt,
            sensitivity: TASK.sensitivity,
            metadata: TASK.metadata,
          },
          undefined,
          IDEMPOTENCY_KEY,
        ],
      },
    ],
    expected: ok(TASK),
    classification: "known_defect",
    owners: ["B6.16", "B6.23"],
  },
  {
    kind: "baseline",
    tool: "memory_task",
    variant: "get",
    args: { action: "get", id: IDS.task },
    stubs: { getTask: [resolves(TASK)] },
    expectedClientCalls: [{ path: "getTask", args: [IDS.task] }],
    expected: ok(TASK),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_task",
    variant: "list",
    args: {
      action: "list",
      status: "pending",
      assignedTo: ASSIGNEE,
      parentTaskIdFilter: IDS.parentTask,
      limit: 500,
    },
    stubs: {
      listTasks: [resolves({ items: [TASK], total: 1, offset: 0, limit: 500, hasMore: false })],
    },
    expectedClientCalls: [
      {
        path: "listTasks",
        args: [
          { status: "pending", assignedTo: ASSIGNEE, parentTaskId: IDS.parentTask, limit: 500 },
        ],
      },
    ],
    expected: ok({ items: [TASK], total: 1, offset: 0, limit: 500, hasMore: false }),
    classification: "known_defect",
    owners: ["B6.16"],
  },
  {
    kind: "baseline",
    tool: "memory_task",
    variant: "patch",
    args: {
      action: "patch",
      id: IDS.task,
      title: "Verify updated primitive contracts",
      description: "Exercise every mutable task field.",
      status: "in_progress",
      priority: "critical",
      assignedTo: "contract-reviewer",
      outcome: "Verification started",
      lessonsLearned: "Use exact envelopes",
      dueAt: T1,
      metadata: { reviewed: true },
    },
    stubs: {
      patchTask: [
        resolves({
          ...TASK,
          title: "Verify updated primitive contracts",
          status: "in_progress",
          priority: "critical",
          assignedTo: "contract-reviewer",
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "patchTask",
        args: [
          IDS.task,
          {
            title: "Verify updated primitive contracts",
            description: "Exercise every mutable task field.",
            status: "in_progress",
            priority: "critical",
            assignedTo: "contract-reviewer",
            outcome: "Verification started",
            lessonsLearned: "Use exact envelopes",
            dueAt: T1,
            metadata: { reviewed: true },
          },
        ],
      },
    ],
    expected: ok({
      ...TASK,
      title: "Verify updated primitive contracts",
      status: "in_progress",
      priority: "critical",
      assignedTo: "contract-reviewer",
    }),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_task",
    variant: "archive",
    args: { action: "archive", id: IDS.task },
    stubs: { archiveTask: [resolves(undefined)] },
    expectedClientCalls: [{ path: "archiveTask", args: [IDS.task] }],
    expected: ok({ id: IDS.task, archived: true }),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_task",
    variant: "delegate",
    args: { action: "delegate", id: IDS.task, assignedTo: "contract-specialist" },
    stubs: {
      delegateTask: [resolves({ ...TASK, status: "delegated", assignedTo: "contract-specialist" })],
    },
    expectedClientCalls: [
      {
        path: "delegateTask",
        args: [IDS.task, { assignedTo: "contract-specialist" }],
      },
    ],
    expected: ok({ ...TASK, status: "delegated", assignedTo: "contract-specialist" }),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_task",
    variant: "complete",
    args: {
      action: "complete",
      id: IDS.task,
      outcome: "All primitive scenarios pass",
      lessonsLearned: "Exact delegation assertions expose drift",
    },
    stubs: {
      patchTask: [
        resolves({
          ...TASK,
          status: "completed",
          outcome: "All primitive scenarios pass",
          lessonsLearned: "Exact delegation assertions expose drift",
          completedAt: T1,
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "patchTask",
        args: [
          IDS.task,
          {
            status: "completed",
            outcome: "All primitive scenarios pass",
            lessonsLearned: "Exact delegation assertions expose drift",
          },
        ],
      },
    ],
    expected: ok({
      ...TASK,
      status: "completed",
      outcome: "All primitive scenarios pass",
      lessonsLearned: "Exact delegation assertions expose drift",
      completedAt: T1,
    }),
    classification: "known_defect",
    owners: ["B6.24"],
  },
];

const EVENT_BASELINES: readonly OutputScenario[] = [
  {
    kind: "baseline",
    tool: "memory_event",
    variant: "create",
    args: {
      action: "create",
      type: EVENT.type,
      name: EVENT.name,
      description: EVENT.description,
      occurredAt: EVENT.occurredAt,
      durationS: EVENT.durationS,
      source: EVENT.source,
      relatedEntities: EVENT.relatedEntities,
      sensitivity: EVENT.sensitivity,
      metadata: EVENT.metadata,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: { createEvent: [resolves(EVENT)] },
    expectedClientCalls: [
      {
        path: "createEvent",
        args: [
          {
            type: EVENT.type,
            name: EVENT.name,
            description: EVENT.description,
            occurredAt: EVENT.occurredAt,
            source: EVENT.source,
            durationS: EVENT.durationS,
            relatedEntities: EVENT.relatedEntities,
            sensitivity: EVENT.sensitivity,
            metadata: EVENT.metadata,
          },
          undefined,
          IDEMPOTENCY_KEY,
        ],
      },
    ],
    expected: ok(EVENT),
    classification: "known_defect",
    owners: ["B6.16", "B6.23"],
  },
  {
    kind: "baseline",
    tool: "memory_event",
    variant: "get",
    args: { action: "get", id: IDS.event },
    stubs: { getEvent: [resolves(EVENT)] },
    expectedClientCalls: [{ path: "getEvent", args: [IDS.event] }],
    expected: ok(EVENT),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_event",
    variant: "list",
    args: {
      action: "list",
      type: "system",
      sourceFilter: EVENT.source,
      after: T0,
      before: T1,
      limit: 500,
    },
    stubs: {
      listEvents: [resolves({ items: [EVENT], total: 1, offset: 0, limit: 500, hasMore: false })],
    },
    expectedClientCalls: [
      {
        path: "listEvents",
        args: [{ type: "system", source: EVENT.source, after: T0, before: T1, limit: 500 }],
      },
    ],
    expected: ok({ items: [EVENT], total: 1, offset: 0, limit: 500, hasMore: false }),
    classification: "known_defect",
    owners: ["B6.16"],
  },
  {
    kind: "baseline",
    tool: "memory_event",
    variant: "archive",
    args: { action: "archive", id: IDS.event },
    stubs: { archiveEvent: [resolves(undefined)] },
    expectedClientCalls: [{ path: "archiveEvent", args: [IDS.event] }],
    expected: ok({ id: IDS.event, archived: false, immutable: true }),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_event",
    variant: "annotate",
    args: {
      action: "annotate",
      id: IDS.event,
      author: AGENT_ID,
      content: "Verified against the active handler.",
      at: T1,
    },
    stubs: {
      annotateEvent: [
        resolves({
          ...EVENT,
          annotations: [
            { author: AGENT_ID, content: "Verified against the active handler.", at: T1 },
          ],
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "annotateEvent",
        args: [
          IDS.event,
          { author: AGENT_ID, content: "Verified against the active handler.", at: T1 },
        ],
      },
    ],
    expected: ok({
      ...EVENT,
      annotations: [{ author: AGENT_ID, content: "Verified against the active handler.", at: T1 }],
    }),
    classification: "contract",
  },
];

const REASONING_BASELINES: readonly OutputScenario[] = [
  {
    kind: "baseline",
    tool: "memory_reasoning",
    variant: "create",
    args: {
      action: "create",
      agentId: AGENT_ID,
      question: REASONING.question,
      chain: CHAIN,
      conclusion: REASONING.conclusion,
      topicKey: TOPIC_KEY,
      sensitivity: REASONING.sensitivity,
      metadata: REASONING.metadata,
    },
    stubs: { createReasoning: [resolves(NEW_REASONING)] },
    expectedClientCalls: [
      {
        path: "createReasoning",
        args: [
          {
            question: REASONING.question,
            chain: CHAIN,
            conclusion: REASONING.conclusion,
            agentId: AGENT_ID,
            topicKey: TOPIC_KEY,
            sensitivity: REASONING.sensitivity,
            metadata: REASONING.metadata,
          },
        ],
      },
    ],
    expected: ok(NEW_REASONING),
    classification: "known_defect",
    owners: ["B6.16", "B6.23"],
  },
  {
    kind: "baseline",
    tool: "memory_reasoning",
    variant: "get",
    args: { action: "get", id: IDS.reasoning },
    stubs: { getReasoning: [resolves(REASONING)] },
    expectedClientCalls: [{ path: "getReasoning", args: [IDS.reasoning] }],
    expected: ok(REASONING),
    classification: "known_defect",
    owners: ["B6.23"],
  },
  {
    kind: "baseline",
    tool: "memory_reasoning",
    variant: "list",
    args: { action: "list", status: "active", topicKeyFilter: TOPIC_KEY, limit: 500 },
    stubs: {
      listReasoning: [
        resolves({ items: [ACTIVE_REASONING], total: 1, offset: 0, limit: 500, hasMore: false }),
      ],
    },
    expectedClientCalls: [
      { path: "listReasoning", args: [{ status: "active", topicKey: TOPIC_KEY, limit: 500 }] },
    ],
    expected: ok({ items: [ACTIVE_REASONING], total: 1, offset: 0, limit: 500, hasMore: false }),
    classification: "known_defect",
    owners: ["B6.16", "B6.23"],
  },
  {
    kind: "baseline",
    tool: "memory_reasoning",
    variant: "patch",
    args: {
      action: "patch",
      id: IDS.reasoning,
      status: "archived",
      chain: CHAIN,
      conclusion: "The exact handler envelope is the executable contract evidence.",
      metadata: { reviewed: true },
    },
    stubs: {
      patchReasoning: [
        resolves({
          ...REASONING,
          status: "archived",
          conclusion: "The exact handler envelope is the executable contract evidence.",
          metadata: { reviewed: true },
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "patchReasoning",
        args: [
          IDS.reasoning,
          {
            status: "archived",
            chain: CHAIN,
            conclusion: "The exact handler envelope is the executable contract evidence.",
            metadata: { reviewed: true },
          },
        ],
      },
    ],
    expected: ok({
      ...REASONING,
      status: "archived",
      conclusion: "The exact handler envelope is the executable contract evidence.",
      metadata: { reviewed: true },
    }),
    classification: "known_defect",
    owners: ["B6.23"],
  },
  {
    kind: "baseline",
    tool: "memory_reasoning",
    variant: "archive",
    args: { action: "archive", id: IDS.reasoning },
    stubs: { archiveReasoning: [resolves(undefined)] },
    expectedClientCalls: [{ path: "archiveReasoning", args: [IDS.reasoning] }],
    expected: ok({ id: IDS.reasoning, archived: true }),
    classification: "contract",
  },
  {
    kind: "baseline",
    tool: "memory_reasoning",
    variant: "resolve",
    args: { action: "resolve", query: REASONING.question, topicKey: TOPIC_KEY },
    stubs: {
      resolveReasoning: [
        resolves({
          action: "hit",
          reasoning_id: IDS.reasoning,
          cached_cot: CHAIN,
          conclusion: REASONING.conclusion,
          suggested_model: "haiku",
        }),
      ],
    },
    expectedClientCalls: [
      { path: "resolveReasoning", args: [{ query: REASONING.question, topicKey: TOPIC_KEY }] },
    ],
    expected: ok({
      action: "hit",
      reasoning_id: IDS.reasoning,
      cached_cot: CHAIN,
      conclusion: REASONING.conclusion,
      suggested_model: "haiku",
    }),
    classification: "known_defect",
    owners: ["B6.23", "B6.24"],
  },
  {
    kind: "baseline",
    tool: "memory_reasoning",
    variant: "record",
    caseName: "returns a newly inserted reasoning record",
    args: {
      action: "record",
      agentId: AGENT_ID,
      question: REASONING.question,
      chain: CHAIN,
      conclusion: REASONING.conclusion,
      topicKey: TOPIC_KEY,
      // No `sensitivity`: record stores at the default tier, and the tool now
      // refuses it there (APP-022; audit-2026-11-22.test.ts).
      outcome: "success",
      metadata: { droppedByHandler: true },
    },
    stubs: { recordReasoning: [resolves(RECORDED_REASONING)] },
    expectedClientCalls: [
      {
        path: "recordReasoning",
        args: [
          {
            question: REASONING.question,
            chain: CHAIN,
            conclusion: REASONING.conclusion,
            agentId: AGENT_ID,
            topicKey: TOPIC_KEY,
            outcome: "success",
          },
        ],
      },
    ],
    expected: ok(RECORDED_REASONING),
    classification: "known_defect",
    owners: ["B6.16", "B6.23", "B6.24"],
  },
  {
    kind: "baseline",
    tool: "memory_reasoning",
    variant: "feedback",
    args: { action: "feedback", reasoningId: IDS.reasoning, outcome: "success" },
    stubs: { reasoningFeedback: [resolves({ ...REASONING, successCount: 4, worth: 0.75 })] },
    expectedClientCalls: [
      {
        path: "reasoningFeedback",
        args: [{ reasoning_id: IDS.reasoning, outcome: "success" }],
      },
    ],
    expected: ok({ ...REASONING, successCount: 4, worth: 0.75 }),
    classification: "known_defect",
    owners: ["B6.23"],
  },
];

const STRATEGY_BASELINES: readonly OutputScenario[] = [
  {
    kind: "baseline",
    tool: "memory_strategy",
    variant: "create",
    args: {
      op: "create",
      trigger: STRATEGY.trigger,
      action: STRATEGY.action,
      context: STRATEGY.context,
      agentId: AGENT_ID,
      scopeRef: STRATEGY.scopeRef,
      supersedesId: IDS.supersededStrategy,
      validFrom: T0,
      sensitivity: STRATEGY.sensitivity,
      metadata: STRATEGY.metadata,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    stubs: { createStrategy: [resolves(NEW_STRATEGY)] },
    expectedClientCalls: [
      {
        path: "createStrategy",
        args: [
          {
            trigger: STRATEGY.trigger,
            action: STRATEGY.action,
            context: STRATEGY.context,
            agentId: AGENT_ID,
            scopeRef: STRATEGY.scopeRef,
            supersedesId: IDS.supersededStrategy,
            validFrom: T0,
            sensitivity: STRATEGY.sensitivity,
            metadata: STRATEGY.metadata,
          },
          undefined,
          IDEMPOTENCY_KEY,
        ],
      },
    ],
    expected: ok(NEW_STRATEGY),
    classification: "known_defect",
    owners: ["B6.16", "B6.23"],
  },
  {
    kind: "baseline",
    tool: "memory_strategy",
    variant: "get",
    args: { op: "get", id: IDS.strategy },
    stubs: { getStrategy: [resolves(STRATEGY)] },
    expectedClientCalls: [{ path: "getStrategy", args: [IDS.strategy] }],
    expected: ok(STRATEGY),
    classification: "known_defect",
    owners: ["B6.23"],
  },
  {
    kind: "baseline",
    tool: "memory_strategy",
    variant: "list",
    args: {
      op: "list",
      statusFilter: "superseded",
      scopeRef: STRATEGY.scopeRef,
      validAt: T0,
      limit: 500,
    },
    stubs: {
      listStrategies: [
        resolves({ items: [SUPERSEDED_STRATEGY], total: 1, offset: 0, limit: 500, hasMore: false }),
      ],
    },
    expectedClientCalls: [
      {
        path: "listStrategies",
        args: [{ status: "superseded", scopeRef: STRATEGY.scopeRef, validAt: T0, limit: 500 }],
      },
    ],
    expected: ok({
      items: [SUPERSEDED_STRATEGY],
      total: 1,
      offset: 0,
      limit: 500,
      hasMore: false,
    }),
    classification: "known_defect",
    owners: ["B6.16", "B6.23"],
  },
  {
    kind: "baseline",
    tool: "memory_strategy",
    variant: "patch",
    args: {
      op: "patch",
      id: IDS.strategy,
      trigger: "When a primitive contract drifts",
      action: "Update the executable scenario",
      context: "Reviewed primitive contract",
      status: "superseded",
      validTo: T1,
      metadata: { reviewed: true },
    },
    stubs: {
      patchStrategy: [
        resolves({
          ...STRATEGY,
          trigger: "When a primitive contract drifts",
          action: "Update the executable scenario",
          status: "superseded",
          validTo: T1,
          embeddingStale: true,
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "patchStrategy",
        args: [
          IDS.strategy,
          {
            trigger: "When a primitive contract drifts",
            action: "Update the executable scenario",
            context: "Reviewed primitive contract",
            status: "superseded",
            validTo: T1,
            metadata: { reviewed: true },
          },
        ],
      },
    ],
    expected: ok({
      ...STRATEGY,
      trigger: "When a primitive contract drifts",
      action: "Update the executable scenario",
      status: "superseded",
      validTo: T1,
      embeddingStale: true,
    }),
    classification: "known_defect",
    owners: ["B6.16", "B6.23", "B6.24"],
  },
  {
    kind: "baseline",
    tool: "memory_strategy",
    variant: "archive",
    args: { op: "archive", id: IDS.strategy },
    stubs: { archiveStrategy: [resolves(undefined)] },
    expectedClientCalls: [{ path: "archiveStrategy", args: [IDS.strategy] }],
    expected: ok({ id: IDS.strategy, archived: true }),
    classification: "known_defect",
    owners: ["B6.16", "B6.23"],
  },
  {
    kind: "baseline",
    tool: "memory_strategy",
    variant: "store",
    args: {
      op: "store",
      trigger: STRATEGY.trigger,
      action: STRATEGY.action,
      context: STRATEGY.context,
      agentId: AGENT_ID,
      scopeRef: STRATEGY.scopeRef,
      supersedesId: IDS.supersededStrategy,
      validFrom: T0,
      sensitivity: STRATEGY.sensitivity,
      metadata: STRATEGY.metadata,
      idempotencyKey: "contract-store-idempotency-key",
    },
    stubs: { createStrategy: [resolves(NEW_STRATEGY)] },
    expectedClientCalls: [
      {
        path: "createStrategy",
        args: [
          {
            trigger: STRATEGY.trigger,
            action: STRATEGY.action,
            context: STRATEGY.context,
            agentId: AGENT_ID,
            scopeRef: STRATEGY.scopeRef,
            supersedesId: IDS.supersededStrategy,
            validFrom: T0,
            sensitivity: STRATEGY.sensitivity,
            metadata: STRATEGY.metadata,
          },
          undefined,
          "contract-store-idempotency-key",
        ],
      },
    ],
    expected: ok(NEW_STRATEGY),
    classification: "known_defect",
    owners: ["B6.16", "B6.23"],
  },
  {
    kind: "baseline",
    tool: "memory_strategy",
    variant: "recall",
    args: { op: "recall", scopeRef: STRATEGY.scopeRef, validAt: T1, limit: 25 },
    stubs: {
      listStrategies: [
        resolves({ items: [STRATEGY], total: 1, offset: 0, limit: 25, hasMore: false }),
      ],
    },
    expectedClientCalls: [
      {
        path: "listStrategies",
        args: [{ status: "active", scopeRef: STRATEGY.scopeRef, validAt: T1, limit: 25 }],
      },
    ],
    expected: ok({ items: [STRATEGY], total: 1, offset: 0, limit: 25, hasMore: false }),
    classification: "known_defect",
    owners: ["B6.16", "B6.24"],
  },
  {
    kind: "baseline",
    tool: "memory_strategy",
    variant: "rate",
    args: { op: "rate", id: IDS.strategy, outcome: "success" },
    stubs: { rateStrategy: [resolves({ ...STRATEGY, successCount: 3, worth: 5 / 8 })] },
    expectedClientCalls: [{ path: "rateStrategy", args: [IDS.strategy, "success"] }],
    expected: ok({ ...STRATEGY, successCount: 3, worth: 5 / 8 }),
    classification: "known_defect",
    owners: ["B6.16", "B6.23"],
  },
];

const REQUIRED_FIELD_SCENARIOS: readonly OutputScenario[] = [
  requiredFieldScenario(
    "memory_task",
    "create",
    "requires title and assignedTo without a client call",
    { action: "create" },
    "create requires `title` and `assignedTo`."
  ),
  requiredFieldScenario(
    "memory_task",
    "get",
    "requires id without a client call",
    { action: "get" },
    "get requires `id`."
  ),
  requiredFieldScenario(
    "memory_task",
    "patch",
    "requires id without a client call",
    { action: "patch" },
    "patch requires `id`."
  ),
  requiredFieldScenario(
    "memory_task",
    "archive",
    "requires id without a client call",
    { action: "archive" },
    "archive requires `id`."
  ),
  requiredFieldScenario(
    "memory_task",
    "delegate",
    "requires id before assignedTo without a client call",
    { action: "delegate", assignedTo: ASSIGNEE },
    "delegate requires `id`."
  ),
  requiredFieldScenario(
    "memory_task",
    "delegate",
    "requires assignedTo without a client call",
    { action: "delegate", id: IDS.task },
    "delegate requires `assignedTo` (the agent to delegate to)."
  ),
  requiredFieldScenario(
    "memory_task",
    "complete",
    "requires id without a client call",
    { action: "complete" },
    "complete requires `id`."
  ),
  requiredFieldScenario(
    "memory_event",
    "create",
    "requires all event fields without a client call",
    { action: "create" },
    "create requires `type`, `name`, `description`, `occurredAt`, `source`."
  ),
  requiredFieldScenario(
    "memory_event",
    "get",
    "requires id without a client call",
    { action: "get" },
    "get requires `id`."
  ),
  requiredFieldScenario(
    "memory_event",
    "archive",
    "requires id without a client call",
    { action: "archive" },
    "archive requires `id`."
  ),
  requiredFieldScenario(
    "memory_event",
    "annotate",
    "requires id before annotation fields without a client call",
    { action: "annotate", author: AGENT_ID, content: "annotation" },
    "annotate requires `id`."
  ),
  requiredFieldScenario(
    "memory_event",
    "annotate",
    "requires author and content without a client call",
    { action: "annotate", id: IDS.event },
    "annotate requires `author` and `content`."
  ),
  requiredFieldScenario(
    "memory_reasoning",
    "create",
    "requires question chain and conclusion without a client call",
    { action: "create" },
    "create requires `question`, non-empty `chain`, and `conclusion`."
  ),
  requiredFieldScenario(
    "memory_reasoning",
    "get",
    "requires id without a client call",
    { action: "get" },
    "get requires `id`."
  ),
  requiredFieldScenario(
    "memory_reasoning",
    "patch",
    "requires id without a client call",
    { action: "patch" },
    "patch requires `id`."
  ),
  requiredFieldScenario(
    "memory_reasoning",
    "archive",
    "requires id without a client call",
    { action: "archive" },
    "archive requires `id`."
  ),
  requiredFieldScenario(
    "memory_reasoning",
    "resolve",
    "requires query without a client call",
    { action: "resolve" },
    "resolve requires `query`."
  ),
  requiredFieldScenario(
    "memory_reasoning",
    "record",
    "requires question chain and conclusion without a client call",
    { action: "record" },
    "record requires `question`, non-empty `chain`, and `conclusion`."
  ),
  requiredFieldScenario(
    "memory_reasoning",
    "feedback",
    "requires reasoningId and outcome without a client call",
    { action: "feedback" },
    "feedback requires `reasoningId` and `outcome`."
  ),
  requiredFieldScenario(
    "memory_strategy",
    "create",
    "requires trigger and action without a client call",
    { op: "create" },
    "create requires `trigger` and `action`."
  ),
  requiredFieldScenario(
    "memory_strategy",
    "store",
    "requires trigger and action without a client call",
    { op: "store" },
    "store requires `trigger` and `action`."
  ),
  requiredFieldScenario(
    "memory_strategy",
    "get",
    "requires id without a client call",
    { op: "get" },
    "get requires `id`."
  ),
  requiredFieldScenario(
    "memory_strategy",
    "patch",
    "requires id without a client call",
    { op: "patch" },
    "patch requires `id`."
  ),
  requiredFieldScenario(
    "memory_strategy",
    "archive",
    "requires id without a client call",
    { op: "archive" },
    "archive requires `id`."
  ),
  requiredFieldScenario(
    "memory_strategy",
    "rate",
    "requires id and outcome without a client call",
    { op: "rate" },
    "rate requires `id` and `outcome` (success|failure)."
  ),
];

const DISTINCT_BRANCH_SCENARIOS: readonly OutputScenario[] = [
  {
    kind: "additional",
    tool: "memory_reasoning",
    variant: "resolve",
    caseName: "returns the execute miss envelope distinctly from a cache hit",
    args: { action: "resolve", query: "A novel contract question", topicKey: TOPIC_KEY },
    stubs: {
      resolveReasoning: [
        resolves({
          action: "execute",
          similar_attempts: [{ reasoning_id: IDS.similarReasoning, cosine: 0.72 }],
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "resolveReasoning",
        args: [{ query: "A novel contract question", topicKey: TOPIC_KEY }],
      },
    ],
    expected: ok({
      action: "execute",
      similar_attempts: [{ reasoning_id: IDS.similarReasoning, cosine: 0.72 }],
    }),
    classification: "known_defect",
    owners: ["B6.23", "B6.24"],
  },
  {
    kind: "additional",
    tool: "memory_reasoning",
    variant: "record",
    caseName: "passes through an existing-record response without claiming the backend dedup branch",
    args: {
      action: "record",
      agentId: "candidate-agent",
      question: "A semantically similar contract question",
      chain: [{ step: 0, reasoning: "Alternative reasoning evidence." }],
      conclusion: "Use the response selected by the backend.",
      topicKey: "candidate-topic",
      outcome: "fail",
    },
    stubs: {
      recordReasoning: [resolves({ ...REASONING, failureCount: 2, worth: 0.6 })],
    },
    expectedClientCalls: [
      {
        path: "recordReasoning",
        args: [
          {
            question: "A semantically similar contract question",
            chain: [{ step: 0, reasoning: "Alternative reasoning evidence." }],
            conclusion: "Use the response selected by the backend.",
            agentId: "candidate-agent",
            topicKey: "candidate-topic",
            outcome: "fail",
          },
        ],
      },
    ],
    expected: ok({ ...REASONING, failureCount: 2, worth: 0.6 }),
    classification: "known_defect",
    owners: ["B6.16", "B6.23", "B6.24"],
  },
  {
    kind: "additional",
    tool: "memory_strategy",
    variant: "rate",
    caseName: "returns the failure rating branch distinctly from success",
    args: { op: "rate", id: IDS.strategy, outcome: "failure" },
    stubs: { rateStrategy: [resolves({ ...STRATEGY, failureCount: 2, worth: 0.5 })] },
    expectedClientCalls: [{ path: "rateStrategy", args: [IDS.strategy, "failure"] }],
    expected: ok({ ...STRATEGY, failureCount: 2, worth: 0.5 }),
    classification: "known_defect",
    owners: ["B6.16", "B6.23"],
  },
];

const DOWNSTREAM_ERROR_SCENARIOS: readonly OutputScenario[] = [
  downstreamErrorScenario("memory_task", "get", { action: "get", id: IDS.task }, "getTask", [
    IDS.task,
  ]),
  downstreamErrorScenario("memory_event", "get", { action: "get", id: IDS.event }, "getEvent", [
    IDS.event,
  ]),
  downstreamErrorScenario(
    "memory_reasoning",
    "get",
    { action: "get", id: IDS.reasoning },
    "getReasoning",
    [IDS.reasoning]
  ),
  downstreamErrorScenario(
    "memory_strategy",
    "get",
    { op: "get", id: IDS.strategy },
    "getStrategy",
    [IDS.strategy]
  ),
];

export const PRIMITIVE_OUTPUT_SCENARIOS: readonly OutputScenario[] = [
  ...TASK_BASELINES,
  ...EVENT_BASELINES,
  ...REASONING_BASELINES,
  ...STRATEGY_BASELINES,
  ...REQUIRED_FIELD_SCENARIOS,
  ...DISTINCT_BRANCH_SCENARIOS,
  ...DOWNSTREAM_ERROR_SCENARIOS,
];
