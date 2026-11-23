# Proposal: Flatten the `/v1` version noise — stop the repo from documenting an API path that does not exist

## Intent

Mnemosyne's HTTP API has **no `/v1` path prefix**. Commit `6fa7820f` (2026-06-25,
"refactor: remove all v1/v2/v3 version labels from codebase") removed it and mounted
the router at the root — `packages/server/src/app.ts:577` is `app.route("/", v1)`.
That refactor was never finished. Fourteen months of documentation, comments, help
text, load scripts, and one rendered README diagram still describe `/v1/...` as if it
were real.

The cost is not cosmetic:

| Cost                                                         | Evidence                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Things are actually broken.**                              | ~13 executable call sites still request `/v1/...` and 404 against a real server — `packages/cli/src/commands.ts:197` (`cmdExport`) and `:243` (`cmdImport`), `packages/server/loadtest/run.ts:51,84`, and 9 call sites across `load/k6/{recall,remember,collapse,mixed}.js`.                                   |
| **The authoritative status doc asserts the bug is correct.** | `docs/STATUS.md` marks the CLI's `/v1/export/jsonl` and `/v1/import` calls ✅ verified-correct (~lines 451–452, 530, 535), and line 611 claims "BOTH `/v1` URL path AND `Mnemosyne-Version` date header coexist". `packages/server/src/versioning.ts` proves there is no URL path component — only the header. |
| **It is the first thing a visitor sees.**                    | `README.md:194` embeds `.github/assets/session-pipeline.svg`, whose rendered text and `<desc>` show `POST /v1/session/start`, `/v1/session/{id}/turn`, `/v1/session/{id}/collapse`. The `alt` text repeats all three.                                                                                          |
| **It poisons the product's own use case.**                   | 1,906 `/v1` occurrences across 273 files. Mnemosyne is a memory system whose docs are agent context. Every false `/v1/` string is a wrong retrieval hit for the tool we are building.                                                                                                                          |
| **It blocks the next piece of work.**                        | This change is explicitly prep. A coherent documentation refresh cannot start on top of a corpus where the single most-repeated API detail is false, because every touched page forces a re-litigation of "is `/v1` real?".                                                                                    |

The root cause is that nothing prevents regression. The 2026-06-25 sweep was
incomplete and the debt regrew; a second incomplete sweep would regrow the same way.
So the durable deliverable here is not the edits — it is the edits **plus a guard**,
following the repo's established convention of enforcing invariants with vitest guard
tests (`v3-purity.test.ts`, `migrations.test.ts`) rather than hoping reviewers notice.

**Success looks like**: no executable in the repo requests `/v1`; no live reader-facing
document claims `/v1` exists; frozen history is untouched and still readable as history;
and a new `/v1/` string cannot enter the repo unnoticed.

## The three version axes — only ONE is in scope

This is the single most important rule of this change. Conflating these axes would
cause real damage.

| #   | Axis                                     | Example                                                                                                              | Verdict                                                                                                             |
| --- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | **Fake HTTP `/v1` path prefix**          | `POST /v1/recall` in comments, docs, k6 scripts                                                                      | ❌ **False. Target of this change.**                                                                                |
| 2   | **Architecture generation v2/v3**        | `packages/core/src/cognitive/` as the "v3 zone"; `@mnemo-ai/cup` v2→v3 migration; `v3-purity.test.ts`                | ✅ **True and load-bearing. Do not touch.**                                                                         |
| 3   | **Agent-facing memory protocol version** | `MEMORY_PROTOCOL_VERSION`, `MEMORY_PROTOCOL_V1_1`, `MEMORY_PROTOCOL_V1_LEGACY` in `packages/core/src/protocol/v1.ts` | ✅ **True, and the frozen constants are replay artifacts. Do not touch — editing them corrupts historical replay.** |

