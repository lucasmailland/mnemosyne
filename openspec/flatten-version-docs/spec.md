# Flatten the `/v1` Version Noise — Specification

## Purpose

Defines the delta behavioral contract for removing every claim (executable
or documentary) that Mnemosyne's HTTP API is mounted under `/v1`, and for
guarding against regression. The real API has no URL-path version segment —
it is mounted at root (`packages/server/src/app.ts:577`,
`app.route("/", v1)`) and versioned solely via the `Mnemosyne-Version` date
header (`packages/server/src/versioning.ts`). This is strictly a
truth-correction pass: it does not touch architecture-generation labels
(v2/v3), the frozen `MEMORY_PROTOCOL_VERSION` constants, or third-party
`/api/v1/` paths (Prometheus, Loki) — those are different axes and are
explicit non-goals throughout this spec. Phase 2 (added by Pablo) extends
this into a systematic contract-reality audit, full-surface test coverage,
and a gated production deploy + verification of the corrected server.

---

## Capability: cli-export-import (Tier 0)

### Requirement 1: `cmdExport` and `cmdImport` request real, existing endpoints

`packages/cli/src/commands.ts`'s `cmdExport` (`:197`) and `cmdImport`
(`:243`) MUST issue their raw `fetch()` calls against the root-mounted path
(no `/v1` segment), matching what `packages/server/src/app.ts` actually
serves.

#### Scenario: Export reaches a real endpoint

- GIVEN a running Mnemosyne server mounted per `app.ts`
- WHEN `mnemo export` runs
- THEN the request path MUST NOT contain `/v1` and MUST receive a
  non-404 response

#### Scenario: Import reaches a real endpoint

- GIVEN a running Mnemosyne server
- WHEN `mnemo import` runs
- THEN the request path MUST NOT contain `/v1` and MUST receive a
  non-404 response

### Requirement 2: Both CLI commands are covered by full-path assertions

A substring match (e.g. `.toContain("/export/jsonl")`) passes against a
broken `/v1/export/jsonl` URL and MUST NOT be used. `cmdImport` currently
has zero test coverage.

#### Scenario: Export test asserts the complete path

- GIVEN `cli.test.ts` (or its successor) tests `cmdExport`
- WHEN the request URL is asserted
- THEN the assertion MUST check the full path string, not a substring,
  and MUST fail if `/v1` were reintroduced

#### Scenario: Import gains first-ever regression coverage

- GIVEN `cmdImport` has no existing test
- WHEN this change lands
- THEN at least one test MUST exercise `cmdImport` and assert its full
  request path

---

## Capability: load-testing (Tier 0)

### Requirement 3: k6 and server loadtest suites issue zero `/v1` requests

`packages/server/loadtest/run.ts` (`:51`, `:84`) and
`load/k6/{recall,remember,collapse,mixed}.js` (9 call sites total) MUST
request root-mounted paths.

#### Scenario: A full k6 run has no 404s from path mismatch

- GIVEN a k6 script from `load/k6/*.js` runs against a live server
- WHEN request paths are inspected
- THEN none MUST contain `/v1`, and none MUST 404 due to a stale prefix

#### Scenario: Server loadtest driver measures real latency

- GIVEN `packages/server/loadtest/run.ts` executes
- WHEN it issues requests
- THEN it MUST measure latency against real (non-404) endpoints

---

## Capability: api-documentation (Tier 1 + Tier 2 + Tier 3)

### Requirement 4: `docs/STATUS.md` states no `/v1` URL path exists

Line 611's "`/v1` URL path AND header coexist" claim is false and MUST be
corrected immediately. The rows certifying `cmdExport`/`cmdImport` as
verified-correct (~451–452, 530, 535) MUST be corrected only after
Requirement 1 lands (sequencing: fix code, then update status).

#### Scenario: Versioning mechanism row is accurate

- GIVEN `docs/STATUS.md` is read after this change
- WHEN the reconciliation section is checked
- THEN it MUST state only the `Mnemosyne-Version` header as the real
  mechanism, with no `/v1` URL-path claim

#### Scenario: CLI rows reflect the actual fixed code

- GIVEN Requirement 1 has landed
- WHEN `docs/STATUS.md`'s CLI export/import rows are read
- THEN they MUST certify the corrected (non-`/v1`) behavior, not the
  previously-broken one

