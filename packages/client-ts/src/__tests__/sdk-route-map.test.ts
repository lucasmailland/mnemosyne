import { describe, it, expect } from "vitest";
import { MnemosyneClient } from "../client.js";

/**
 * B1.2 (SDK half) — enumerates every method exposed by `MnemosyneClient`
 * (including the two nested namespace getters, `composition` and
 * `sessions`), invokes each with a minimal-valid, hand-fixtured argument
 * list against a recording fetch, and records the (method, pathname) it
 * actually issues.
 *
 * Per-method inputs cannot be zod-derived here the way the MCP tool
 * inventory's are (this SDK has no runtime schema for its own parameters —
 * only TypeScript types, erased at build time), so this file — like the
 * CLI's command-route-map — carries an explicit, reviewable fixture table.
 * A new prototype method with no fixture fails the completeness guard
 * below.
 *
 * None of the object-shaped arguments need to be realistic: every method
 * either forwards its input object straight into the request body/query
 * with no local validation, or (the string-typed positional arguments)
 * interpolates it verbatim into a path template — so a placeholder string
 * is sufficient to reconstruct the real path shape.
 */

interface RecordedCall {
  method: string;
  path: string;
}

function makeRecordingFetch(): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" || input instanceof URL ? input : input.url;
    const url = new URL(String(raw));
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname });
    // `GET /me` gets a richer stub: some SDK methods (e.g.
    // `listWorkspacesForCurrentTenant`) chain an internal `getMe()` call
    // and only proceed to their SECOND request when a field on the first
    // response (`tenantId`) is truthy. An empty `{}` would silently
    // short-circuit those methods to a single recorded call.
    const body = url.pathname === "/me" ? { tenantId: "tenant_1", userId: "user_1" } : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

type Fixture = unknown[] | { skip: string };

