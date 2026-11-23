/**
 * B3.2 — the coverage-enumeration guard's registry (design.md "B3. Full-surface
 * test coverage architecture", Req 13). B4.1 (design.md "B4. Coverage fill-in")
 * fills in the HTTP-route slice of this map — MCP tool[:action] and CLI
 * command decisions remain B4.2/B4.3's job and stay pending here.
 *
 * Same inversion as B1 (design.md, "you cannot auto-generate CLI inputs, but
 * you CAN auto-generate the obligation"): the sibling `coverage-guard.test.ts`
 * mechanically enumerates every real route (B1.1's `routeInventory`, read via
 * the committed `routes.snapshot.json`), every MCP tool[:action] (B1.2's
 * committed `tool-routes.snapshot.json`), and every CLI command (B1.3's
 * committed `command-routes.snapshot.json`) — that enumeration is never
 * hand-typed here. This file only holds the DECISIONS a human has actually
 * made about specific keys; everything with no decision recorded here
 * defaults to "pending" (still owed, not yet triaged).
 *
 * Three kinds of decision:
 *   - `covered` — B4 (or later) proved real live-surface coverage exists.
 *     `note` should point at the exercising test.
 *   - `skip` — a PERMANENT, considered exclusion: this key can never be
 *     safely exercised by an automated harness, regardless of server
 *     liveness (e.g. it mutates real host state). `reason` must justify why
 *     pointing the harness at a real server wouldn't change the answer.
 *   - (absent from `COVERAGE_OVERRIDES`) — "pending": the default. B4's job
 *     is to shrink this set, either by adding a `covered` entry (with a real
 *     test) or, more rarely, a genuinely permanent `skip` entry. A "pending"
 *     placeholder must NEVER be confused with `skip` — see CLAUDE.md-style
 *     lesson: "pending B4" is temporary incompleteness, not a deliberate
 *     exclusion.
 */

export interface CoveredEntry {
  readonly kind: "covered";
  /** Where the real exercise lives, e.g. "packages/mcp/src/__tests__/coverage-guard/routes-observability.integration.test.ts". */
  readonly note: string;
}

export interface SkippedEntry {
  readonly kind: "skip";
  /** Why this key can NEVER be safely exercised by this harness — not "not done yet". */
  readonly reason: string;
}

export type CoverageEntry = CoveredEntry | SkippedEntry;

/** `"METHOD /path"`, matching `routes.snapshot.json`'s own serialized format. */
export function routeKey(methodAndPath: string): string {
  return `route:${methodAndPath}`;
}

/** `"memory_tool"` or `"memory_tool:action"`, matching `tool-routes.snapshot.json`'s keys. */
export function mcpKey(toolOrAction: string): string {
  return `mcp:${toolOrAction}`;
}

/** Bare `COMMANDS` key (e.g. `"search"`), NOT the `"name (skipped)"` display suffix `command-routes.snapshot.json` uses. */
export function cliKey(command: string): string {
  return `cli:${command}`;
}

/**
 * Explicit, authored decisions only. Anything not listed here is "pending"
 * by default (see `resolveCoverage`) — that is the expected, honest state
 * for keys not yet triaged.
 *
 * The 4 CLI entries are carried forward verbatim from B1.3's own per-command
 * decision (`packages/cli/src/__tests__/command-route-map.test.ts`), which
 * already reviewed each command and found it unsafe to invoke from an
 * automated process (real host side effects) — that reasoning does not
 * change just because a live server is now available, so it is recorded
 * here as a PERMANENT skip, not a "pending B4" placeholder.
 *
 * B4.1 (this session) fills in every one of the 205 `route:*` keys —
 * 201 `covered` (a real live-surface test exercises it — see each `note`)
 * plus permanent `skip` entries. The federation routes a peer calls were
 * skipped because the peer gate read the service JWT from the same
 * `Authorization` header as the `mk_fed_` API key; the JWT now travels in
 * `x-mnemo-service-jwt`, and /items and /sync are covered by the two-server
 * test in packages/server (federation-pull.integration.test.ts). /resolve
 * stays a skip: it needs a second, signed server, which live-surface is not.
 * MCP tool[:action] and CLI command decisions remain B4.2/B4.3's job.
 */