### Requirement 5: README diagram, `<desc>`, and `alt` text are corrected together

`README.md:194`'s `alt` text and `.github/assets/session-pipeline.svg`'s
`<desc>` and three `<text>` nodes all currently show `/v1/...` paths. All
four MUST be corrected in the same change (accessibility parity: a
screen-reader user must not see stale paths that a sighted user no longer
sees).

#### Scenario: Rendered diagram shows root-mounted paths

- GIVEN `.github/assets/session-pipeline.svg` is rendered
- WHEN its visible `<text>` nodes are read
- THEN none MUST contain `/v1`

#### Scenario: Accessible text matches visible text

- GIVEN the SVG's `<desc>` and `README.md`'s `alt` attribute
- WHEN compared to the corrected `<text>` nodes
- THEN both MUST describe the same root-mounted paths, with no `/v1`
  remaining in either

### Requirement 6: CLI help text and `app.ts` comments are corrected

`commands.ts:3853`'s `mnemo --help` output and `app.ts:461`'s comment
describing a nonexistent `app.route('/v1', v1)` call MUST be corrected.

#### Scenario: Help output is truthful

- GIVEN `mnemo --help` is run
- WHEN its output is inspected
- THEN it MUST NOT contain `/v1`

#### Scenario: Source comment matches source code

- GIVEN `packages/server/src/app.ts` is read
- WHEN comments near the router mount are inspected
- THEN none MUST describe a `/v1`-prefixed route registration that does
  not exist in the file

### Requirement 7: Live Tier 1 architecture docs are corrected and versioning-coherent

Each live (non-frozen) Tier 1 doc — `docs/architecture/FEDERATION.md`,
`ARCHITECTURE_OVERVIEW.md`, `IDEMPOTENCY_STRATEGY.md`, `MCP_SESSION_TOOL.md`,
`docs/integration/SDK_INTEGRATION.md`, `docs/internals/OBSERVABILITY.md`,
`docs/internals/ALGORITHMS.md`, `docs/api/STABILITY.md`, package `README`s,
`load/README.md`, `packages/server/loadtest/README.md` — MUST have every
`/v1` path reference removed, AND (where that doc discusses API versioning
at all) MUST still correctly and completely describe the surviving
`Mnemosyne-Version` header mechanism afterward. Removing the false claim
MUST NOT leave a coherence gap where the doc says nothing about how the API
is actually versioned.

#### Scenario: `/v1` is gone from a Tier 1 doc

- GIVEN any doc in the Tier 1 list
- WHEN it is searched for `/v1`
- THEN zero matches MUST remain

#### Scenario: Versioning mechanism remains fully described

- GIVEN a Tier 1 doc that discussed versioning before this change (via the
  now-removed `/v1` claim)
- WHEN the doc is read after the `/v1` text is removed
- THEN it MUST still state that the API is versioned via the
  `Mnemosyne-Version` date header, with no residual gap

#### Scenario: A doc needing more than a one-line fix is surfaced, not force-fit

- GIVEN a Tier 1 doc whose coherence requires substantive rewording beyond
  removing `/v1` text
- WHEN the coherence review runs (last Tier 1 step, before Tier 2 starts)
- THEN that finding MUST be surfaced explicitly before the Tier 2
  mechanical sweep locks in the tier allowlist

### Requirement 8: Tier 2 in-source comments are swept, per package, mechanically

JSDoc/comment path references in `packages/server/src/routes/*.ts`,
`packages/mcp/src/tools/*.ts`, `packages/client-ts/src/client.ts`,
`packages/types/src/ports.ts`, `packages/server/src/{deps,grpc}.ts`, and
remaining `app.ts` comments MUST have `/v1` removed. This tier is gated
behind Tiers 0–1 and the Tier 5 guard landing first, and MAY ship as
independently reviewable per-package PRs.

#### Scenario: No `/v1` remains in swept packages

- GIVEN the Tier 2 sweep is complete for a given package boundary
  (`server/routes`, `mcp/tools`, `client-ts`, `types`+`cli`)
- WHEN that package is searched for `/v1/`
- THEN zero matches MUST remain outside the guard's Tier 3/4 allowlist

### Requirement 9: Tier 3 frozen-history content gets exactly one clarifying banner line, nothing else changes