A fourth category exists that is not ours at all: **third-party API paths**, e.g.
`${PROMETHEUS_URL}/api/v1/query` in `scripts/collect-soc2-evidence.sh:160` and
`http://loki:3100/loki/api/v1/push` in `docker/scripts/promtail.yml:9`. These are
other products' versioned APIs. Never touch them.

**And the real versioning mechanism survives.** Mnemosyne _does_ version its API — via
the `Mnemosyne-Version` date header (`packages/server/src/versioning.ts`). This change
removes a phantom path segment; it must never be summarized as "Mnemosyne dropped API
versioning".

## Scope

Work is tiered by _what breaks if the text is wrong_, not by file type. Tiers 0–2 are
in scope; Tiers 3–4 are permanent non-goals.

### In scope

**Tier 0 — Executable callers (a request is actually issued).** Highest value, smallest
diff, lands first.

- `packages/cli/src/commands.ts` — `cmdExport` (`:197`) and `cmdImport` (`:243`) raw
  `fetch()` calls. Both bypass `@mnemo-ai/client-ts` (whose own paths were already
  corrected by BACKLOG T5/T8, commit `116a249`) — which is exactly why they survived
  that audit.
- `packages/server/loadtest/run.ts:51,84`.
- `load/k6/recall.js`, `load/k6/remember.js`, `load/k6/collapse.js`, `load/k6/mixed.js`
  — 9 call sites.
- Regression tests for both CLI commands. `cmdImport` currently has **zero** coverage,
  and `cli.test.ts` only asserts `.toContain("/export/jsonl")` — a substring match that
  passes against the broken URL. Tests must assert the full path, not a substring.

**Tier 1 — Authoritative and reader-facing surfaces (a human or agent is actively
misled).**

- `docs/STATUS.md`: correct the false "`/v1` URL path AND header coexist" reconciliation
  row (line 611), and downgrade the rows certifying the broken CLI export/import calls
  as verified-correct.
- `README.md:194` `alt` text + `.github/assets/session-pipeline.svg` (4 occurrences:
  `<desc>` and three `<text>` nodes).
- CLI user-visible help text — `packages/cli/src/commands.ts:3853` prints
  `(/health/ready + /v1/health)` to every user running `mnemo --help`.
- `packages/server/src/app.ts:461` — the comment "Registered BEFORE `app.route('/v1', v1)`"
  describes a call that does not exist anywhere in the file.
- Live architecture docs that are not frozen snapshots: `docs/architecture/FEDERATION.md`,
  `ARCHITECTURE_OVERVIEW.md`, `IDEMPOTENCY_STRATEGY.md`, `MCP_SESSION_TOOL.md`,
  `docs/integration/SDK_INTEGRATION.md`, `docs/internals/OBSERVABILITY.md`,
  `docs/internals/ALGORITHMS.md`, `docs/api/STABILITY.md`, package `README`s,
  `load/README.md`, `packages/server/loadtest/README.md`.

**Tier 2 — In-source route documentation (false, mechanical, high-volume).**

- JSDoc/comment path references across `packages/server/src/routes/*.ts`,
  `packages/mcp/src/tools/*.ts`, `packages/client-ts/src/client.ts` (~57),
  `packages/types/src/ports.ts`, `packages/server/src/{deps,grpc}.ts`, and the
  remaining `app.ts` comments.

**Tier 5 — The regression guard (new).**

- A vitest guard that fails when `/v1/` appears outside an explicit allowlist covering
  Tiers 3 and 4. Placed and named to match the existing guard convention.

### Out of scope — permanent non-goals, not deferred follow-ups

**Tier 3 — Frozen history. Content is never edited; each gets one added clarifying
line (decided by Pablo — see Resolved decisions) so a reader doesn't mistake historical
`/v1` mentions for a live path.**

- `CHANGELOG.md` (58) and `packages/server/CHANGELOG.md` (49) — release-please output;
  they record what the API looked like at the time, and at the time `/v1` was real.
  Gets a one-line banner at the top: paths in entries before 2026-06-25 predate the
  root remount.
