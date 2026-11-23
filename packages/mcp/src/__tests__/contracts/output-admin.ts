import { vi } from "vitest";

import { FIXTURE_IDS, T0, T1, localError, ok, rejects, resolves } from "./output-fixtures.js";
import type { OutputScenario } from "./output-types.js";

const IDS = {
  workflow: "00000000-0000-4000-8000-000000000031",
  replacement: "00000000-0000-4000-8000-000000000032",
  factB: "00000000-0000-4000-8000-000000000033",
  relation: "00000000-0000-4000-8000-000000000034",
  mergedFact: "00000000-0000-4000-8000-000000000035",
  user: "00000000-0000-4000-8000-000000000036",
  personalWorkspace: "00000000-0000-4000-8000-000000000037",
} as const;

const T2 = "2026-01-01T00:02:00.000Z";
const STEPS = [
  {
    order: 0,
    action: "Read the active handler and its backend source.",
    condition: "Before asserting an output contract.",
    expectedDurationMs: 1_000,
    tools: ["read"],
  },
] as const;

const WORKFLOW = {
  id: IDS.workflow,
  workspaceId: FIXTURE_IDS.workspace,
  name: "Verify admin output contracts",
  description: "Exercise the exact workflow wire shape.",
  steps: STEPS,
  scopeRef: "project:mnemosyne",
  avgDurationMs: 0,
  successRate: 0,
  executionCount: 0,
  version: 1,
  status: "active",
  sensitivity: "confidential",
  createdAt: T0,
  updatedAt: T0,
  metadata: { suite: "admin-contracts" },
} as const;

const SKILL = {
  id: FIXTURE_IDS.fact,
  workspaceId: FIXTURE_IDS.workspace,
  name: "Verify MCP output contracts",
  promptTemplate: "Verify MCP output contracts",
  variables: [],
  requiredContext: [],
  qualityScore: 1.0,
  usageCount: 0,
  embeddingStale: false,
  sensitivity: "internal",
  createdAt: T0,
  updatedAt: T0,
  metadata: { tags: ["contracts"] },
} as const;

const LISTED_SKILL_FACT = {
  id: FIXTURE_IDS.fact,
  workspaceId: FIXTURE_IDS.workspace,
  agentId: null,
  scope: "global",
  scopeRef: null,
  kind: "skill",
  subject: "workspace",
  statement: "Verify MCP output contracts",
  confidence: 1,
  pinned: false,
  relevance: 1,
  hitCount: 0,
  lastRecalledAt: null,
  sourceMessageIds: [],
  attributedTo: null,
  linkedMemoryIds: [],
  metadata: {},
  status: "active",
  mergedIntoId: null,
  validFrom: T0,
  validTo: null,
  createdAt: T0,
  updatedAt: T0,
  memoryType: "procedural",
  actorId: null,
} as const;

const FACT_A = {
  id: FIXTURE_IDS.fact,
  workspaceId: FIXTURE_IDS.workspace,
  content: "The deployment uses the stable channel.",
  attribution: { source: "contract" },
  tags: ["deployment"],
  pinned: false,
  validFrom: T0,
  validTo: null,
  createdAt: T0,
} as const;

const FACT_B = {
  ...FACT_A,
  id: IDS.factB,
  content: "The deployment uses the preview channel.",
  createdAt: T2,
} as const;

const CONFLICTS = {
  pairs: [
    {
      relationId: IDS.relation,
      confidence: 0.8,
      factA: {
        id: FIXTURE_IDS.fact,
        subject: "deployment channel",
        statement: FACT_A.content,
        worth: 0.6,
        validFrom: T0,
        validTo: null,
      },
      factB: {
        id: IDS.factB,
        subject: "deployment channel",
        statement: FACT_B.content,
        worth: 0.7,
        validFrom: T0,
        validTo: null,
      },
    },
  ],
} as const;

const STATS = {
  workspaceId: FIXTURE_IDS.workspace,
  generatedAt: T1,
  facts: {
    live: 8,
    closed: 2,
    pinned: 1,
    archived: 1,
    withZeroHits: 3,
    byScopeRef: [{ scopeRef: "project:mnemosyne", count: 4 }],
  },
  decisions: { active: 2 },
  relations: { conflicts: 1 },
  embeddings: { indexed: 7, pending: 1 },
  recall: { hitRate30d: 0.75, lastRecallAt: T1 },
  lastWriteAt: T1,
} as const;