/** One entry per own, non-getter `MnemosyneClient.prototype` method. */
const ARG_FIXTURES: Record<string, Fixture> = {
  forWorkspace: { skip: "factory — returns a workspace-bound client, issues no HTTP call itself" },
  withObservation: {
    skip: "factory — returns an observation-bound client, issues no HTTP call itself",
  },
  withTimeout: { skip: "factory — returns a client with its own timeout, issues no HTTP call itself" },
  recall: [{ query: "x" }],
  remember: [{ statement: "x" }],
  suggestTopicKey: [{ subject: "x" }],
  compareFacts: [{ factIdA: "fact_1", factIdB: "fact_2" }],
  createFact: [{ content: "x", attribution: {}, tags: [] }],
  getFact: ["fact_1"],
  pinFact: ["fact_1"],
  unpinFact: ["fact_1"],
  forgetFact: ["fact_1"],
  // P72 — POST /facts/:id/relocate
  relocateFact: ["fact_1", "22222222-2222-4222-8222-222222222222"],
  forgetPrimitive: ["task", "task_1"],
  timeline: [{}],
  health: [],
  healthReady: [],
  request: { skip: "generic escape hatch — the route is caller-supplied, not intrinsic" },
  getMe: [],
  listWorkspacesForCurrentTenant: [],
  listMyWorkspaces: [],
  listWorkspaceMembers: ["ws_1"],
  getWorkspaceById: ["ws_1"],
  createWorkspace: ["tenant_1", { name: "x" }],
  inviteWorkspaceMember: ["ws_1", { userId: "user_1" }],
  removeWorkspaceMember: ["ws_1", "user_1"],
  updateWorkspaceMemberRole: ["ws_1", "user_1", "read"],
  listWorkspacesForTenant: ["tenant_1"],
  createTenant: [{ name: "x" }],
  getTenant: ["tenant_1"],
  listTenantMembers: ["tenant_1"],
  inviteTenantMember: ["tenant_1", { userId: "user_1" }],
  removeTenantMember: ["tenant_1", "user_1"],
  createUser: [{ email: "a@example.com" }],
  createUserToken: ["tenant_1", "user_1", {}],
  listUserTokens: ["tenant_1", "user_1"],
  revokeUserToken: ["tenant_1", "user_1", "key_1"],
  doctor: [],
  getStats: [],
  graph: [{}],
  graphTraverse: [{ root: "entity_1" }],
  relationsTraverse: [{ rootId: "fact_1", rootKind: "fact" }],
  graphPath: [{ from: "entity_1", to: "entity_2" }],
  listEntities: [{}],
  getEntity: ["entity_1"],
  listEntityFacts: ["entity_1", {}],
  listEpisodes: [{}],
  getEpisode: ["episode_1"],
  getEpisodeTimeline: ["episode_1"],
  createEntity: [{ name: "x", kind: "person", aliases: [] }],
  updateEntity: ["entity_1", { name: "x" }],
  linkEntityUser: ["entity_1", { userId: "user_1" }],
  unlinkEntityUser: ["entity_1"],
  listReview: [{}],
  reviewCount: [],
  resolveReview: ["review_1", { resolvedBy: "user_1", resolution: "kept" }],
  audit: [{}],
  exportWorkspace: [],
  restoreFact: ["fact_1"],
  listDecisions: [{}],
  getDecision: ["decision_1"],
  listFacts: [{}],
  patchFact: ["fact_1", {}],
  getFactCitations: ["fact_1"],
  createDecision: [{ kind: "decision", title: "x", body: "x" }],
  supersedeDecision: ["decision_1", { supersededById: "decision_2" }],
  listRelations: [{}],
  createRelation: [
    {
      sourceKind: "fact",
      sourceId: "fact_1",
      targetKind: "fact",
      targetId: "fact_2",
      relation: "related",
      markedByKind: "agent",
    },
  ],
  patchRelation: ["relation_1", { relation: "related", markedByKind: "agent" }],
  closeRelation: ["relation_1"],
  listCitations: [{}],
  enqueueReview: [{ factId: "fact_1", reason: "manual" }],
  createReminder: [{ content: "x", condition: "x" }],
  listReminders: [{}],
  dismissReminder: ["reminder_1"],
  createSession: [{}],
  collapseSession: ["session_1", {}],
  appendTurn: ["session_1", { role: "user", content: "x" }],
  pinSessionTurn: ["session_1", { turnId: "turn_1", pinned: true }],
  sessionFeedback: ["session_1", "up"],
  getSession: ["session_1"],
  listSessions: [],
  updateSessionScratch: ["session_1", {}],
  discardSession: ["session_1"],
  triggerConsolidation: [{}],
  listTasks: [{}],
  createTask: [{ title: "x", assignedTo: "agent_1" }],
  getTask: ["task_1"],
  patchTask: ["task_1", {}],
  archiveTask: ["task_1"],
  listEvents: [{}],
  createEvent: [
    {
      type: "system",
      name: "x",
      description: "x",
      occurredAt: "2024-01-01T00:00:00Z",
      source: "x",
    },
  ],
  getEvent: ["event_1"],
  archiveEvent: ["event_1"],
  annotateEvent: ["event_1", { author: "x", content: "x" }],
  updateEventSensitivity: ["event_1", { sensitivity: "internal" }],
  listWorkflows: [{}],
  createWorkflow: [{ name: "x", steps: [] }],
  getWorkflow: ["workflow_1"],
  updateWorkflow: ["workflow_1", { status: "deprecated" }],
  listReasoning: [{}],
  createReasoning: [{ question: "x", chain: [], conclusion: "x" }],
  getReasoning: ["reasoning_1"],
  patchReasoning: ["reasoning_1", {}],
  archiveReasoning: ["reasoning_1"],
  resolveReasoning: [{ query: "x" }],
  recordReasoning: [{ question: "x", chain: [], conclusion: "x" }],
  reasoningFeedback: [{ reasoning_id: "reasoning_1", outcome: "success" }],
  listStrategies: [{}],
  createStrategy: [{ trigger: "x", action: "x" }],
  getStrategy: ["strategy_1"],
  patchStrategy: ["strategy_1", {}],
  archiveStrategy: ["strategy_1"],
  rateStrategy: ["strategy_1", "success"],
  listHyperedges: [{}],
  createHyperedge: [{ memberIds: ["fact_1", "fact_2", "fact_3"] }],
  getHyperedge: ["hyperedge_1"],
  patchHyperedge: ["hyperedge_1", {}],
  archiveHyperedge: ["hyperedge_1"],
  getSelfModel: [{}],
  getAnticipationFeed: [{}],
  selfEdit: [{ action: "reflect", target: "profile", reason: "x" }],
  selfReflect: [{}],
  getSelfProfile: [],
  listFederationPeers: [],
  createFederationPeer: [{}],
  listPendingFederationPeers: [],
  approveFederationPeer: ["peer_1", {}],
  approveFederationPeerKey: ["peer_1", {}],
  deleteFederationPeer: ["peer_1"],
  listFederationItems: [{}],
  triggerFederationSync: [{}],
  getFederationSyncJob: ["job_1"],
  resolveFederationConflict: [{}],
  judge: [{}],
  resolveConflict: ["relation_1", { action: "keep_both" }],
  subscribe: { skip: "opens a raw WebSocket connection — not an HTTP fetch call" },
  capture: [{ content: "x", source: "x" }],
  purgeFact: ["fact_1"],
  purgeClosedFacts: [],
  eraseSubject: [{ actorId: "key:key_1", confirm: "key:key_1" }],
  listKeys: [{}],
  createKey: [{ label: "x" }],
  getKey: ["key_1"],
  revokeKey: ["key_1"],
  rotateKey: ["key_1"],
  issueScopedKey: [{ scopes: ["memory:read"] }],
  rotateScopedKey: ["mk_live_key1"],
  revokeScopedKey: ["mk_live_key1"],
  listAgentPolicies: [],
  getAgentPolicy: ["key_1"],
  putAgentPolicy: [{ agentId: "key_1" }],
  deleteAgentPolicy: ["key_1"],
  createSkill: [{ name: "x", promptTemplate: "x" }],
  listSkills: [{}],
  getSkill: ["skill_1"],
  updateSkill: ["skill_1", { name: "x" }],
  delegateTask: ["task_1", { assignedTo: "agent_1" }],
  createGrpcTransport: {
    skip: "always throws — the optional @connectrpc/connect peer dep is not installed",
  },
};