- Dated audit snapshots: `docs/archive/audits/AUDIT_REPORT.md`, `docs/archive/audits/2026-07-23-audit-report.md`,
  `docs/archive/audits/AUDIT_SPEC_COVERAGE_2026-06.md`. Same one-line banner.
- Completion reports: `API-2-COMPLETE.md`, `API-3-COMPLETION-REPORT.md`,
  `API-5-8-COMPLETION-REPORT.md`, `OPS-1-COMPLETION-REPORT.md`. Same one-line banner.
- `docs/architecture/API_PATHS.md` (39) — already banner-marked **SUPERSEDED**, which
  already communicates this; no additional banner needed here, the existing one covers
  it.
- Prior OpenSpec proposals (`docs/archive/openspec/p7-mnemo-keys/*`, `docs/archive/openspec/tool-promise-remediation/*`)
  and dated design docs under `docs/archive/superpowers/specs/` — sealed records of past intent.
- `docs/architecture/API.md` — **already correct**, carries a 2026-07-31 correction note,
  and is the current source of truth. Do not "clean" it.

**Tier 4 — Third-party API paths** (Prometheus, Loki). Not ours.

**Also explicitly out of scope:**

- Axes 2 and 3 above (architecture v2/v3, `MEMORY_PROTOCOL_VERSION`).
- The `Mnemosyne-Version` header mechanism itself — unchanged.
- Any actual documentation _improvement_: restructuring, rewriting, filling gaps,
  updating stale non-`/v1` facts. This change is strictly a truth-correction pass that
  unblocks that work. Mixing them would make both unreviewable.
- `docs/archive/BACKLOG.md` (47) beyond marking the items this change closes.

## Scope decisions and rationale

These are the four judgment calls this proposal exists to make. Each is a real fork.

### 1. The live CLI bugs are IN scope — and the executable class is bigger than first found

**Decision: include them, first in the chain.**

They surfaced as a side effect of a docs exploration, which normally argues for a
separate bugfix change. Three things overrule that here:

- **A docs-only change would be actively harmful.** Declaring "there is no `/v1`" across
  the corpus while leaving executables calling `/v1` doesn't remove the contradiction —
  it hides it. The misleading docs are currently the only remaining breadcrumb pointing
  at the stale call sites.
- **The blast radius is bounded and testable.** ~13 call sites in 5 files, all on paths
  that are already broken. There is no behavior to preserve: these requests 404 today.
- **Verification during exploration widened the set.** Beyond the two CLI bugs, the k6
  load suite (3 files, 9 calls) and `packages/server/loadtest/run.ts` (2 calls) are also
  live. Anyone who ran a load test against a current server measured 404 latency. Had
  this change been scoped docs-only on the original two-bug finding, those would have
  been left broken _and_ newly invisible.

Because they land first as an independent unit, they remain independently revertible if
the doc tiers stall.

### 2. The cosmetic JSDoc sweep is IN scope — bounded by the tier allowlist, chained last

**Decision: include Tier 2, executed per-package as chained mechanical PRs, gated on
Tiers 0–1 landing first.**

The tempting call is "cosmetic, defer to backlog". Rejected, because:

- **A partial flatten does not unblock the doc refresh**, which is the entire stated
  purpose. Leaving ~1,500 false strings means the next person editing any route file
  still has to ask "is `/v1` real?" — the exact tax this change is meant to remove.
- **Deferred sweeps in this repo do not happen.** This debt _is_ the deferred remainder
  of the 2026-06-25 sweep. Re-deferring it costs a full re-derivation of the tier
  classification later, which is the expensive part.
- **For a memory product, source comments are retrieval corpus**, not decoration. An
  agent grepping `packages/server/src/routes/` for the recall endpoint reads
  `POST /v1/recall` and believes it.