const ME = {
  workspaceId: FIXTURE_IDS.workspace,
  workspaceName: "Mnemosyne",
  keyId: "mk_test_contract",
  actorType: "user",
  scopes: ["memory:read", "memory:write"],
  plan: "pro",
  keyPrefix: "mk_test_",
  expiresAt: T2,
  ipAllowlist: [],
  userId: IDS.user,
  personalWorkspaceId: IDS.personalWorkspace,
  personalFactsLive: 2,
} as const;

const CONTEXT_NOTE =
  "The active workspace is FIXED for the whole session (the API key or token sets it when the process starts). No tool switches workspaces mid-session. To write to another workspace, start a new session with that workspace's key or token.";

function setupDoctor(): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T1));
  vi.stubEnv("MNEMO_URL", "https://memory.example.test");
  vi.stubEnv("MNEMO_KEY", "mk_test_contract");
}

function cleanupDoctor(): void {
  vi.unstubAllEnvs();
  vi.useRealTimers();
}

export const ADMIN_OUTPUT_SCENARIOS: readonly OutputScenario[] = [
  {
    kind: "baseline",
    classification: "known_defect",
    owners: ["B6.23"],
    tool: "memory_workflow",
    variant: "create",
    args: {
      action: "create",
      name: WORKFLOW.name,
      description: WORKFLOW.description,
      steps: STEPS,
      scopeRef: WORKFLOW.scopeRef,
      sensitivity: WORKFLOW.sensitivity,
      metadata: WORKFLOW.metadata,
    },
    stubs: { createWorkflow: [resolves(WORKFLOW)] },
    expectedClientCalls: [
      {
        path: "createWorkflow",
        args: [
          {
            name: WORKFLOW.name,
            steps: STEPS,
            description: WORKFLOW.description,
            scopeRef: WORKFLOW.scopeRef,
            sensitivity: WORKFLOW.sensitivity,
            metadata: WORKFLOW.metadata,
          },
        ],
      },
    ],
    expected: ok(WORKFLOW),
  },
  {
    kind: "baseline",
    classification: "known_defect",
    owners: ["B6.23"],
    tool: "memory_workflow",
    variant: "get",
    args: { action: "get", id: IDS.workflow },
    stubs: { getWorkflow: [resolves(WORKFLOW)] },
    expectedClientCalls: [{ path: "getWorkflow", args: [IDS.workflow] }],
    expected: ok(WORKFLOW),
  },
  {
    kind: "baseline",
    classification: "known_defect",
    owners: ["B6.23"],
    tool: "memory_workflow",
    variant: "list",
    args: {
      action: "list",
      status: "active",
      scopeRef: WORKFLOW.scopeRef,
      limit: 1,
      offset: 2,
    },
    stubs: {
      listWorkflows: [
        resolves({ items: [WORKFLOW], total: 4, offset: 2, limit: 1, hasMore: true }),
      ],
    },
    expectedClientCalls: [
      {
        path: "listWorkflows",
        args: [{ status: "active", scopeRef: WORKFLOW.scopeRef, limit: 1, offset: 2 }],
      },
    ],
    expected: ok({ items: [WORKFLOW], total: 4, offset: 2, limit: 1, hasMore: true }),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_skill",
    variant: "create",
    args: { action: "create", content: "Verify MCP output contracts", tags: ["contracts"] },
    stubs: { createSkill: [resolves(SKILL)] },
    expectedClientCalls: [
      {
        path: "createSkill",
        args: [
          {
            name: "Verify MCP output contracts",
            promptTemplate: "Verify MCP output contracts",
            metadata: { tags: ["contracts"] },
          },
        ],
      },
    ],
    expected: ok(SKILL),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_skill",
    variant: "get",
    args: { action: "get", id: FIXTURE_IDS.fact },
    stubs: { getSkill: [resolves(SKILL)] },
    expectedClientCalls: [{ path: "getSkill", args: [FIXTURE_IDS.fact] }],
    expected: ok(SKILL),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_skill",
    variant: "list",
    args: { action: "list", limit: 1 },
    stubs: {
      listSkills: [resolves({ items: [SKILL], total: 1, offset: 0, limit: 1, hasMore: false })],
    },
    expectedClientCalls: [{ path: "listSkills", args: [{ limit: 1 }] }],
    expected: ok({ items: [SKILL], total: 1, offset: 0, limit: 1, hasMore: false }),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_skill",
    variant: "forget",
    args: { action: "forget", id: FIXTURE_IDS.fact },
    stubs: { forgetPrimitive: [resolves({ forgotten: true })] },
    expectedClientCalls: [{ path: "forgetPrimitive", args: ["skill", FIXTURE_IDS.fact] }],
    expected: ok({ id: FIXTURE_IDS.fact, forgotten: true }),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_doctor",
    variant: "doctor",
    args: {},
    stubs: {
      doctor: [
        resolves({
          status: "ok",
          checks: [
            { name: "connectivity", status: "ok", message: "Postgres is reachable." },
            { name: "app_user_grants", status: "ok", message: "Schema usage is granted." },
            { name: "schema_shadows", status: "ok", message: "No shadow tables found." },
            { name: "migration_version", status: "ok", message: "Latest migration is applied." },
            { name: "embedding_backlog", status: "ok", message: "No embedding backlog." },
            { name: "workspace_id_valid", status: "ok", message: "workspace_id is valid." },
          ],
          timestamp: T0,
        }),
      ],
    },
    expectedClientCalls: [{ path: "doctor", args: [] }],
    expected: ok({
      status: "ok",
      checks: [
        { name: "connectivity", status: "ok", message: "Postgres is reachable." },
        { name: "app_user_grants", status: "ok", message: "Schema usage is granted." },
        { name: "schema_shadows", status: "ok", message: "No shadow tables found." },
        { name: "migration_version", status: "ok", message: "Latest migration is applied." },
        { name: "embedding_backlog", status: "ok", message: "No embedding backlog." },
        { name: "workspace_id_valid", status: "ok", message: "workspace_id is valid." },
        { name: "env_config", status: "ok", message: "MNEMO_URL and MNEMO_KEY are present." },
        {
          name: "mcp_tools",
          status: "ok",
          message: "37 tools registered (profile full: expected exactly 37).",
          detail: { profile: "full", toolCount: 37, expected: 37 },
        },
      ],
      timestamp: T1,
      _meta: { serverReachable: true, checkCount: 8 },
    }),
    setup: setupDoctor,
    cleanup: cleanupDoctor,
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_update",
    variant: "replace",
    args: {
      factId: FIXTURE_IDS.fact,
      statement: "The corrected admin contract statement.",
      reason: "Correct a deterministic fixture.",
    },
    stubs: {
      selfEdit: [
        resolves({
          applied: true,
          action: "replace",
          target: FIXTURE_IDS.fact,
          targetKind: "fact",
          replacementId: IDS.replacement,
          countsAsEdit: true,
          countsAsDelete: false,
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "selfEdit",
        args: [
          {
            action: "replace",
            target: FIXTURE_IDS.fact,
            content: "The corrected admin contract statement.",
            reason: "Correct a deterministic fixture.",
          },
        ],
      },
    ],
    expected: ok({
      applied: true,
      action: "replace",
      target: FIXTURE_IDS.fact,
      targetKind: "fact",
      replacementId: IDS.replacement,
      countsAsEdit: true,
      countsAsDelete: false,
    }),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_judge",
    variant: "list",
    args: { action: "list", limit: 1 },
    stubs: { judge: [resolves(CONFLICTS)] },
    expectedClientCalls: [{ path: "judge", args: [{ limit: 1 }] }],
    expected: ok(CONFLICTS),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_judge",
    variant: "resolve",
    args: {
      action: "resolve",
      relationId: IDS.relation,
      resolution: "merge",
      mergedStatement: "The deployment channel is selected per environment.",
    },
    stubs: {
      resolveConflict: [
        resolves({
          resolved: true,
          action: "merge",
          relationId: IDS.relation,
          mergedFactId: IDS.mergedFact,
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "resolveConflict",
        args: [
          IDS.relation,
          {
            action: "merge",
            mergedStatement: "The deployment channel is selected per environment.",
          },
        ],
      },
    ],
    expected: ok({
      resolved: true,
      action: "merge",
      relationId: IDS.relation,
      mergedFactId: IDS.mergedFact,
    }),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_stats",
    variant: "stats",
    args: {},
    stubs: { getStats: [resolves(STATS)] },
    expectedClientCalls: [{ path: "getStats", args: [] }],
    expected: ok(STATS),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_compare",
    variant: "compare",
    args: { factIdA: FIXTURE_IDS.fact, factIdB: IDS.factB },
    stubs: {
      compareFacts: [
        resolves({
          factA: FACT_A,
          factB: FACT_B,
          differences: [`content: "${FACT_A.content}" → "${FACT_B.content}"`],
          suggestedVerb: "supersedes",
          sameSubject: true,
        }),
      ],
    },
    expectedClientCalls: [
      { path: "compareFacts", args: [{ factIdA: FIXTURE_IDS.fact, factIdB: IDS.factB }] },
    ],
    expected: ok({
      factA: FACT_A,
      factB: FACT_B,
      differences: [`content: "${FACT_A.content}" → "${FACT_B.content}"`],
      suggestedVerb: "supersedes",
      sameSubject: true,
    }),
  },
  {
    kind: "baseline",
    classification: "known_defect",
    owners: ["B6.18"],
    tool: "memory_purge",
    variant: "fact",
    args: { action: "fact", factId: `  ${FIXTURE_IDS.fact}  ` },
    stubs: { purgeFact: [resolves({ deleted: true })] },
    expectedClientCalls: [{ path: "purgeFact", args: [FIXTURE_IDS.fact] }],
    expected: ok({ deleted: true }),
  },
  {
    kind: "baseline",
    classification: "known_defect",
    owners: ["B6.18"],
    tool: "memory_purge",
    variant: "closed",
    args: { action: "closed", confirm: true },
    stubs: { purgeClosedFacts: [resolves({ deleted: 0 })] },
    expectedClientCalls: [{ path: "purgeClosedFacts", args: [] }],
    expected: ok({ deleted: 0 }),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_context",
    variant: "context",
    args: { includeStats: true, includeOtherWorkspaces: true },
    stubs: {
      getMe: [resolves(ME)],
      getStats: [resolves(STATS)],
      listMyWorkspaces: [resolves([])],
      listWorkspacesForCurrentTenant: [resolves([])],
    },
    expectedClientCalls: [
      { path: "getMe", args: [] },
      { path: "getStats", args: [] },
      { path: "listMyWorkspaces", args: [] },
      { path: "listWorkspacesForCurrentTenant", args: [] },
    ],
    expected: ok({
      workspace: {
        id: FIXTURE_IDS.workspace,
        name: "Mnemosyne",
        keyPrefix: "mk_test_",
        plan: "pro",
        role: null,
      },
      key: {
        id: "mk_test_contract",
        actorType: "user",
        scopes: ["memory:read", "memory:write"],
        expiresAt: T2,
      },
      user: { id: IDS.user, personalWorkspaceId: IDS.personalWorkspace },
      personalWorkspaceId: IDS.personalWorkspace,
      stats: { factsLive: 8, factsPinned: 1, lastRecallAt: T1, hitRate30d: 0.75 },
      _note: CONTEXT_NOTE,
    }),
  },
  {
    kind: "additional",
    classification: "contract",
    tool: "memory_doctor",
    variant: "doctor",
    caseName: "server unreachable remains a diagnostic success",
    args: {},
    stubs: { doctor: [rejects(new Error("connect ECONNREFUSED 127.0.0.1:3939"))] },
    expectedClientCalls: [{ path: "doctor", args: [] }],
    expected: ok({
      status: "error",
      checks: [
        {
          name: "server",
          status: "error",
          message: "Cannot reach Mnemosyne server: connect ECONNREFUSED 127.0.0.1:3939",
        },
        { name: "env_config", status: "ok", message: "MNEMO_URL and MNEMO_KEY are present." },
        {
          name: "mcp_tools",
          status: "ok",
          message: "37 tools registered (profile full: expected exactly 37).",
          detail: { profile: "full", toolCount: 37, expected: 37 },
        },
      ],
      timestamp: T1,
      _meta: { serverReachable: false, checkCount: 3 },
    }),
    setup: setupDoctor,
    cleanup: cleanupDoctor,
  },
  {
    kind: "additional",
    classification: "contract",
    tool: "memory_update",
    variant: "replace",
    caseName: "strategy replacement requires approval",
    args: {
      factId: "strategy:00000000-0000-4000-8000-000000000038",
      statement: "Use the reviewed deployment strategy.",
    },
    stubs: {
      selfEdit: [
        resolves({
          applied: false,
          action: "replace",
          target: "strategy:00000000-0000-4000-8000-000000000038",
          targetKind: "strategy",
          approvalRequired: true,
          scope: "edit_entity",
          reason: "Action 'replace' maps to approval-gated scope 'edit_entity'.",
        }),
      ],
    },
    expectedClientCalls: [
      {
        path: "selfEdit",
        args: [
          {
            action: "replace",
            target: "strategy:00000000-0000-4000-8000-000000000038",
            content: "Use the reviewed deployment strategy.",
            reason: "Updated via memory_update",
          },
        ],
      },
    ],
    expected: ok({
      applied: false,
      action: "replace",
      target: "strategy:00000000-0000-4000-8000-000000000038",
      targetKind: "strategy",
      approvalRequired: true,
      scope: "edit_entity",
      reason: "Action 'replace' maps to approval-gated scope 'edit_entity'.",
    }),
  },
  {
    kind: "additional",
    classification: "contract",
    tool: "memory_judge",
    variant: "resolve",
    caseName: "merge rejects a whitespace-only merged statement locally",
    args: {
      action: "resolve",
      relationId: IDS.relation,
      resolution: "merge",
      mergedStatement: "   ",
    },
    stubs: {},
    expectedClientCalls: [],
    expected: localError(
      "resolution='merge' requires 'mergedStatement' — provide the corrected unified statement."
    ),
  },
  {
    kind: "additional",
    classification: "known_defect",
    owners: ["B6.32"],
    tool: "memory_context",
    variant: "context",
    caseName: "disabled optional sections make no optional client calls",
    args: { includeStats: false, includeOtherWorkspaces: false },
    stubs: { getMe: [resolves(ME)] },
    expectedClientCalls: [{ path: "getMe", args: [] }],
    expected: ok({
      workspace: {
        id: FIXTURE_IDS.workspace,
        name: "Mnemosyne",
        keyPrefix: "mk_test_",
        plan: "pro",
        role: null,
      },
      key: {
        id: "mk_test_contract",
        actorType: "user",
        scopes: ["memory:read", "memory:write"],
        expiresAt: T2,
      },
      user: { id: IDS.user, personalWorkspaceId: IDS.personalWorkspace },
      personalWorkspaceId: IDS.personalWorkspace,
      _note: CONTEXT_NOTE,
    }),
  },
  {
    kind: "additional",
    classification: "contract",
    tool: "memory_context",
    variant: "context",
    caseName: "identity failure returns an error",
    args: { includeStats: true, includeOtherWorkspaces: true },
    stubs: {
      getMe: [rejects(new Error("identity unavailable"))],
      getStats: [resolves(STATS)],
    },
    expectedClientCalls: [
      { path: "getMe", args: [] },
      { path: "getStats", args: [] },
    ],
    expected: localError("memory_context failed: identity unavailable"),
  },
  {
    kind: "additional",
    classification: "contract",
    tool: "memory_context",
    variant: "context",
    caseName:
      "read-role workspace member gets an explicit recovery note instead of a silent ceiling",
    args: { includeStats: false, includeOtherWorkspaces: false },
    stubs: { getMe: [resolves({ ...ME, workspaceRole: "read" })] },
    expectedClientCalls: [{ path: "getMe", args: [] }],
    expected: ok({
      workspace: {
        id: FIXTURE_IDS.workspace,
        name: "Mnemosyne",
        keyPrefix: "mk_test_",
        plan: "pro",
        role: "read",
      },
      key: {
        id: "mk_test_contract",
        actorType: "user",
        scopes: ["memory:read", "memory:write"],
        expiresAt: T2,
      },
      user: { id: IDS.user, personalWorkspaceId: IDS.personalWorkspace },
      personalWorkspaceId: IDS.personalWorkspace,
      _note: CONTEXT_NOTE,
      _roleNote:
        "Your role in this workspace is 'read': you can only read (memory_recall, memory_search, memory_timeline). Writes (memory_remember, memory_decide, memory_task, etc.) return 403. Ask a workspace admin to give you the 'write' or 'admin' role if you need to write; do not retry the write expecting a retry to fix it.",
    }),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_workspace",
    variant: "workspace",
    caseName: "workspace",
    args: { action: "list" },
    stubs: {
      listMyWorkspaces: [
        resolves([{ workspaceId: FIXTURE_IDS.workspace, workspaceName: "Primary Workspace" }]),
      ],
    },
    expectedClientCalls: [{ path: "listMyWorkspaces", args: [] }],
    expected: ok({
      workspaces: [{ workspaceId: FIXTURE_IDS.workspace, workspaceName: "Primary Workspace" }],
    }),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_workspace",
    variant: "describe",
    caseName: "describe",
    args: { action: "describe", workspaceId: FIXTURE_IDS.workspace },
    stubs: {
      getWorkspaceById: [
        resolves({
          id: FIXTURE_IDS.workspace,
          name: "Mnemosyne",
          slug: "mnemosyne",
          tenantId: IDS.user,
          visibility: "private",
          createdAt: T0,
        }),
      ],
    },
    expectedClientCalls: [{ path: "getWorkspaceById", args: [FIXTURE_IDS.workspace] }],
    expected: ok({
      workspace: {
        id: FIXTURE_IDS.workspace,
        name: "Mnemosyne",
        slug: "mnemosyne",
        tenantId: IDS.user,
        visibility: "private",
        createdAt: T0,
      },
    }),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_workspace",
    variant: "create",
    caseName: "create",
    args: { action: "create", name: "New Workspace", tenantId: "tenant_1" },
    stubs: {
      createWorkspace: [
        resolves({
          id: "ws_new",
          name: "New Workspace",
          slug: null,
          tenantId: "tenant_1",
          visibility: "private",
          createdAt: T0,
        }),
      ],
    },
    expectedClientCalls: [
      { path: "createWorkspace", args: ["tenant_1", { name: "New Workspace" }] },
    ],
    expected: ok({
      workspace: {
        id: "ws_new",
        name: "New Workspace",
        slug: null,
        tenantId: "tenant_1",
        visibility: "private",
        createdAt: T0,
      },
    }),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_workspace",
    variant: "invite",
    caseName: "invite",
    args: { action: "invite", workspaceId: FIXTURE_IDS.workspace, userId: IDS.user, role: "write" },
    stubs: { inviteWorkspaceMember: [resolves({ ok: true })] },
    expectedClientCalls: [
      {
        path: "inviteWorkspaceMember",
        args: [FIXTURE_IDS.workspace, { userId: IDS.user, role: "write" }],
      },
    ],
    expected: ok({ ok: true }),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_workspace",
    variant: "set_role",
    caseName: "set_role",
    args: {
      action: "set_role",
      workspaceId: FIXTURE_IDS.workspace,
      userId: IDS.user,
      role: "admin",
    },
    stubs: { updateWorkspaceMemberRole: [resolves({ ok: true })] },
    expectedClientCalls: [
      { path: "updateWorkspaceMemberRole", args: [FIXTURE_IDS.workspace, IDS.user, "admin"] },
    ],
    expected: ok({ ok: true }),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_workspace",
    variant: "remove",
    caseName: "remove",
    args: { action: "remove", workspaceId: FIXTURE_IDS.workspace, userId: IDS.user },
    stubs: { removeWorkspaceMember: [resolves({ ok: true })] },
    expectedClientCalls: [
      { path: "removeWorkspaceMember", args: [FIXTURE_IDS.workspace, IDS.user] },
    ],
    expected: ok({ ok: true }),
  },
  {
    kind: "baseline",
    classification: "contract",
    tool: "memory_suggest_topic_key",
    variant: "suggest_topic_key",
    caseName: "suggest_topic_key",
    args: { subject: "Auth Strategy", body: "Use JWT rotation" },
    stubs: {
      suggestTopicKey: [
        resolves({
          topicKey: "auth-strategy/use-jwt-rotation",
          levels: ["auth-strategy", "use-jwt-rotation"],
          source: "subject+body",
        }),
      ],
    },
    expectedClientCalls: [
      { path: "suggestTopicKey", args: [{ subject: "Auth Strategy", body: "Use JWT rotation" }] },
    ],
    expected: ok({
      topicKey: "auth-strategy/use-jwt-rotation",
      levels: ["auth-strategy", "use-jwt-rotation"],
      source: "subject+body",
    }),
  },
];
