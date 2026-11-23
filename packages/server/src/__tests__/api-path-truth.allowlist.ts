/**
 * Allowlist data for the api-path-truth guard (A5, Req 11).
 *
 * The guard scans the repository for the literal `/v1/` (trailing slash
 * included) and fails on any occurrence outside this allowlist. Three kinds,
 * because the two out-of-scope tiers grow in opposite directions:
 *
 * - `frozen`   — Tier 3 sealed history. `expected` is an EXACT equality, not
 *                a ceiling: an over-count catches a new false `/v1/` slipping
 *                into frozen content; an under-count catches someone
 *                "cleaning" history that must stay byte-identical.
 * - `foreign`  — Tier 4 third-party versioned APIs (Prometheus, Loki). Scoped
 *                by a narrow `pattern`, never by a path-blanket allowance.
 * - `unswept`  — Tier 2 packages (or doc areas — see note below) not yet
 *                fully corrected. Temporary; each entry names the PR/task
 *                that removes it once its area is swept.
 *
 * Counts below reflect the repository state as of this PR (flatten-version-docs,
 * Chain A, A5). Re-pinning on drift is a one-line diff with a stated reason —
 * that friction is the feature (mirrors the design's Q4 on CHANGELOG.md
 * growth).
 */

export type Allowance =
  | {
      kind: "frozen";
      path: string; // repo-relative file, or prefix ending in "/"
      expected: number; // EXACT occurrence count of literal /v1/, pinned
      reason: string;
    }
  | {
      kind: "foreign";
      path: string; // repo-relative file the pattern is scoped to
      pattern: RegExp; // narrow — matches only the real third-party path(s)
      reason: string;
    }
  | {
      kind: "unswept";
      path: string; // repo-relative file, or prefix ending in "/"
      expected: number; // EXACT occurrence count, pinned at authoring time
      sweptBy: string; // the task/PR that removes this entry once complete
    };