What makes it safe is the tier allowlist above, which was derived by inspection, not
assumption. A naive repo-wide find-replace would have corrupted CHANGELOGs, falsified
audit snapshots, broken the Prometheus and Loki integrations, and — worst — mangled
`packages/core/src/protocol/v1.ts`. The classification is the deliverable; the edits are
mechanical once it exists.

**Sequencing rule**: Tier 2 is last. If the chain is cut short, the repo is still
strictly better off (nothing broken, nothing authoritative lying), and the guard from
Tier 5 must then be introduced with a temporary allowlist for the unswept packages so
it can still block _new_ regressions.

### 3. The README SVG is hand-edited — no tooling follow-up needed

**Decision: edit the SVG XML directly.**

Verified: `.github/assets/` contains only `.svg` files. There is no `.d2`, `.mmd`,
`.puml`, or generator script anywhere in the repo — the mermaid hits are inside markdown
docs, unrelated to these assets. The SVGs are hand-authored, and the affected content is
plain `<text>` nodes plus a `<desc>`, not outlined paths or a raster.

Edge case checked: the three labels use `text-anchor="middle"` at fixed `x`, so shortening
`POST /v1/session/start` → `POST /session/start` re-centers automatically. No layout
breakage, no re-render needed.

Accessibility rule: `<desc>`, the three `<text>` nodes, and the `README.md:194` `alt`
attribute must be corrected **together**. Fixing only the visible label would leave a
screen-reader user with the wrong paths — a strictly worse outcome than today, where at
least sighted and non-sighted readers are misled identically.

### 4. `docs/STATUS.md` — confirmed in scope, with a sequencing constraint

Two distinct defects, and they are not the same kind:

- **Line 611 is simply false** and can be corrected immediately and independently.
- **The CLI export/import rows certify a real bug as verified-correct.** These can only
  be corrected _after_ Tier 0 lands, otherwise STATUS.md would describe a fix that does
  not exist yet. Ordering: fix the code, then update the status.

There is a second-order lesson worth recording in the change itself: STATUS.md's
verification process produced a ✅ for code it had not actually executed. The
`tool-promise-remediation` proposal reached the same conclusion about STATUS.md from a
different direction. This change does not attempt to fix the verification process — but
it should not quietly paper over the evidence either.

### 5. Versioning-coherence review (added by Pablo)

Removing the false `/v1` prefix is a subtraction. Left on its own, subtraction can leave
a gap: once the fake path is gone, is the _real_ versioning mechanism still fully and
correctly documented everywhere that used to (wrongly) point at `/v1`?

**Decision: add an explicit coherence-review pass over Tier 1's live docs, as the last
step before the Tier 2 mechanical sweep starts.**

Concretely, for every Tier 1 doc touched (`docs/architecture/API.md` already correct and
used as the reference; `FEDERATION.md`, `ARCHITECTURE_OVERVIEW.md`,
`IDEMPOTENCY_STRATEGY.md`, `MCP_SESSION_TOOL.md`, `docs/integration/SDK_INTEGRATION.md`,
`docs/internals/OBSERVABILITY.md`, `docs/internals/ALGORITHMS.md`,
`docs/api/STABILITY.md`, package READMEs), confirm two things, not just one:

1. The false `/v1` path is gone (the subtraction).
2. The doc still correctly and completely describes the real, surviving mechanism —
   the `Mnemosyne-Version` date header (`packages/server/src/versioning.ts`) — where that
   doc's subject matter touches versioning at all. If a doc asserted something about
   `/v1` and, once that's removed, says nothing about how the API is actually versioned
   where it should, that's a coherence gap this review closes — not a new feature, just
   making sure removing the wrong statement didn't quietly remove the _only_ statement.

This is a read-and-confirm pass, not new documentation writing — the goal is internal
consistency across the corpus, not expanding doc scope beyond version-truth (see
"Also explicitly out of scope" above). Runs as part of Tier 1, gated before Tier 2 starts,
so any doc that needs more than a one-line fix to stay coherent surfaces before the
mechanical sweep locks in the tier allowlist.