`CHANGELOG.md`, `packages/server/CHANGELOG.md`, `docs/archive/audits/AUDIT_REPORT.md`,
`docs/archive/audits/2026-07-23-audit-report.md`,
`docs/archive/audits/AUDIT_SPEC_COVERAGE_2026-06.md`, and the four completion reports
(`API-2-COMPLETE.md`, `API-3-COMPLETION-REPORT.md`,
`API-5-8-COMPLETION-REPORT.md`, `OPS-1-COMPLETION-REPORT.md`) each get
exactly one added line clarifying that pre-2026-06-25 `/v1` mentions
predate the root remount. All other content MUST remain byte-identical.
`docs/architecture/API_PATHS.md` already carries a SUPERSEDED banner and
gets no additional line.

#### Scenario: Banner added, body untouched

- GIVEN a Tier 3 file before this change
- WHEN diffed against its state after this change
- THEN the diff MUST contain exactly one added line (the banner) and zero
  other changes

#### Scenario: `API_PATHS.md` is not double-bannered

- GIVEN `docs/architecture/API_PATHS.md` already has a SUPERSEDED banner
- WHEN this change is applied
- THEN the file MUST remain byte-identical to its pre-change state

### Requirement 10: Out-of-scope axes and third-party paths remain byte-identical

`packages/core/src/protocol/v1.ts` (protocol-version constants), all
architecture v2/v3 labels (e.g. `v3-purity.test.ts`, the "v3 zone"
convention, `@mnemo-ai/cup`), and third-party API paths
(`scripts/collect-soc2-evidence.sh:160`'s `/api/v1/query`,
`docker/scripts/promtail.yml:9`'s `/loki/api/v1/push`) MUST NOT be modified
by this change.

#### Scenario: Protocol constants are untouched

- GIVEN `packages/core/src/protocol/v1.ts` before this change
- WHEN diffed against its state after this change
- THEN the diff MUST be empty

#### Scenario: Third-party integration paths are untouched

- GIVEN `scripts/collect-soc2-evidence.sh` and
  `docker/scripts/promtail.yml`
- WHEN diffed against their pre-change state
- THEN both diffs MUST be empty

---

## Capability: api-path-truth-guard (Tier 5, new)

### Requirement 11: A vitest guard fails on any new `/v1/` outside the allowlist

A new guard test, following the existing convention
(`v3-purity.test.ts`, `migrations.test.ts`), MUST scan the repository and
fail when `/v1/` appears outside an explicit allowlist covering only Tier
3 (frozen history) and Tier 4 (third-party paths, e.g.
`/api/v1/query`, `/loki/api/v1/push`) content, and
`packages/core/src/protocol/v1.ts`. The allowlist MUST be strict — no
wildcard exemption for entire directories beyond the named Tier 3/4 files
and the protocol file.

#### Scenario: A newly introduced `/v1/` string fails the guard

- GIVEN the guard is in place
- WHEN a new file or edit introduces `/v1/` outside the allowlist
- THEN the guard test MUST fail with a message identifying the offending
  file and line

#### Scenario: Allowlisted content passes

- GIVEN Tier 3/4 files and the protocol version file
- WHEN the guard runs against the repository containing them unchanged
- THEN the guard MUST pass

#### Scenario: Guard ships before Tier 2 completes, with a temporary allowlist for unswept packages

- GIVEN the Tier 2 mechanical sweep has not yet reached every package
- WHEN the guard is introduced
- THEN it MUST include a temporary, explicitly-named allowlist entry per
  unswept package so it still blocks genuinely new regressions elsewhere
- AND each temporary entry MUST be removable once its package's Tier 2
  sweep lands

---

## Capability: contract-reality-audit (Phase 2, new)

### Requirement 12: The audit produces a concrete list of phantom, undocumented, and mismatched contracts

The audit MUST cross-reference, for every surface, and output a concrete
list (not a narrative) of findings:
(a) OpenAPI spec (`mountOpenApi` output) vs. registered Hono routes —
phantom (documented, not implemented) and undocumented (implemented, not
in the spec) endpoints;
(b) each of the 34 MCP tools' declared input schema/description vs. what
the server route it calls actually accepts/returns;
(c) each CLI command vs. the server route(s) it calls;
(d) `@mnemo-ai/client-ts` SDK methods vs. real routes.

#### Scenario: Phantom endpoint is flagged

- GIVEN a route documented in the OpenAPI spec with no matching registered
  Hono handler
- WHEN the audit runs
- THEN that route MUST appear in the audit's phantom-endpoint list

#### Scenario: Undocumented endpoint is flagged

- GIVEN a registered Hono route with no corresponding OpenAPI spec entry
- WHEN the audit runs
- THEN that route MUST appear in the audit's undocumented-endpoint list

#### Scenario: MCP tool / CLI / SDK contract mismatch is flagged

- GIVEN an MCP tool schema, CLI command, or SDK method whose claimed
  input/output shape differs from what its target route actually
  accepts/returns
- WHEN the audit runs
- THEN that mismatch MUST appear in the audit's output list with the
  specific field(s) that diverge

#### Scenario: A finding requiring redesign is not force-fixed inline

- GIVEN an audit finding whose correct resolution is a genuine design
  change, not a mechanical fix
- WHEN the audit's findings are reviewed
- THEN that finding MUST be recorded and split into a follow-up, not
  patched ad hoc within this change

---

## Capability: contract-test-coverage (Phase 2, new)

### Requirement 13: Every real HTTP route, all 34 MCP tools, and every CLI command are exercised against a real running server

Integration tests MUST exercise every real (non-phantom) HTTP route, all
34 registered MCP tools, and every CLI command against an actual running
Mnemosyne server (not mocked), asserting on the real response shape.

#### Scenario: A route with prior zero coverage is now tested

- GIVEN a real HTTP route with no prior integration test
- WHEN this change lands
- THEN at least one integration test MUST call it against a real server
  and assert on its actual response shape

#### Scenario: All 34 MCP tools are exercised

- GIVEN the 34 tools registered in `packages/mcp/src/registry.ts`
- WHEN the test suite runs
- THEN each of the 34 MUST be called at least once against a real running
  server, not a mock

#### Scenario: Every CLI command is exercised

- GIVEN the full set of `mnemo` CLI subcommands
- WHEN the test suite runs
- THEN each subcommand MUST be exercised against a real running server at
  least once

### Requirement 14: No MCP tool description or skill promises a nonexistent contract

Agent-facing surfaces (MCP tool descriptions, skills) MUST NOT describe a
capability, endpoint, or contract that the audit (Requirement 12) found to
be phantom or unimplemented.

#### Scenario: A tool description matches audited reality

- GIVEN the contract-reality audit's findings
- WHEN any MCP tool description or skill file is checked against those
  findings
- THEN it MUST NOT claim a capability the audit flagged as phantom or
  unimplemented

---

## Capability: deploy-verification (Phase 2, new)

### Requirement 15: Deploy follows the existing `docs/DEPLOYMENT.md` process and requires explicit human go-ahead

The corrected server MUST be deployed using the process already documented
in `docs/DEPLOYMENT.md` — no new deployment mechanism is introduced.
Deploy MUST NOT execute unattended; it requires an explicit go-ahead at
that point in implementation, even though it is a planned step in this
change.

#### Scenario: Deploy uses the existing documented process

- GIVEN Tiers 0–5 and the audit's required fixes are merged with green CI
- WHEN the deploy step runs
- THEN it MUST follow `docs/DEPLOYMENT.md`'s existing process with no new
  mechanism introduced

#### Scenario: Deploy does not proceed without explicit go-ahead

- GIVEN the deploy step is reached in the implementation plan
- WHEN no explicit human go-ahead has been given at that point
- THEN the deploy MUST NOT be triggered

### Requirement 16: Production verification re-runs the full test suite against the deployed instance using real clients

After deploy, the full endpoint/tool/CLI/MCP test suite from Requirement
13 MUST be re-run against the deployed instance, using real clients (CLI
binary, MCP stdio server, `client-ts`, direct HTTP) — not local mocks —
with results reported before the change is considered done.

#### Scenario: Post-deploy suite passes against the live instance

- GIVEN the server has been deployed per Requirement 15
- WHEN the full test suite from Requirement 13 is re-run against the
  deployed instance using real clients
- THEN results MUST be reported, and the change MUST NOT be considered
  complete until this run is reported

#### Scenario: A production-only regression is caught before sign-off

- GIVEN the deployed instance behaves differently from what was verified
  locally/in CI
- WHEN the post-deploy suite runs
- THEN the divergence MUST surface as a reported failure, not be silently
  accepted