export const COVERAGE_OVERRIDES: Record<string, CoverageEntry> = {
  "cli:harness": {
    kind: "skip",
    reason:
      "Operates on the real local capture queue under ~/.mnemo and never reaches the server, so a harness that drives the CLI against a live instance and asserts route coverage can never exercise it. Its dispatch, safety rules and exit codes are covered by packages/cli/src/__tests__/harness-commands.test.ts, and the queue behaviour underneath by the @mnemo-ai/harness suites.",
  },
  "cli:login": {
    kind: "skip",
    reason:
      "writes ~/.mnemo/config.json — real host side effect (carried forward from B1.3's command-route-map.test.ts; a live server does not change this)",
  },
  "cli:init": {
    kind: "skip",
    reason:
      "spawns docker, prompts on stdin, or hits a real cloud setup endpoint (carried forward from B1.3's command-route-map.test.ts; a live server does not change this)",
  },
  "cli:install": {
    kind: "skip",
    reason:
      "detects and mutates real installed-agent config directories on this host (carried forward from B1.3's command-route-map.test.ts; a live server does not change this)",
  },
  "cli:link": {
    kind: "skip",
    reason:
      "writes .mnemo.json into process.cwd() — real host side effect (carried forward from B1.3's command-route-map.test.ts; a live server does not change this)",
  },
  // P72 — the cross-workspace move. Both keys are covered by one file,
  // because the boundary they cross is the same one.
  [routeKey("POST /facts/:id/relocate")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relocate.integration.test.ts — full happy path against real Postgres: a user-bound key that is a write member of the target moves a fact, gets a NEW id back, and the original is confirmed closed in the source workspace",
  },
  [mcpKey("memory_relocate")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relocate.integration.test.ts — the tool is driven against the live stdio server and proven to reach POST /facts/:id/relocate and surface its rejection as a tool error. Stated plainly: the tool's HAPPY path is exercised through the same route with `secondaryIdentities.userA`, not through the MCP client, because the harness's MCP client is bound to a workspace-only key — precisely the identity the route must refuse. Giving the MCP client a user-bound key would change what the whole harness is testing.",
  },
  [routeKey("DELETE /admin/agent-policy")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-agent-policies.integration.test.ts",
  },
  [routeKey("GET /admin/agent-policies")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-agent-policies.integration.test.ts",
  },
  [routeKey("GET /admin/agent-policy")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-agent-policies.integration.test.ts",
  },
  [routeKey("PUT /admin/agent-policy")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-agent-policies.integration.test.ts",
  },
  [routeKey("DELETE /admin/config/retention")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-config.integration.test.ts",
  },
  [routeKey("DELETE /admin/keys/:keyId")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-admin-keys.integration.test.ts",
  },
  [routeKey("DELETE /config/llm")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-config.integration.test.ts",
  },
  [routeKey("DELETE /config/retention")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-config.integration.test.ts",
  },
  [routeKey("DELETE /entities/:id/link-user")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("DELETE /events/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-events-episodes.integration.test.ts",
  },
  [routeKey("DELETE /facts/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-audit-capture-workspace-mode.integration.test.ts",
  },
  [routeKey("DELETE /facts/:id/hard")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/purge-facts-hard-delete.integration.test.ts",
  },
  [routeKey("DELETE /facts/purge")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/purge-facts-hard-delete.integration.test.ts",
  },
  [routeKey("DELETE /forget/:kind/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("DELETE /hyperedges/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("DELETE /memory/federation/peers/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-federation.integration.test.ts",
  },
  [routeKey("DELETE /reasoning/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("DELETE /reminders/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-self-metacognition-procedural-governance.integration.test.ts",
  },
  [routeKey("DELETE /sessions/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("DELETE /strategies/:id")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/strategies.integration.test.ts",
  },
  [routeKey("DELETE /tasks/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("DELETE /tenants/:tenantId/members/:userId")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("DELETE /tenants/:tenantId/users/:userId/tokens/:keyId")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/user-token-provisioning.integration.test.ts",
  },
  [routeKey("DELETE /webhooks/:id")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/webhook-endpoint-schema.integration.test.ts",
  },
  [routeKey("DELETE /workspaces/:workspaceId/members/:userId")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("GET /admin/config/llm")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-config.integration.test.ts",
  },
  [routeKey("GET /admin/config/retention")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-config.integration.test.ts",
  },
  [routeKey("GET /admin/keys")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-admin-keys.integration.test.ts",
  },
  [routeKey("GET /admin/keys/:keyId")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-admin-keys.integration.test.ts",
  },
  [routeKey("GET /admin/stats")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/admin-stats.integration.test.ts",
  },
  [routeKey("GET /anticipation")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/anticipation-patterns.integration.test.ts",
  },
  [routeKey("GET /approvals/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-export-import-admin.integration.test.ts",
  },
  [routeKey("GET /audit")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-audit-capture-workspace-mode.integration.test.ts",
  },
  [routeKey("GET /break-glass/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("GET /canary/slo-gate")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-observability.integration.test.ts",
  },
  [routeKey("GET /citations")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("GET /composition/rules")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("GET /composition/rules/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("GET /config/llm")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-config.integration.test.ts",
  },
  [routeKey("GET /config/retention")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-config.integration.test.ts",
  },
  [routeKey("GET /conflicts")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/conflicts.integration.test.ts",
  },
  [routeKey("GET /cost")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-observability.integration.test.ts",
  },
  [routeKey("GET /dashboard")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-observability.integration.test.ts",
  },
  [routeKey("GET /decisions")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("GET /decisions/:id")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/decide-topic-key.integration.test.ts",
  },
  [routeKey("GET /docs")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-observability.integration.test.ts",
  },
  [routeKey("GET /doctor")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/doctor-nonsuperuser.integration.test.ts",
  },
  [routeKey("GET /entities")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/relate-entity.integration.test.ts",
  },
  [routeKey("GET /entities/:id")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/relate-entity.integration.test.ts",
  },
  [routeKey("GET /entities/:id/facts")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/relate-entity.integration.test.ts",
  },
  [routeKey("GET /entities/:id/graph")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-graph.integration.test.ts",
  },
  [routeKey("GET /episodes")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-events-episodes.integration.test.ts",
  },
  [routeKey("GET /episodes/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-events-episodes.integration.test.ts",
  },
  [routeKey("GET /episodes/:id/timeline")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-events-episodes.integration.test.ts",
  },
  [routeKey("GET /events")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-events-episodes.integration.test.ts",
  },
  [routeKey("GET /events/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-events-episodes.integration.test.ts",
  },
  [routeKey("GET /export")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-export-import-admin.integration.test.ts",
  },
  [routeKey("GET /export/jsonl")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-export-import-admin.integration.test.ts",
  },
  [routeKey("GET /facts")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/boot-nonsuperuser.integration.test.ts",
  },
  [routeKey("GET /facts/stats")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/aggregates.integration.test.ts",
  },
  [routeKey("GET /graph/stats")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/aggregates.integration.test.ts",
  },
  [routeKey("GET /facts/:id")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/api.integration.test.ts",
  },
  [routeKey("GET /facts/:id/citations")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("GET /governance/drift")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/admin-stats.integration.test.ts",
  },
  [routeKey("GET /governance/worth")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/api.integration.test.ts",
  },
  [routeKey("GET /graph")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-graph.integration.test.ts",
  },
  [routeKey("GET /graph/path")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-graph.integration.test.ts",
  },
  [routeKey("GET /graph/traverse")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-graph.integration.test.ts",
  },
  [routeKey("GET /health")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/admin-stats.integration.test.ts",
  },
  [routeKey("GET /health/cognitive")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-observability.integration.test.ts",
  },
  [routeKey("GET /health/deep")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-observability.integration.test.ts",
  },
  [routeKey("GET /health/history")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-observability.integration.test.ts",
  },
  [routeKey("GET /health/live")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-observability.integration.test.ts",
  },
  [routeKey("GET /health/ready")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-observability.integration.test.ts",
  },
  [routeKey("GET /healthz")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-observability.integration.test.ts",
  },
  [routeKey("GET /hyperedges")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("GET /hyperedges/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("GET /me")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/status-vitals-nonsuperuser.integration.test.ts",
  },
  [routeKey("GET /memory/events")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-events-episodes.integration.test.ts",
  },
  [routeKey("GET /memory/federation/peers")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-federation.integration.test.ts",
  },
  [routeKey("GET /memory/federation/peers/pending")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-federation.integration.test.ts",
  },
  [routeKey("GET /metacognition")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-self-metacognition-procedural-governance.integration.test.ts",
  },
  [routeKey("GET /metrics")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-observability.integration.test.ts",
  },
  [routeKey("GET /metrics/prometheus")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-observability.integration.test.ts",
  },
  [routeKey("GET /openapi.json")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-observability.integration.test.ts",
  },
  [routeKey("GET /procedural/prompt/:agent")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-self-metacognition-procedural-governance.integration.test.ts",
  },
  [routeKey("GET /procedural/versions/:agent")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-self-metacognition-procedural-governance.integration.test.ts",
  },
  [routeKey("GET /readyz")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-observability.integration.test.ts",
  },
  [routeKey("GET /reasoning")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("GET /reasoning/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("GET /relations")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/conflicts.integration.test.ts",
  },
  [routeKey("GET /reminders")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-self-metacognition-procedural-governance.integration.test.ts",
  },
  [routeKey("GET /review")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-self-metacognition-procedural-governance.integration.test.ts",
  },
  [routeKey("GET /review/count")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-self-metacognition-procedural-governance.integration.test.ts",
  },
  [routeKey("GET /self/profile")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-self-metacognition-procedural-governance.integration.test.ts",
  },
  [routeKey("GET /session/:id")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/session-label.integration.test.ts",
  },
  [routeKey("GET /session/list")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/session-label.integration.test.ts",
  },
  [routeKey("GET /sessions")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("GET /skills")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/skills-forget.integration.test.ts",
  },
  [routeKey("GET /skills/:id")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/skills-forget.integration.test.ts",
  },
  [routeKey("GET /strategies")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/strategies.integration.test.ts",
  },
  [routeKey("GET /strategies/:id")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/strategies.integration.test.ts",
  },
  [routeKey("GET /tasks")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("GET /tasks/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("GET /tenants/:tenantId")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("GET /tenants/:tenantId/members")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("GET /tenants/:tenantId/users/:userId/tokens")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("GET /tenants/:tenantId/workspaces")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("GET /audit/stats")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/aggregates.integration.test.ts",
  },
  [routeKey("GET /health/snapshots")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/aggregates.integration.test.ts",
  },
  [routeKey("GET /me/activity")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/aggregates.integration.test.ts",
  },
  [routeKey("GET /session/stats")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/aggregates.integration.test.ts",
  },
  [routeKey("GET /recall/metrics")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/aggregates.integration.test.ts",
  },
  [routeKey("GET /timeline")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/api.integration.test.ts",
  },
  [routeKey("GET /timeline/counts")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/timeline-counts.test.ts",
  },
  [routeKey("GET /usage")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-observability.integration.test.ts",
  },
  [routeKey("GET /users/me")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("GET /webhooks")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/webhook-endpoint-schema.integration.test.ts",
  },
  [routeKey("GET /webhooks/:id")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/webhook-endpoint-schema.integration.test.ts",
  },
  [routeKey("GET /webhooks/:id/deliveries")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("GET /workflows")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/workflows.integration.test.ts",
  },
  [routeKey("GET /workflows/:id")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/workflows.integration.test.ts",
  },
  [routeKey("GET /workspace-mode")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-audit-capture-workspace-mode.integration.test.ts",
  },
  [routeKey("GET /workspaces/:workspaceId")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("GET /workspaces/:workspaceId/members")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("GET /workspaces/mine")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/workspace-role-scopes.integration.test.ts",
  },
  [routeKey("PATCH /composition/rules/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("PATCH /decisions/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("PATCH /entities/:id")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/relate-entity.integration.test.ts",
  },
  [routeKey("PATCH /events/:id/sensitivity")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-events-episodes.integration.test.ts",
  },
  [routeKey("PATCH /facts/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("PATCH /hyperedges/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("PATCH /reasoning/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("PATCH /relations/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("PATCH /strategies/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("PATCH /tasks/:id")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("PATCH /webhooks/:id")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/webhook-endpoint-schema.integration.test.ts",
  },
  [routeKey("PATCH /workspaces/:workspaceId/members/:userId")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("POST /admin/consolidate")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-export-import-admin.integration.test.ts",
  },
  [routeKey("POST /admin/embedding-migrations")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-export-import-admin.integration.test.ts",
  },
  [routeKey("POST /admin/erasure")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/auth-gdpr.integration.test.ts",
  },
  [routeKey("POST /admin/export")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-export-import-admin.integration.test.ts",
  },
  [routeKey("POST /admin/graph/semantic-backfill")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-graph.integration.test.ts",
  },
  [routeKey("POST /admin/import")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-export-import-admin.integration.test.ts",
  },
  [routeKey("POST /admin/keys")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-admin-keys.integration.test.ts",
  },
  [routeKey("POST /admin/keys/:keyId/rotate")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-admin-keys.integration.test.ts",
  },
  [routeKey("POST /admin/scoped-keys")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/scoped-key-issuance.integration.test.ts",
  },
  [routeKey("POST /admin/scoped-keys/:id/rotate")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/scoped-key-issuance.integration.test.ts",
  },
  [routeKey("DELETE /admin/scoped-keys/:id")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/scoped-key-issuance.integration.test.ts",
  },
  [routeKey("POST /approvals/:id/resolve")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-export-import-admin.integration.test.ts",
  },
  [routeKey("POST /break-glass")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("POST /break-glass/:id/approve")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("POST /capture")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-audit-capture-workspace-mode.integration.test.ts",
  },
  [routeKey("POST /composition/dry-run")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("POST /composition/rules")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("POST /conflicts/:id/resolve")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/conflicts.integration.test.ts",
  },
  [routeKey("POST /consolidation/trigger")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-export-import-admin.integration.test.ts",
  },
  [routeKey("POST /decisions")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("POST /entities")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-graph.integration.test.ts",
  },
  [routeKey("POST /entities/:id/link-user")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("POST /episodes")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-events-episodes.integration.test.ts",
  },
  [routeKey("POST /events")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-events-episodes.integration.test.ts",
  },
  [routeKey("POST /events/:id/annotations")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-events-episodes.integration.test.ts",
  },
  [routeKey("POST /export")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-export-import-admin.integration.test.ts",
  },
  [routeKey("POST /facts/:id/pin")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/api.integration.test.ts",
  },
  [routeKey("POST /facts/:id/restore")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("POST /governance/gate")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-self-metacognition-procedural-governance.integration.test.ts",
  },
  [routeKey("POST /harness/v1/events")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/harness-route.integration.test.ts",
  },
  [routeKey("POST /harness/v1/probe")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/harness-route.integration.test.ts",
  },
  [routeKey("POST /hyperedges")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("POST /import")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-export-import-admin.integration.test.ts",
  },
  [routeKey("POST /memory/federation/peers")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-federation.integration.test.ts",
  },
  [routeKey("POST /memory/federation/peers/:id/approve")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-federation.integration.test.ts",
  },
  [routeKey("POST /memory/federation/peers/:id/approve-key")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-federation.integration.test.ts",
  },
  [routeKey("POST /procedural/optimize")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-self-metacognition-procedural-governance.integration.test.ts",
  },
  [routeKey("POST /reasoning")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("POST /reasoning/feedback")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("POST /reasoning/record")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("POST /reasoning/resolve")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-reasoning-hyperedges-composition.integration.test.ts",
  },
  [routeKey("POST /recall")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/api.integration.test.ts",
  },
  [routeKey("POST /recall/explain")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-recall-tiering-remember.integration.test.ts",
  },
  [routeKey("POST /recall/hot")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-recall-tiering-remember.integration.test.ts",
  },
  [routeKey("POST /recall/unified")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-recall-tiering-remember.integration.test.ts",
  },
  [routeKey("POST /relations")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("POST /relations/traverse")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/relate-entity.integration.test.ts",
  },
  [routeKey("POST /remember")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-recall-tiering-remember.integration.test.ts",
  },
  [routeKey("POST /reminders")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-self-metacognition-procedural-governance.integration.test.ts",
  },
  [routeKey("POST /review/:id/resolve")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-self-metacognition-procedural-governance.integration.test.ts",
  },
  [routeKey("POST /review/enqueue")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-self-metacognition-procedural-governance.integration.test.ts",
  },
  [routeKey("POST /self/edit")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-self-metacognition-procedural-governance.integration.test.ts",
  },
  [routeKey("POST /self/reflect")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-self-metacognition-procedural-governance.integration.test.ts",
  },
  [routeKey("POST /session/:id/collapse")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("POST /session/:id/discard")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("POST /session/:id/feedback")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("POST /session/:id/pin")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("POST /session/:id/scratch")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("POST /session/:id/turn")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("POST /session/start")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("POST /sessions")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("POST /sessions/:id/turns")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("POST /skills")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("POST /strategies")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("POST /strategies/:id/rate")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/strategies.integration.test.ts",
  },
  [routeKey("POST /tasks")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("POST /tasks/:id/delegate")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-sessions-tasks.integration.test.ts",
  },
  [routeKey("POST /tenants")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("POST /tenants/:tenantId/members")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("POST /tenants/:tenantId/users/:userId/tokens")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/user-token-provisioning.integration.test.ts",
  },
  [routeKey("POST /tenants/:tenantId/workspaces")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("POST /users")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("POST /webhooks")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("POST /webhooks/:id/test")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-primitives-extra.integration.test.ts",
  },
  [routeKey("POST /workflows")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/workflows.integration.test.ts",
  },
  [routeKey("POST /workspaces/:workspaceId/members")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-tenants-users-breakglass.integration.test.ts",
  },
  [routeKey("PUT /admin/config/llm")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-config.integration.test.ts",
  },
  [routeKey("PUT /admin/config/retention")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-config.integration.test.ts",
  },
  [routeKey("PUT /config/llm")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-config.integration.test.ts",
  },
  [routeKey("PUT /config/retention")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-config.integration.test.ts",
  },
  [routeKey("PUT /workspace-mode")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-audit-capture-workspace-mode.integration.test.ts",
  },
  [routeKey("GET /memory/federation/items")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/federation-pull.integration.test.ts (two real servers: B pulls from A through A's peer gate)",
  },
  [routeKey("POST /memory/federation/sync")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/federation-pull.integration.test.ts",
  },
  [routeKey("GET /memory/federation/sync/:jobId")]: {
    kind: "covered",
    note: "packages/server/src/__tests__/integration/federation-pull.integration.test.ts",
  },
  [routeKey("POST /memory/federation/resolve")]: {
    kind: "skip",
    reason:
      "peer-called federation route: needs a second server's signed request (mk_fed_ key + pinned key + service JWT). The live-surface harness is a single instance; the two-server protocol is exercised by packages/server/src/__tests__/integration/federation-pull.integration.test.ts on GET /memory/federation/items, which shares the same peer gate.",
  },

  // ── B4.2 (this session) — MCP tool[:action] coverage fill-in (Req 13). ──
  // 107/107 mcp:* obligations, all `covered` by real live-surface calls
  // through `surface.mcp` (the actual built MCP stdio server). No `skip`
  // entries were needed — every one of the 34 tools, including the six B2
  // flagged as genuinely unaudited (memory_workflow, memory_skill,
  // memory_doctor, memory_judge, memory_purge, memory_strategy), could be
  // safely exercised against the harness's throwaway workspace.
  [mcpKey("memory_anticipate")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-cognition.integration.test.ts",
  },
  [mcpKey("memory_compare")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-core-memory.integration.test.ts",
  },
  [mcpKey("memory_compose:create")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-cognition.integration.test.ts",
  },
  [mcpKey("memory_compose:dry_run")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-cognition.integration.test.ts",
  },
  [mcpKey("memory_compose:get")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-cognition.integration.test.ts",
  },
  [mcpKey("memory_compose:list")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-cognition.integration.test.ts",
  },
  [mcpKey("memory_compose:patch")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-cognition.integration.test.ts",
  },
  [mcpKey("memory_consolidate")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-admin-governance.integration.test.ts",
  },
  [mcpKey("memory_context")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-session-episode.integration.test.ts",
  },
  [mcpKey("memory_decide")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-core-memory.integration.test.ts",
  },
  [mcpKey("memory_doctor")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-admin-governance.integration.test.ts",
  },
  [mcpKey("memory_entity:create")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relations-graph.integration.test.ts",
  },
  [mcpKey("memory_entity:get")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relations-graph.integration.test.ts",
  },
  [mcpKey("memory_entity:link_user")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relations-graph.integration.test.ts",
  },
  [mcpKey("memory_entity:linked_facts")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relations-graph.integration.test.ts",
  },
  [mcpKey("memory_entity:list")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relations-graph.integration.test.ts",
  },
  [mcpKey("memory_entity:unlink_user")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relations-graph.integration.test.ts",
  },
  [mcpKey("memory_entity:update")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relations-graph.integration.test.ts",
  },
  [mcpKey("memory_episode_end")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-session-episode.integration.test.ts",
  },
  [mcpKey("memory_episode_start")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-session-episode.integration.test.ts",
  },
  [mcpKey("memory_event:annotate")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-task-event.integration.test.ts",
  },
  [mcpKey("memory_event:archive")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-task-event.integration.test.ts",
  },
  [mcpKey("memory_event:create")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-task-event.integration.test.ts",
  },
  [mcpKey("memory_event:get")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-task-event.integration.test.ts",
  },
  [mcpKey("memory_event:list")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-task-event.integration.test.ts",
  },
  [mcpKey("memory_event:sensitivity")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-task-event.integration.test.ts",
  },
  [mcpKey("memory_forget:fact")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-core-memory.integration.test.ts",
  },
  [mcpKey("memory_forget:task")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-core-memory.integration.test.ts",
  },
  [mcpKey("memory_hyperedge:archive")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relations-graph.integration.test.ts",
  },
  [mcpKey("memory_hyperedge:create")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relations-graph.integration.test.ts",
  },
  [mcpKey("memory_hyperedge:get")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relations-graph.integration.test.ts",
  },
  [mcpKey("memory_hyperedge:list")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relations-graph.integration.test.ts",
  },
  [mcpKey("memory_hyperedge:patch")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relations-graph.integration.test.ts",
  },
  [mcpKey("memory_introspect")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-cognition.integration.test.ts",
  },
  [mcpKey("memory_judge:list")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-admin-governance.integration.test.ts",
  },
  [mcpKey("memory_judge:resolve")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-admin-governance.integration.test.ts",
  },
  [mcpKey("memory_pin")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-core-memory.integration.test.ts",
  },
  [mcpKey("memory_purge:closed")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-admin-governance.integration.test.ts",
  },
  [mcpKey("memory_purge:fact")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-admin-governance.integration.test.ts",
  },
  [mcpKey("memory_reasoning:archive")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-reasoning-strategy.integration.test.ts",
  },
  [mcpKey("memory_reasoning:create")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-reasoning-strategy.integration.test.ts",
  },
  [mcpKey("memory_reasoning:feedback")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-reasoning-strategy.integration.test.ts",
  },
  [mcpKey("memory_reasoning:get")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-reasoning-strategy.integration.test.ts",
  },
  [mcpKey("memory_reasoning:list")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-reasoning-strategy.integration.test.ts",
  },
  [mcpKey("memory_reasoning:patch")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-reasoning-strategy.integration.test.ts",
  },
  [mcpKey("memory_reasoning:record")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-reasoning-strategy.integration.test.ts",
  },
  [mcpKey("memory_reasoning:resolve")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-reasoning-strategy.integration.test.ts",
  },
  [mcpKey("memory_recall")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-core-memory.integration.test.ts",
  },
  [mcpKey("memory_relate:create")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relations-graph.integration.test.ts",
  },
  [mcpKey("memory_relate:history")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relations-graph.integration.test.ts",
  },
  [mcpKey("memory_relate:list")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-relations-graph.integration.test.ts",
  },
  [mcpKey("memory_remember")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-core-memory.integration.test.ts",
  },
  [mcpKey("memory_remind_when:create")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_remind_when:dismiss")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_remind_when:list")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_search")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-core-memory.integration.test.ts",
  },
  [mcpKey("memory_self_edit:append")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_self_edit:forget")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_self_edit:link")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_self_edit:reflect")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_self_edit:replace")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_self_edit:strengthen")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_self_edit:weaken")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_session:collapse")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-session-episode.integration.test.ts",
  },
  [mcpKey("memory_session:discard")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-session-episode.integration.test.ts",
  },
  [mcpKey("memory_session:feedback")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-session-episode.integration.test.ts",
  },
  [mcpKey("memory_session:get")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-session-episode.integration.test.ts",
  },
  [mcpKey("memory_session:list")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-session-episode.integration.test.ts",
  },
  [mcpKey("memory_session:pin")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-session-episode.integration.test.ts",
  },
  [mcpKey("memory_session:pin_turn")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-session-episode.integration.test.ts",
  },
  [mcpKey("memory_session:scratch")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-session-episode.integration.test.ts",
  },
  [mcpKey("memory_session:start")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-session-episode.integration.test.ts",
  },
  [mcpKey("memory_session:turn")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-session-episode.integration.test.ts",
  },
  [mcpKey("memory_skill:create")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_skill:forget")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_skill:get")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_skill:list")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_stats")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-admin-governance.integration.test.ts",
  },
  [mcpKey("memory_status")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-admin-governance.integration.test.ts",
  },
  [mcpKey("memory_strategy:archive")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-reasoning-strategy.integration.test.ts",
  },
  [mcpKey("memory_strategy:create")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-reasoning-strategy.integration.test.ts",
  },
  [mcpKey("memory_strategy:get")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-reasoning-strategy.integration.test.ts",
  },
  [mcpKey("memory_strategy:list")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-reasoning-strategy.integration.test.ts",
  },
  [mcpKey("memory_strategy:patch")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-reasoning-strategy.integration.test.ts",
  },
  [mcpKey("memory_strategy:rate")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-reasoning-strategy.integration.test.ts",
  },
  [mcpKey("memory_strategy:recall")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-reasoning-strategy.integration.test.ts",
  },
  [mcpKey("memory_strategy:store")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-reasoning-strategy.integration.test.ts",
  },
  [mcpKey("memory_task:archive")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-task-event.integration.test.ts",
  },
  [mcpKey("memory_task:complete")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-task-event.integration.test.ts",
  },
  [mcpKey("memory_task:create")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-task-event.integration.test.ts",
  },
  [mcpKey("memory_task:delegate")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-task-event.integration.test.ts",
  },
  [mcpKey("memory_task:get")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-task-event.integration.test.ts",
  },
  [mcpKey("memory_task:list")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-task-event.integration.test.ts",
  },
  [mcpKey("memory_task:patch")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-task-event.integration.test.ts",
  },
  [mcpKey("memory_timeline")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-core-memory.integration.test.ts",
  },
  [mcpKey("memory_update")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-core-memory.integration.test.ts",
  },
  [mcpKey("memory_workflow:create")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_workflow:get")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_workflow:list")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-self-edit-remind-workflow-skill.integration.test.ts",
  },
  [mcpKey("memory_workspace:create")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-admin-governance.integration.test.ts",
  },
  [mcpKey("memory_workspace:current")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-admin-governance.integration.test.ts",
  },
  [mcpKey("memory_workspace:describe")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-admin-governance.integration.test.ts",
  },
  [mcpKey("memory_workspace:invite")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-admin-governance.integration.test.ts",
  },
  [mcpKey("memory_workspace:list")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-admin-governance.integration.test.ts",
  },
  [mcpKey("memory_workspace:members")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-admin-governance.integration.test.ts",
  },
  [mcpKey("memory_workspace:remove")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-admin-governance.integration.test.ts",
  },
  [mcpKey("memory_workspace:set_role")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/tools-admin-governance.integration.test.ts",
  },

  // ── B4.3 (this session) — CLI command coverage fill-in (Req 13). ──
  // 42/42 remaining cli:* obligations, all `covered` by real live-surface
  // calls through `surface.cli(...)` (the actual built `mnemo` binary as a
  // subprocess). Combined with B1.3's 4 permanent skips (login/init/
  // install/link — real host side effects), this closes out every one of
  // the 46 CLI commands and, with it, all of B4 (routes + tools + CLI).
  [cliKey("recall")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-core-crud.integration.test.ts",
  },
  [cliKey("remember")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-core-crud.integration.test.ts",
  },
  [cliKey("forget")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-core-crud.integration.test.ts",
  },
  [cliKey("list")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-core-crud.integration.test.ts",
  },
  [cliKey("search")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-core-crud.integration.test.ts",
  },
  [cliKey("show")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-core-crud.integration.test.ts",
  },
  [cliKey("pin")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-core-crud.integration.test.ts",
  },
  [cliKey("unpin")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-core-crud.integration.test.ts",
  },
  [cliKey("decide")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-primitives.integration.test.ts",
  },
  [cliKey("entity")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-primitives.integration.test.ts",
  },
  [cliKey("relate")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-primitives.integration.test.ts",
  },
  [cliKey("strategy")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-primitives.integration.test.ts",
  },
  [cliKey("workflow")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-primitives.integration.test.ts",
  },
  [cliKey("skill")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-primitives.integration.test.ts",
  },
  [cliKey("reasoning")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-primitives.integration.test.ts",
  },
  [cliKey("hyperedge")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-primitives.integration.test.ts",
  },
  [cliKey("sessions")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-session-task-event.integration.test.ts",
  },
  [cliKey("tasks")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-session-task-event.integration.test.ts",
  },
  [cliKey("events")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-session-task-event.integration.test.ts",
  },
  [cliKey("episode")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-session-task-event.integration.test.ts",
  },
  [cliKey("timeline")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-session-task-event.integration.test.ts",
  },
  [cliKey("health")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-admin-ops.integration.test.ts",
  },
  [cliKey("export")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-admin-ops.integration.test.ts",
  },
  [cliKey("import")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-admin-ops.integration.test.ts",
  },
  [cliKey("doctor")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-admin-ops.integration.test.ts",
  },
  [cliKey("keys")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-admin-ops.integration.test.ts",
  },
  [cliKey("policy")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/routes-agent-policies.integration.test.ts",
  },
  [cliKey("reset")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-admin-ops.integration.test.ts",
  },
  [cliKey("consolidate")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-admin-ops.integration.test.ts",
  },
  [cliKey("judge")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-admin-ops.integration.test.ts",
  },
  [cliKey("erase")]: {
    kind: "covered",
    note: "packages/cli/src/__tests__/primitive-parity.test.ts (request shape); route: packages/server/src/__tests__/integration/auth-gdpr.integration.test.ts",
  },
  [cliKey("purge")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-admin-ops.integration.test.ts",
  },
  [cliKey("remind")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-admin-ops.integration.test.ts",
  },
  [cliKey("workspace")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-tenant-workspace.integration.test.ts",
  },
  [cliKey("tenant")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-tenant-workspace.integration.test.ts",
  },
  [cliKey("user")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-tenant-workspace.integration.test.ts",
  },
  [cliKey("token")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-tenant-workspace.integration.test.ts",
  },
  [cliKey("info")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-tenant-workspace.integration.test.ts",
  },
  [cliKey("whoami")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-tenant-workspace.integration.test.ts",
  },
  [cliKey("config")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-local.integration.test.ts",
  },
  [cliKey("help")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-local.integration.test.ts",
  },
  [cliKey("status")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-local.integration.test.ts",
  },
  [cliKey("version")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-local.integration.test.ts",
  },
  [cliKey("completion")]: {
    kind: "covered",
    note: "packages/mcp/src/__tests__/coverage-guard/cli-local.integration.test.ts",
  },
};

export type CoverageStatus = "covered" | "skip" | "pending";

/** Resolves a key to its recorded decision, defaulting to `"pending"` when none has been made. */
export function resolveCoverage(key: string): CoverageStatus {
  return COVERAGE_OVERRIDES[key]?.kind ?? "pending";
}