## Capabilities

### New capabilities

- `api-path-truth-guard`: a vitest guard test that fails when `/v1/` appears outside the
  Tier 3/4 allowlist, preventing a third round of this debt.

### Modified capabilities

- `cli-export` / `cli-import`: now request paths that exist; `cli-import` gains its first
  test coverage.
- `load-testing`: k6 and server loadtest suites measure real endpoints instead of 404s.
- `api-documentation`: live docs, source comments, README diagram, and CLI help text
  describe the real root-mounted API.

## Approach

1. **Fix executables + tests** (Tier 0). Full-path assertions, not `toContain` substrings.
2. **Correct authoritative surfaces** (Tier 1): STATUS.md, README + SVG + alt, CLI help
   text, `app.ts:461`, live architecture docs.
3. **Versioning-coherence review** (Tier 1, last step): confirm each touched Tier 1 doc
   still correctly and completely describes the real `Mnemosyne-Version` header
   mechanism after the false `/v1` text is removed — not just that the false text is
   gone.
4. **Add one-line clarifying banners to Tier 3** frozen-history docs (CHANGELOGs, dated
   audits, completion reports) noting pre-2026-06-25 paths predate the root remount.
   Content otherwise untouched.
5. **Add the guard** (Tier 5) with the Tier 3/4 allowlist, so the sweep cannot regress
   mid-chain.
6. **Mechanical sweep** (Tier 2), one chained PR per package boundary
   (`server/routes`, `mcp/tools`, `client-ts`, `types`+`cli`), each independently
   reviewable and revertible.
7. **Close the loop**: mark the corresponding `docs/archive/BACKLOG.md` items complete.

## Phase 2 — Contract-reality audit, full test coverage, and deploy verification (added by Pablo)

The `/v1` bugs were found by accident, as a side effect of a docs exploration. That is
itself evidence of a broader gap: nothing in this repo systematically checks that every
documented/speced contract has a real implementation behind it, and every real endpoint,
MCP tool, and CLI command is accurately documented — in both directions. Pablo's framing:
the API is what every client (CLI, MCP tools/skills, `client-ts`, direct HTTP) depends on,
so before and after this change ships, that surface needs to be tested end-to-end against
a real running server, not just linted for stale strings — and the agent-facing surface
(MCP tool descriptions, skills) specifically must not describe capabilities, endpoints, or
contracts that don't actually exist ("ghost endpoints", "ghost contracts").

**This phase runs after Tiers 0–5 land** (the `/v1` truth-correction work), as the next
step in the same change, not a separate initiative — it verifies the corrected surface,
using the same tier-by-tier contract inventory this change already had to build.

### Scope

1. **Contract-reality audit.** Cross-reference, for every surface:
   - OpenAPI spec (`mountOpenApi` output) vs. actually-registered Hono routes — flag any
     documented-but-unimplemented route (phantom endpoint) and any implemented-but-undocumented
     route.
   - Every MCP tool's declared input schema and description (`packages/mcp/src/tools/*.ts`)
     vs. what the server route it calls actually accepts and returns — flag mismatches,
     not just `/v1` string errors.
   - Every CLI command vs. the server route(s) it calls — the same class of bug as
     `cmdExport`/`cmdImport`, checked exhaustively instead of by accident.
   - `@mnemo-ai/client-ts` SDK methods vs. real routes.
   - Output: a concrete list of every phantom endpoint, undocumented endpoint, and
     mismatched contract found — the audit's own deliverable, same pattern as the tier
     classification above.
2. **Full endpoint/tool/CLI/MCP test coverage.** Extend integration tests so every real
   HTTP route, every one of the 34 MCP tools, and every CLI command is exercised against a
   real running server (not mocked) at least once, asserting on the real response shape —
   closing exactly the kind of gap that let `cmdImport` ship with zero coverage and a
   substring-matching test hide the `cmdExport` bug.