export const ALLOWLIST: readonly Allowance[] = [
  // ── Out-of-scope axes (Req 10) ─────────────────────────────────────────
  {
    kind: "frozen",
    path: "docs/architecture/API.md",
    expected: 4,
    reason:
      'The oracle doc. All 4 occurrences are negation context ("not POST /v1/recall", ' +
      '"no /v1/ path prefix") — the truthful statement itself, not a bug.',
  },
  {
    kind: "frozen",
    path: "docs/architecture/API_PATHS.md",
    expected: 50,
    reason: "Already carries its own SUPERSEDED banner (Req 9) — byte-identical, no second banner.",
  },
  {
    kind: "frozen",
    path: "docs/architecture/API.es.md",
    expected: 4,
    reason: "Spanish sibling of API.md (docs-two-languages): the same 4 negation-context mentions.",
  },
  {
    kind: "frozen",
    path: "docs/architecture/API_PATHS.es.md",
    expected: 50,
    reason:
      "Spanish sibling of API_PATHS.md (docs-two-languages): same count, same SUPERSEDED banner.",
  },
  {
    kind: "foreign",
    path: "scripts/collect-soc2-evidence.sh",
    pattern: /\$\{PROMETHEUS_URL\}\/api\/v1\/query/,
    reason: "Real Prometheus HTTP API path, not ours.",
  },
  {
    kind: "foreign",
    path: "docker/scripts/promtail.yml",
    pattern: /loki:3100\/loki\/api\/v1\/push/,
    reason: "Real Loki push API path, not ours.",
  },
  {
    kind: "foreign",
    path: "docs/internals/OBSERVABILITY.md",
    pattern: /(prometheus:9090\/api\/v1\/write|loki:3100\/loki\/api\/v1\/push)/,
    reason: "Documents the same real Prometheus/Loki third-party paths.",
  },
  {
    kind: "foreign",
    path: "packages/server/src/routes/bootstrap.ts",
    pattern: /api\.openai\.com\/v1\/embeddings/,
    reason:
      "Real OpenAI HTTP API path (LLM key validation probe), not ours. Discovered during A6's sweep.",
  },
  {
    kind: "foreign",
    path: "packages/server/src/routes/bootstrap.ts",
    pattern: /api\.anthropic\.com\/v1\/messages/,
    reason:
      "Real Anthropic HTTP API path (LLM key validation probe), not ours. Discovered during A6's sweep.",
  },
  {
    kind: "foreign",
    path: "packages/server/src/telemetry/otel.ts",
    pattern: /\/v1\/traces/,
    reason:
      "Real OTLP/HTTP protocol receiver path (OpenTelemetry spec-mandated), not ours. Discovered during A7's sweep.",
  },

  // ── Tier 3: frozen history explicitly named by Req 9 ───────────────────
  {
    kind: "frozen",
    path: "CHANGELOG.md",
    expected: 25,
    reason: "release-please generated changelog; one clarifying banner added (Req 9), body frozen. 65 -> 25 when repeated release notes were removed (APP-065).",
  },
  {
    kind: "frozen",
    path: "packages/server/CHANGELOG.md",
    expected: 58,
    reason: "release-please generated changelog; one clarifying banner added (Req 9), body frozen.",
  },

  // ── Tier 3: A0's original re-census ─────────────────────────────────────
  {
    kind: "frozen",
    path: "packages/adapter-postgres/migrations/baseline/0019_session_label.sql",
    expected: 1,
    reason: "Applied migration (A0.2) — editing it changes its checksum. Never edit.",
  },
  {
    kind: "unswept",
    path: "openspec/flatten-version-docs/",
    expected: 71,
    sweptBy:
      "N/A — this change's own planning artifacts (A0.5). Growing by design; re-pin as this PR's own docs change. " +
      "Re-pinned 66→71 after Pablo's proposal.md edits during orchestration (added Phase 2 scope + resolved decisions).",
  },

  // ── Tier 3: discovered during A3's full-repo re-census (coherence-review.md, Gap 3) ──
  {
    kind: "frozen",
    path: "packages/core/CHANGELOG.md",
    expected: 23,
    reason:
      "release-please generated changelog — not named by Req 9, same character as the 2 it does name.",
  },
  {
    kind: "frozen",
    path: "packages/client-ts/CHANGELOG.md",
    expected: 8,
    reason:
      "release-please generated changelog — not named by Req 9, same character as the 2 it does name.",
  },
  {
    kind: "frozen",
    path: "packages/adapter-postgres/CHANGELOG.md",
    expected: 5,
    reason:
      "release-please generated changelog — not named by Req 9, same character as the 2 it does name.",
  },
  {
    kind: "frozen",
    path: "packages/adapter-vector/CHANGELOG.md",
    expected: 5,
    reason:
      "release-please generated changelog — not named by Req 9, same character as the 2 it does name.",
  },
  {
    kind: "frozen",
    path: "packages/mcp/CHANGELOG.md",
    expected: 2,
    reason:
      "release-please generated changelog — not named by Req 9, same character as the 2 it does name.",
  },

  // ── Gap 3 (coherence-review.md): un-triaged doc areas, tier not yet determined ──
  // Pinned at exact current count so the guard still blocks NEW regressions in
  // these files; each is independently removable once triaged (frozen vs. live).
  {
    kind: "unswept",
    path: "docs/compliance/data-residency.md",
    expected: 4,
    sweptBy: "A0b (follow-up triage census)",
  },
  {
    kind: "unswept",
    path: "docs/compliance/soc2-controls.md",
    expected: 1,
    sweptBy: "A0b (follow-up triage census)",
  },
  {
    kind: "unswept",
    path: "docs/architecture/CONSTRAINTS.md",
    expected: 1,
    sweptBy: "A0b (follow-up triage census)",
  },
  {
    kind: "unswept",
    path: "docs/internals/DOC_VERIFICATION.md",
    expected: 2,
    sweptBy: "A0b (follow-up triage census)",
  },
  {
    kind: "unswept",
    path: "docs/ops/gameday.md",
    expected: 2,
    sweptBy: "A0b (follow-up triage census)",
  },
  {
    kind: "unswept",
    path: "docs/ops/status-page.md",
    expected: 1,
    sweptBy: "A0b (follow-up triage census)",
  },
  {
    kind: "unswept",
    path: "docs/ops/runbooks/security_breach.md",
    expected: 1,
    sweptBy: "A0b (follow-up triage census)",
  },
  {
    kind: "unswept",
    path: "docs/deploy/OPERATIONS.md",
    expected: 1,
    sweptBy: "A0b (follow-up triage census)",
  },
  {
    kind: "unswept",
    path: "docs/deploy/OPERATIONS.es.md",
    expected: 1,
    sweptBy: "A0b (follow-up triage census)",
  },

  // The host harness wire protocol is independently versioned in its path.
  // These exact counts keep that approved exception narrow and reviewable.
  {
    kind: "frozen",
    path: "packages/harness/src/delivery.ts",
    expected: 1,
    reason:
      "The local queue posts to the approved host harness v1 transport path; same exception as the route that serves it.",
  },
  {
    kind: "frozen",
    path: "packages/server/src/routes/harness.ts",
    expected: 2,
    reason:
      "Approved host harness v1 transport paths; unrelated to the root API versioning scheme.",
  },
  {
    kind: "frozen",
    path: "packages/server/src/routes/__tests__/harness.test.ts",
    expected: 36,
    reason: "Behavioral tests for the approved host harness v1 transport paths.",
  },
  {
    kind: "frozen",
    path: "packages/server/src/routes/__tests__/admin-harness.test.ts",
    expected: 1,
    reason:
      "Asserts the RBAC scope mapping of the admin quiesce path that drains the approved host harness v1 transport.",
  },
  {
    kind: "frozen",
    path: "packages/server/src/app.ts",
    expected: 2,
    reason: "Exact generic-idempotency bypass for the approved host harness v1 transport paths.",
  },
  {
    kind: "frozen",
    path: "packages/server/src/__tests__/integration/harness-route.integration.test.ts",
    expected: 3,
    reason: "Real route/storage integration coverage for the approved host harness v1 transport.",
  },
  {
    kind: "frozen",
    path: "packages/harness/src/host-runtime.ts",
    expected: 1,
    reason:
      "The host runtime probes the approved host harness v1 transport before draining; same exception as the route that serves it.",
  },
  {
    kind: "frozen",
    path: "packages/cli/src/__tests__/harness-runtime.test.ts",
    expected: 2,
    reason:
      "The CLI end-to-end hook test serves the approved host harness v1 probe and events paths from a local mock.",
  },
  {
    kind: "frozen",
    path: "packages/server/src/app-scope.ts",
    expected: 1,
    reason: "Explicit key-scope mapping for the approved host harness v1 transport.",
  },
  {
    kind: "frozen",
    path: "packages/server/src/middleware/rbac-policy.ts",
    expected: 1,
    reason: "Explicit RBAC scope mapping for the approved host harness v1 transport.",
  },
  {
    kind: "frozen",
    path: "packages/server/src/__tests__/unit/scope-map.test.ts",
    expected: 2,
    reason: "RBAC scope assertions for the approved host harness v1 transport.",
  },
  {
    kind: "frozen",
    path: "packages/server/src/__tests__/unit/scope-matrix.test.ts",
    expected: 2,
    reason: "Key-scope assertions for the approved host harness v1 transport.",
  },
  {
    kind: "frozen",
    path: "packages/server/src/__tests__/contract-reality.allowlist.ts",
    expected: 4,
    reason: "Reviewed contract-reality entries for the approved host harness v1 transport.",
  },
  {
    kind: "frozen",
    path: "packages/server/src/__tests__/routes.snapshot.json",
    expected: 2,
    reason: "Executable route inventory entries for the approved host harness v1 transport.",
  },
  {
    kind: "frozen",
    path: "packages/mcp/src/__tests__/coverage-guard/registry.ts",
    expected: 2,
    reason: "Coverage decisions for the approved host harness v1 transport routes.",
  },
  {
    kind: "frozen",
    path: "docs/architecture/diagrams/05-harness-capture.html",
    expected: 4,
    reason: "Harness-capture diagram labels the approved host harness v1 transport path.",
  },
  {
    kind: "frozen",
    path: "docs/architecture/diagrams/src/05-harness-capture.dataflow.json",
    expected: 1,
    reason:
      "Source of the harness-capture diagram; names the approved host harness v1 transport path.",
  },

  // ── Comparative memory-systems research (2026-08-11) — third-party /v1/ APIs ──
  // These briefs quote OTHER systems' real REST APIs (Letta, mem0), which do
  // version with /v1/ — unrelated to Mnemosyne's own deprecated v1 (API.md/
  // API_PATHS.md above). Frozen: a completed comparative research artifact,
  // not a living doc that needs sweeping.

  // ── The guard's own implementation and test fixtures ───────────────────
  // These 4 files deliberately embed the pattern this guard scans for — in
  // fixture data (census.test.ts) and in prose/code describing the guard
  // itself (census.ts, allowlist.ts, test.ts). Not a documentary or
  // executable claim. Frozen: any change to these counts means the guard's
  // own content changed and should be reviewed, not silently re-pinned.
  // (Each is also covered by the broader "__tests__/" unswept entry above,
  // which independently includes these counts in its own total — the two
  // entries do not conflict; see api-path-truth.census.ts's matching logic.)
  {
    kind: "frozen",
    path: "packages/server/src/__tests__/api-path-truth.census.test.ts",
    expected: 18,
    reason: "Test fixtures demonstrating the guarded pattern itself, not a real claim.",
  },
  {
    kind: "frozen",
    path: "packages/server/src/__tests__/api-path-truth.census.ts",
    expected: 5,
    reason: "Prose/code describing the guarded pattern itself (the pattern constant and messages).",
  },
  {
    kind: "frozen",
    path: "packages/server/src/__tests__/api-path-truth.allowlist.ts",
    expected: 7,
    reason:
      "Prose describing the guarded pattern and citing real (allowed) examples in reason fields.",
  },
  {
    kind: "frozen",
    path: "packages/server/src/__tests__/api-path-truth.test.ts",
    expected: 3,
    reason: "Doc-comment describing the guarded pattern and the real mount point it verifies.",
  },
];
