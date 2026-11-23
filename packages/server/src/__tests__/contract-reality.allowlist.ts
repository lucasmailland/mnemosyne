/**
 * EXPECTED_DIVERGENCES — the contract-reality audit's allowlist (B2.2, Req 12).
 *
 * Mirrors `api-path-truth.allowlist.ts`'s own pattern from Chain A: one
 * reviewed entry per accepted gap, with a stated reason. Any set-difference
 * finding NOT covered by an entry of the matching `kind` here FAILS the test
 * in `contract-reality.test.ts` — this is a regression guard against the
 * exact class of bug this whole change exists to catch (a caller silently
 * invoking a route that doesn't exist — Chain A's stale-version-prefix
 * bug class, e.g. the old `export/jsonl` call site), applied to contract
 * SHAPE instead of the `/v1` string.
 *
 * Unlike A5's `unswept` entries (temporary, deleted once a sweep PR lands),
 * every entry here is a considered, permanent classification: either the gap
 * is legitimate by design (an ops probe, a control-plane route intentionally
 * outside the data-plane API contract), or it is a genuine finding this
 * change deliberately does NOT fix inline (per design.md B0: "a finding
 * requiring redesign is not force-fixed inline") — those are marked
 * explicitly below and reported to the orchestrator as findings, not
 * silently accepted as fine.
 *
 * Each entry groups every key it covers under one reviewed reason, rather
 * than repeating the same reason once per key.
 */

export type DivergenceKind = "phantom" | "undocumented" | "ghost-caller" | "unreachable";

export interface Divergence {
  kind: DivergenceKind;
  /**
   * `"METHOD path"` for phantom/undocumented/unreachable (Hono colon-style
   * path template), or `"source:key METHOD /concrete/path"` for ghost-caller
   * (see `contract-reality.ts`'s `flattenCallerSnapshot`/`diffGhostAndUnreachable`).
   */
  keys: readonly string[];
  reason: string;
}