3. **Deploy.** Once Tiers 0–5 and the contract audit's required fixes are merged and CI is
   green, deploy the corrected server per `docs/DEPLOYMENT.md`'s existing process — no new
   deployment mechanism invented here.
4. **Production verification.** Re-run the full endpoint/tool/CLI/MCP test suite from
   step 2 against the deployed instance, using the real clients (CLI binary, MCP stdio
   server, `client-ts`, direct HTTP) — not local mocks — to confirm the deployed server
   behaves identically to what was verified locally/in CI.

### Explicit checkpoint

**Deploying to the production server is an irreversible, shared-system action.** This
proposal records deploy + production verification as a planned step in this change, but
actually triggering the deploy requires an explicit go-ahead at that point in the
implementation — it is not authorized to run unattended just because it's in this plan.

### Non-goals for this phase

- This is an audit-and-test pass, not a rewrite of MCP tool descriptions, CLI help text
  beyond what the audit finds broken, or the OpenAPI spec's structure. Fixing a genuinely
  broken contract found by the audit is in scope; redesigning a working one is not.
- Load/perf testing beyond what already exists in `load/k6/*` — this is contract
  correctness, not a performance benchmark.

## Affected areas

| Area                                                                                        | Impact        | Note                                                               |
| ------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------ |
| `packages/cli/src/commands.ts`                                                              | Modified      | 2 live bugs + user-visible help text                               |
| `load/k6/*.js`, `packages/server/loadtest/run.ts`                                           | Modified      | 11 live 404s                                                       |
| `docs/STATUS.md`                                                                            | Modified      | False claims corrected; sequenced after Tier 0                     |
| `README.md`, `.github/assets/session-pipeline.svg`                                          | Modified      | Hand-edited XML + alt                                              |
| `packages/server/src/`, `packages/mcp/src/tools/`, `packages/client-ts/`, `packages/types/` | Modified      | Comment-only                                                       |
| `CHANGELOG.md`, `packages/server/CHANGELOG.md`, dated audits, completion reports            | Modified      | One-line clarifying banner added; content otherwise byte-identical |
| `docs/architecture/API.md`, `API_PATHS.md`, prior openspec changes                          | **Unchanged** | Already correct, or already carries its own SUPERSEDED banner      |
| `packages/core/src/protocol/v1.ts`                                                          | **Unchanged** | Different axis; replay artifacts                                   |

## Risks

| Risk                                                                                            | Likelihood                                                                                                       | Mitigation                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A blind find-replace hits Tier 3/4 or the protocol constants                                    | Medium                                                                                                           | The tier allowlist is the primary control; the guard test encodes it; per-package chained PRs keep each diff inspectable                                                                                             |
| Reviewers read the change as "API versioning removed"                                           | Medium                                                                                                           | Every artifact states that `Mnemosyne-Version` is the real, surviving mechanism                                                                                                                                      |
| Tier 2 chain stalls half-swept                                                                  | Medium                                                                                                           | Tiers 0–1 land first and stand alone; guard ships with a temporary allowlist for unswept packages                                                                                                                    |
| A `/v1` path is real somewhere unverified                                                       | Low                                                                                                              | `app.ts:577` (`app.route("/", v1)`) and `versioning.ts` were both read directly; the CLI/k6 sites 404 today, which is the confirming evidence                                                                        |
| SVG edit breaks layout                                                                          | Low                                                                                                              | `text-anchor="middle"` verified; shortened labels re-center                                                                                                                                                          |
| Contract audit finds a mismatch large enough to need its own design decision (not a simple fix) | Medium                                                                                                           | Audit output is a list, reviewed before fixes are written — a finding that's really a redesign gets split into a follow-up, not force-fit here                                                                       |
| **Deploy affects the live production server**                                                   | High impact if wrong, but the deploy itself follows the existing `docs/DEPLOYMENT.md` process (no new mechanism) | Deploy only after Tiers 0–5 + audit fixes are merged and CI is green; requires an explicit human go-ahead at execution time, not automatic; production verification runs immediately after to catch regressions fast |