/** `client.composition` returns a fresh object of methods on every access. */
const COMPOSITION_FIXTURES: Record<string, unknown[]> = {
  listRules: [{}],
  listInferences: [{}],
  createRule: [{ name: "x", conditionDsl: {}, actionDsl: {} }],
  getRule: ["rule_1"],
  patchRule: ["rule_1", {}],
  dryRun: [{ hits: [] }],
};

/** `client.sessions` is a thin wrapper over already-covered flat methods. */
const SESSIONS_FIXTURES: Record<string, unknown[]> = {
  create: [],
  addTurn: ["session_1", { role: "user", content: "x" }],
  pinTurn: ["session_1", { turnId: "turn_1", pinned: true }],
  collapse: ["session_1"],
  feedback: ["session_1", "up"],
};

function ownMethodNames(proto: object): string[] {
  return Object.getOwnPropertyNames(proto).filter((name) => {
    if (name === "constructor") return false;
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    return typeof desc?.value === "function";
  });
}

function getterNames(proto: object): string[] {
  return Object.getOwnPropertyNames(proto).filter((name) => {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    return typeof desc?.get === "function";
  });
}

describe("SDK method -> route map (B1.2 SDK half)", () => {
  it("has a fixture (or explicit skip) for every prototype method", () => {
    const methods = ownMethodNames(MnemosyneClient.prototype);
    const missing = methods.filter((m) => !(m in ARG_FIXTURES));
    expect(missing).toEqual([]);
  });

  it("has exactly the two known namespace getters", () => {
    expect(getterNames(MnemosyneClient.prototype).sort()).toEqual(["composition", "sessions"]);
  });

  it("records the route each non-skipped method and namespace method calls", async () => {
    const { fetchImpl, calls } = makeRecordingFetch();
    const client = new MnemosyneClient({
      url: "http://localhost:9999",
      apiKey: "mns_live_sdkroutemaptestkey00001",
      fetch: fetchImpl,
    });

    const routeMap: Record<string, RecordedCall[]> = {};
    const noCallRecorded: string[] = [];

    for (const name of ownMethodNames(MnemosyneClient.prototype)) {
      const fixture = ARG_FIXTURES[name];
      if (fixture === undefined) continue; // reported by the completeness guard above
      if (!Array.isArray(fixture)) continue; // explicit skip — no HTTP call to record
      calls.length = 0;
      const fn = (client as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
      await fn.apply(client, fixture);
      if (calls.length === 0) noCallRecorded.push(name);
      routeMap[name] = [...calls];
    }

    for (const [ns, fixtures] of [
      ["composition", COMPOSITION_FIXTURES],
      ["sessions", SESSIONS_FIXTURES],
    ] as const) {
      const namespace = (
        client as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>
      )[ns]!;
      for (const [method, args] of Object.entries(fixtures)) {
        calls.length = 0;
        await namespace[method]!(...(args as unknown[]));
        const key = `${ns}.${method}`;
        if (calls.length === 0) noCallRecorded.push(key);
        routeMap[key] = [...calls];
      }
    }

    // Methods whose entire contract is "no call happens for this fixture"
    // never legitimately belong here — every entry in ARG_FIXTURES/the
    // namespace tables is expected to reach at least one fetch call.
    expect(noCallRecorded).toEqual([]);

    const sortedKeys = Object.keys(routeMap).sort();
    const sorted: Record<string, RecordedCall[]> = {};
    for (const key of sortedKeys) sorted[key] = routeMap[key]!;

    await expect(JSON.stringify(sorted, null, 2) + "\n").toMatchFileSnapshot(
      "./sdk-routes.snapshot.json"
    );
  });
});