export const EXPECTED_DIVERGENCES: readonly Divergence[] = [
  // ── undocumented: root-mounted spec-exact aliases (app.ts "T6.6") ─────────
  // Registered directly on the root Hono app BEFORE app.route("/", v1), as
  // thin forwarding shims to a canonical route. The canonical target IS
  // documented in the OpenAPI spec; the alias itself is a distinct Hono
  // registration and was never meant to carry its own spec entry.
  {
    kind: "undocumented",
    keys: [
      "DELETE /sessions/:id",
      "GET /entities/:id/graph",
      "POST /admin/consolidate",
      "POST /admin/export",
      "POST /admin/import",
      "GET /sessions",
      "POST /sessions",
      "POST /sessions/:id/turns",
    ],
    reason:
      'Root-mounted spec-exact alias (app.ts "T6.6"), a thin forwarding shim to a canonical route that IS documented in the OpenAPI spec. The alias is a separate Hono registration and was never meant to carry its own spec entry.',
  },
  // ── undocumented: ops/infra probes + the docs system's own meta-routes ────
  {
    kind: "undocumented",
    keys: [
      "GET /canary/slo-gate",
      "GET /dashboard",
      "GET /docs",
      "GET /health/deep",
      "GET /health/live",
      "GET /health/ready",
      "GET /healthz",
      "GET /metrics",
      "GET /metrics/prometheus",
      "GET /openapi.json",
      "GET /readyz",
    ],
    reason:
      "Operational liveness/readiness probe or infra scrape endpoint (app.ts: several are mounted before the /v1 router with no auth, by design), or a self-referential meta-route of the OpenAPI/docs system itself (/openapi.json, /docs, /dashboard) — documenting these in their own generated spec would be circular. Intentionally outside the versioned data-plane API contract.",
  },
  // ── undocumented: approvals / break-glass control plane ───────────────────
  {
    kind: "undocumented",
    keys: [
      "GET /approvals/:id",
      "POST /approvals/:id/resolve",
      "POST /break-glass",
      "GET /break-glass/:id",
      "POST /break-glass/:id/approve",
    ],
    reason:
      "Control-plane approval/break-glass routes — rbac-policy.ts:175 intentionally exempts /approvals/* from the standard RBAC/scope surface (control-plane, not data-plane); these were never part of the documented data-plane API contract.",
  },
  // ── undocumented + unreachable: orphaned routes — GENUINE GAP ─────────────
  {
    kind: "undocumented",
    keys: ["GET /cost", "GET /usage"],
    reason:
      "GENUINE GAP (not fixed here): both are real, working, authenticated routes (cost.ts's per-workspace unit-economics summary; usage.ts's month-to-date usage) with no OpenAPI entry AND no caller in any of the 3 audited client surfaces (also appear in the unreachable list below) — orphaned server-only surface. Flagged as a follow-up finding.",
  },
  {
    kind: "undocumented",
    keys: ["POST /admin/harness/quiesce"],
    reason:
      "Operator rollback control: fences workspace ingestion and reports live leases before a managed-lifecycle rollback. Deliberately kept out of the public OpenAPI surface, like the other /admin control-plane routes, and driven by an operator rather than a first-party client.",
  },
  {
    kind: "undocumented",
    keys: ["POST /harness/v1/events", "POST /harness/v1/probe"],
    reason:
      "Host harness transport routes consume raw request bytes for protocol-level size validation, so they deliberately bypass OpenAPI body parsing; first-party delivery clients arrive in later harness tasks.",
  },

  // ── unreachable: the same alias/ops/federation/approvals/self/cost-usage
  // routes above are also, by construction, never reached by any MCP tool,
  // CLI command, or SDK method — first-party clients call the canonical
  // route instead of the alias, or never call operator/control-plane routes
  // at all. Same reasons as the matching `undocumented` entries above.
  {
    kind: "unreachable",
    keys: [
      "DELETE /sessions/:id",
      "GET /entities/:id/graph",
      "POST /admin/consolidate",
      "POST /admin/export",
      "POST /admin/import",
      "GET /sessions",
      "POST /sessions",
      "POST /sessions/:id/turns",
    ],
    reason:
      "Spec-exact alias (see matching `undocumented` entry) — first-party clients call the canonical route the alias forwards to, never the alias path itself.",
  },
  {
    kind: "unreachable",
    keys: [
      "GET /canary/slo-gate",
      "GET /dashboard",
      "GET /docs",
      "GET /health/deep",
      "GET /health/live",
      "GET /healthz",
      "GET /metrics",
      "GET /metrics/prometheus",
      "GET /openapi.json",
      "GET /readyz",
    ],
    reason:
      "Ops/infra probe or docs-system meta-route (see matching `undocumented` entry) — exercised by monitoring/browser, not by an MCP tool, CLI command, or SDK method.",
  },
  {
    kind: "unreachable",
    keys: [
      "GET /approvals/:id",
      "POST /approvals/:id/resolve",
      "POST /break-glass",
      "GET /break-glass/:id",
      "POST /break-glass/:id/approve",
    ],
    reason:
      "Control-plane approval/break-glass routes (see matching `undocumented` entry) — no first-party client surface exposes these; used only via direct HTTP by an operator/admin.",
  },
  {
    kind: "unreachable",
    keys: ["GET /cost", "GET /usage"],
    reason: "GENUINE GAP — see the matching `undocumented` entry above.",
  },
  {
    kind: "unreachable",
    keys: ["POST /admin/harness/quiesce"],
    reason:
      "Invoked by an operator during a rollback rehearsal, not by any MCP tool, CLI command or SDK method.",
  },
  {
    kind: "unreachable",
    keys: ["POST /harness/v1/events", "POST /harness/v1/probe"],
    reason:
      "Task 4 exposes the server transport before the local harness delivery and CLI probe callers introduced by later approved tasks.",
  },
  // ── unreachable: documented routes with no client wrapper yet ─────────────
  // These ARE in the OpenAPI spec (confirmed absent from the `undocumented`
  // list above) — this is exactly the "informational, feeds B3's coverage
  // target" case design.md calls out, not a doc gap. Recorded here so the
  // guard stays green; each becomes a `COVERAGE` entry (or explicit `skip`)
  // in B3/B4, not remediated in this change.
  {
    kind: "unreachable",
    keys: [
      "DELETE /admin/config/retention",
      "GET /admin/config/llm",
      "GET /admin/config/retention",
      "PUT /admin/config/llm",
      "PUT /admin/config/retention",
      "DELETE /config/llm",
      "GET /config/llm",
      "PUT /config/llm",
      "DELETE /config/retention",
      "GET /config/retention",
      "PUT /config/retention",
    ],
    reason:
      "Documented workspace-config routes (LLM/retention config, both the /admin/config/* and /config/* aliases) with no SDK/CLI/MCP wrapper yet — informational, feeds B3/B4's coverage-fill-in target per design.md B2 (unreachable routes are informational, not a violation).",
  },
  {
    kind: "unreachable",
    keys: ["GET /governance/drift", "GET /governance/worth", "POST /governance/gate"],
    reason: "Documented governance routes with no client wrapper yet — informational, feeds B3/B4.",
  },
  {
    kind: "unreachable",
    keys: [
      "GET /procedural/prompt/:agent",
      "GET /procedural/versions/:agent",
      "POST /procedural/optimize",
    ],
    reason:
      "Documented procedural-memory routes with no client wrapper yet — informational, feeds B3/B4.",
  },
  {
    kind: "unreachable",
    keys: [
      "DELETE /webhooks/:id",
      "GET /webhooks",
      "GET /webhooks/:id",
      "GET /webhooks/:id/deliveries",
      "PATCH /webhooks/:id",
      "POST /webhooks",
      "POST /webhooks/:id/test",
    ],
    reason:
      "Documented webhook-management routes with no client wrapper yet — informational, feeds B3/B4.",
  },
  {
    kind: "unreachable",
    keys: ["GET /workspace-mode", "PUT /workspace-mode"],
    reason:
      "Documented workspace-mode routes with no client wrapper yet — informational, feeds B3/B4.",
  },
  {
    kind: "unreachable",
    keys: ["GET /timeline/counts"],
    reason:
      "Documented decision-event counts the dashboard's Home reads through /dashboard/api; no SDK/CLI/MCP wrapper (GET /timeline lists the same events) — informational.",
  },
  {
    kind: "unreachable",
    keys: [
      "GET /audit/stats",
      "GET /facts/stats",
      "GET /graph/stats",
      "GET /health/snapshots",
      "GET /me/activity",
      "GET /recall/metrics",
      "GET /session/stats",
    ],
    reason:
      "Dashboard aggregates (live facts by kind/sensitivity/memory type, recall calls per day, graph counts, sessions per day, health snapshots, undo log per day, own activity) that the dashboard rooms read through /dashboard/api; no SDK/CLI/MCP wrapper — informational.",
  },
  {
    kind: "unreachable",
    keys: ["POST /admin/graph/semantic-backfill"],
    reason:
      "Documented one-off admin graph-backfill route with no client wrapper — an operator-triggered maintenance action, informational.",
  },
  {
    kind: "unreachable",
    keys: ["POST /episodes"],
    reason:
      "Documented episode-creation route; the SDK/CLI/MCP surfaces only read episodes (get/list/timeline), none creates one directly — informational, feeds B3/B4.",
  },
  {
    kind: "unreachable",
    keys: ["POST /export"],
    reason:
      "export.ts registers /export for both GET (used — exportWorkspace) and POST; the POST variant has no client wrapper — informational, feeds B3/B4.",
  },
  {
    kind: "unreachable",
    keys: ["POST /recall/explain", "POST /recall/hot", "POST /recall/unified"],
    reason:
      "recallTiering.ts's newer recall-tiering routes (hot/unified/explain) have no SDK/CLI/MCP wrapper yet — informational, feeds B3/B4.",
  },
  {
    kind: "unreachable",
    keys: ["GET /memory/events"],
    reason:
      "Documented memory-events feed route with no client wrapper yet — informational, feeds B3/B4.",
  },
  {
    kind: "unreachable",
    keys: ["GET /users/me"],
    reason:
      "tenants.ts's GET /users/me (distinct from keys.ts's GET /me) has no client wrapper — informational, feeds B3/B4.",
  },
  {
    kind: "unreachable",
    keys: ["GET /health/cognitive", "GET /health/history"],
    reason:
      "Extra health-detail routes beyond the basic /health and /health/ready pair, with no client wrapper — informational, feeds B3/B4.",
  },
];