## Rollback

Every tier is independently revertible. Tier 0 restores broken URLs (undesirable but
harmless — they were already failing). Tiers 1–2 are text-only. Tier 5 is a single test
file. No schema, no migration, no data change. The contract audit and added test coverage
are additive (new tests, no behavior change by themselves). Deploy rollback follows
whatever rollback mechanism `docs/DEPLOYMENT.md` already documents for this repo — this
change does not introduce a new one.

## Dependencies

- None blocking. `docs/architecture/API.md` is already corrected and serves as the
  reference for what the real paths are.
- Phase 2 (contract audit, full test coverage, deploy, production verification) depends
  on Tiers 0–5 being merged first — it audits and verifies the corrected surface, not the
  broken one.

## Success criteria

- [ ] `mnemo export` and `mnemo import` reach real endpoints, both covered by tests that
      assert full paths
- [ ] k6 and server loadtest suites issue zero `/v1` requests
- [ ] `docs/STATUS.md` no longer claims a `/v1` URL path exists, nor certifies the CLI
      bug as correct
- [ ] `README.md` diagram, its `<desc>`, and its `alt` text show root-mounted paths
- [ ] `mnemo --help` shows no `/v1`
- [ ] `packages/server/src/app.ts` contains no comment describing `app.route('/v1', v1)`
- [ ] The guard test fails on a newly introduced `/v1/` outside the allowlist
- [ ] `packages/core/src/protocol/v1.ts`, architecture v2/v3 labels, and third-party API
      paths are byte-identical
- [ ] Tier 3 content (CHANGELOGs, dated audits, completion reports) is byte-identical
      except for one added clarifying banner line each
- [ ] Every Tier 1 doc that discusses API versioning correctly and completely describes
      the `Mnemosyne-Version` header mechanism after the `/v1` text is removed — no
      coherence gap left by the subtraction
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass

**Phase 2:**

- [ ] Contract-reality audit produced: a concrete list of phantom endpoints (documented
      but not implemented), undocumented endpoints (implemented but not in the OpenAPI
      spec), and MCP-tool/CLI/client-ts contract mismatches
- [ ] Every real HTTP route, all 34 MCP tools, and every CLI command are exercised by an
      integration test against a real running server
- [ ] No MCP tool description or skill promises a capability, endpoint, or contract that
      doesn't actually exist
- [ ] Server deployed per `docs/DEPLOYMENT.md`, only after explicit go-ahead at that point
      in implementation
- [ ] Full endpoint/tool/CLI/MCP test suite re-run against the deployed server using real
      clients (not mocks), with results reported before considering this change done

## Resolved decisions (Pablo)

1. **Tier 2 depth — full sweep, confirmed.** The ~1,500 comment-level mentions stay in
   scope as chained mechanical PRs, gated behind Tiers 0–1 and the guard, per the
   proposal's original recommendation.
2. **Frozen-history boundary — banner added.** Tier 3 items (CHANGELOGs, dated audits,
   completion reports) get one added clarifying line each instead of staying bare; content
   otherwise untouched. `API_PATHS.md` keeps its existing SUPERSEDED banner, no duplicate
   added.
3. **Guard strictness — strict, confirmed.** The guard blocks any `/v1/` outside the
   explicit Tier 3/4 allowlist; the allowlist is maintained as new third-party
   integrations are added, per the proposal's original recommendation.
4. **Versioning-coherence review — added.** A read-and-confirm pass over Tier 1 docs
   verifying the real `Mnemosyne-Version` header mechanism is still correctly and
   completely described once the false `/v1` text is removed (see "Scope decisions and
   rationale" §5). Runs as the last Tier 1 step, before Tier 2 starts.
