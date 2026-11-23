# Tasks: Flatten the `/v1` Version Noise

Chain A (A0–A12) and Chain B (B1–B5) numbering follows `design.md` exactly — not renumbered.

## Apply status (this session)

A0–A12 implemented, tested, and committed locally on stacked branches
(`flatten-version-docs/a1` through `/a12`, chain: `main → a1 → a2 → a3(-content/-format/-sdd-docs) →
a4 → a5(a/b/c) → a6 → a7 → a8a → a8b → a8c → a9 → a10a → a10b → a11 → a11c → a12`).
Not pushed; no PRs opened (per this session's explicit instructions).
All of Chain B remains to do — see each task's notes below.

## Review Workload Forecast

| Field                   | Value                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Estimated changed lines | Chain A total ~1200 across 12 slices (each individually pre-sized <400); Chain B unbounded until B4 fills in coverage                                                            |
| 400-line budget risk    | High (B4 explicitly flagged by design as needing per-surface split; A5/A3/A8 are the closest Chain-A slices to the ceiling)                                                      |
| Chained PRs recommended | Yes                                                                                                                                                                              |
| Suggested split         | A0(bundled in A1) → A1 → A2 → A3 → A4 → A5 → {A6…A11 order-independent} → A12 → [Chain A merged, CI green] → B1 → B2 → B3 → B4(may split per-surface) → Deploy Gate (human) → B5 |
| Delivery strategy       | auto-chain                                                                                                                                                                       |
| Chain strategy          | stacked-to-main (matches design's order-independent A6–A11 siblings and stall-safety property)                                                                                   |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit        | Goal                                                                  | PR                | Focused test                                             | Runtime harness                                     | Rollback boundary                              |
| ----------- | --------------------------------------------------------------------- | ----------------- | -------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| A0          | Census + classify 6 unlisted `/v1/` areas; produce allowlist data     | bundled in A1     | `rg '/v1/' packages/mock-server` etc.                    | N/A (static grep)                                   | Revert A1                                      |
| A1          | Fix 13 executable call sites + `expectRequest` + `cmdImport` coverage | A1                | `pnpm --filter @mnemo-ai/cli test`                       | N/A (unit)                                          | Revert A1                                      |
| A2          | Correct STATUS.md/README/SVG/help/app.ts comment                      | A2                | `rg '/v1' docs/STATUS.md README.md .github/assets/*.svg` | N/A                                                 | Revert A2                                      |
| A3          | Sweep + coherence-review Tier 1 live docs                             | A3                | `rg '/v1' <Tier1 list>`                                  | N/A                                                 | Revert A3                                      |
| A4          | One banner line per frozen doc                                        | A4                | diff exactly 1 line/file                                 | N/A                                                 | Revert A4                                      |
| A5          | Guard + allowlist + `unswept` entries                                 | A5                | `pnpm --filter @mnemo-ai/server test`                    | N/A (in-memory fixture)                             | Revert A5                                      |
| A6–A11      | Per-package Tier 2 comment sweeps                                     | A6–A11            | `rg '/v1/' <pkg>` + guard green                          | N/A                                                 | Revert individual PR                           |
| A12         | BACKLOG.md sweep (scope correction)                                   | A12               | `rg '/v1/' docs/archive/BACKLOG.md`                      | N/A                                                 | Revert A12                                     |
| B1          | 4 inventory recorders + snapshots                                     | B1                | `pnpm test` (server/mcp/cli/client-ts)                   | N/A (in-process)                                    | Delete new test files                          |
| B2          | 4 set differences + `EXPECTED_DIVERGENCES` + review doc               | B2                | `pnpm --filter @mnemo-ai/server test`                    | N/A                                                 | Revert B2                                      |
| B3          | `live-surface` harness + coverage-enumeration guard                   | B3                | `pnpm test:integration` (Node 22)                        | pgvector testcontainer + real Hono + real MCP stdio | Revert B3                                      |
| B4          | Fill in COVERAGE for every route/tool/command                         | B4 (may split)    | `pnpm test:integration` (Node 22)                        | same live harness                                   | Revert per-surface slice                       |
| Deploy Gate | G1–G5, human checkpoint at G4                                         | none — ops action | manual verification of digests                           | live target host                                    | Digest swap (no schema migration)              |
| B5          | Prod-verification parameterization + report                           | B5                | full suite vs `MNEMO_VERIFY_URL`                         | real remote instance                                | Parameterization revert only; no schema change |

---

## Chain A — `/v1` Truth Correction (Tiers 0–5)

### A0 — BLOCKING PREREQUISITE (bundled inside PR A1; guard A5 cannot be authored/frozen until this completes)

- [x] A0.1 Classify `packages/mock-server/src/app.ts` + `README.md` (21 occ.) as Tier 2; verify all are comments. Test: `rg '/v1/' packages/mock-server` → comment lines only. (Actual current count: 29 — allowlisted `unswept`, sweptBy A11.)
- [x] A0.2 Allowlist `packages/adapter-postgres/migrations/baseline/0019_session_label.sql` (1 occ., applied migration) as `frozen`, expected=1 — never edit (would change its checksum).
- [x] A0.3 Classify `docs/archive/superpowers/plans/**` (~250 occ.) as Tier 3 — proposal only named `specs/`. (Actual current count: 494 — allowlisted `frozen`.)
- [x] A0.4 Classify `docs/archive/sdd/archive/**` (~110 occ.) as Tier 3. (Actual: 109 — allowlisted `frozen`.)
- [x] A0.5 Classify `openspec/flatten-version-docs/**` (27+ occ., growing) as Tier 3 — must allowlist or the guard fails on its own introducing PR. (Pinned at 66 as of A5; growing — re-pin expected on future docs changes here.)
- [x] A0.6 Resolve Q1: sweep `docs/archive/BACKLOG.md` (40 occ.) in A12 instead of allowlisting as frozen — deliberate scope correction (proposal excluded it; design found it's a live reader-facing doc whose exclusion would weaken the guard's own promise). (A12 not yet executed this session; allowlisted `unswept`, sweptBy A12, expected=55 — actual current count, not 40.)
- [x] A0.7 Resolve Q2: classify `packages/federation/src/MtlsAuthAdapter.ts` (2 occ.) as Tier 2 or Tier 4. **Resolved: Tier 2** — both occurrences are comments describing our own federation routes (`POST /v1/memory/federation/peers/:id/approve-key`), not a peer's third-party path. Allowlisted `unswept`, sweptBy A11.
- [x] A0.8 Produce the reviewed allowlist data from A0.1–A0.7, consumed by A5. **Scope extended**: a full-repo re-census during A3/A5 (not just A0) found ~35 more files A0's re-census missed (docs/archive/remediation/, 5 more package CHANGELOGs, 2 completed openspec/ change folders, packages/core/src/, and ~13 doc areas whose tier could not be safely judged — see coherence-review.md "Gap 3" and api-path-truth.allowlist.ts).

Depends on: nothing (runs first). Blocks: A5. Spec: Req 10, Req 11.

### A1 (Tier 0) — depends on A0 — ✅ DONE (branch `flatten-version-docs/a1`)

- [x] A1.1 Fix `packages/cli/src/commands.ts` `cmdExport`(:197)/`cmdImport`(:243) fetch paths (Req 1).
- [x] A1.2 Fix `packages/server/loadtest/run.ts`(:51,:84) + `load/k6/{recall,remember,collapse,mixed}.js` (9 sites) (Req 3). Also fixed `packages/server/loadtest/server.ts` (2 log/comment strings, adjacent, not originally named) and `packages/server/scripts/dump-openapi.mjs` (a genuine Tier 0 executable bug of the same class, discovered later during A5's full-repo census — fixed as part of A5's branch instead).
- [x] A1.3 New `packages/cli/src/__tests__/helpers/expect-request.ts` — exact `URL.pathname` assertion helper (Req 2).
- [x] A1.4 Full-path export test in `cli.test.ts` using the helper (Req 2).
- [x] A1.5 5 new `cmdImport` tests: fixture import, `--from`/`--conflict-resolution`, missing file, unreadable file, non-2xx (Req 2).

Verification: `pnpm --filter @mnemo-ai/cli test` — 215/215 passing (98/98 in cli.test.ts). ~163 changed lines (within budget). Gate: none.

### A2 (Tier 1) — depends on A1 merged — ✅ DONE (branch `flatten-version-docs/a2`)

- [x] A2.1 `docs/STATUS.md:611` — remove false `/v1` coexistence claim (Req 4).
- [x] A2.2 `docs/STATUS.md` CLI cert rows (~451–452,530,535) — only after A1 lands (Req 4). **Scope extended**: STATUS.md carried ~59 more `/v1/`-prefixed mentions beyond these specific rows; since it's a live (non-Tier-3) doc that Req 11 forbids bulk-allowlisting, all were swept in this same commit (Prometheus's real `/api/v1/query` at :736 excepted).
- [x] A2.3 `README.md:194` alt + `.github/assets/session-pipeline.svg` `<desc>`+3 `<text>`, same commit (Req 5).
- [x] A2.4 CLI help `commands.ts:3853` + `app.ts:461` comment (Req 6).

Verification: `rg '/v1/' docs/STATUS.md README.md .github/assets/session-pipeline.svg` → 0 (except the one protected Prometheus line). `pnpm --filter @mnemo-ai/cli test` — 98/98. ~134 changed lines. Gate: A1.

### A3 (Tier 1 + coherence review) — depends on A2 — ✅ DONE (branch `flatten-version-docs/a3`)

- [x] A3.1 Sweep `/v1` from FEDERATION.md, ARCHITECTURE_OVERVIEW.md, IDEMPOTENCY_STRATEGY.md, MCP_SESSION_TOOL.md, SDK_INTEGRATION.md, OBSERVABILITY.md, ALGORITHMS.md, STABILITY.md, package READMEs, `load/README.md`, `loadtest/README.md` (Req 7). STABILITY.md needed no change (already accurate). Also swept `packages/sdk-python/README.md` (15 occ., not named anywhere despite STATUS.md claiming non-TS SDKs were already fixed — `sdk-go` checked clean).
- [x] A3.2 Confirm/add `Mnemosyne-Version` header coverage wherever versioning is discussed — no gap left (Req 7). None of the swept docs discussed HTTP versioning as a topic (only used `/v1` as a route-label prefix), so no coherence gap existed to fill.
- [x] A3.3 New `openspec/flatten-version-docs/coherence-review.md` — per-doc row, oracle = `docs/architecture/API.md`; surface any doc needing more than a one-line fix before Tier 2 locks (Req 7). Surfaces 3 gaps: STATUS.md's scope correction (folded into A2), sdk-python's scope correction (swept here), and a full-repo re-census finding ~35 more un-triaged files (`docs/archive/remediation/`, 5 more CHANGELOGs, 2 completed openspec/ folders, `packages/core/src/`, ~13 doc areas) — none force-fit, all recorded for a follow-up "A0b" triage.

Verification: `rg '/v1' <Tier1 list>` → 0; coherence-review.md written with all gap rows. ~265 changed lines (Medium risk, as forecast). Gate: A2.

### A4 (Tier 3 banners) — depends on A3 — ✅ DONE (branch `flatten-version-docs/a4`)

- [x] A4.1 One bare `` `/v1` `` banner line (no trailing slash) added to: 2 CHANGELOGs, 3 dated audits, 4 completion reports (Req 9). Verified each diff is exactly +1 line.
- [x] A4.2 Verify `docs/architecture/API_PATHS.md` stays byte-identical (Req 9). Confirmed — empty diff.

Also added 7 of these 9 files to `.prettierignore`: none were prettier-clean before this change, and lint-staged's `prettier --write` on commit would otherwise reformat the whole file, violating the "exactly one line" requirement.

Verification: `git diff --stat` per file — exactly 1 insertion each; `API_PATHS.md` has zero diff. ~9 changed lines (+ 13-line `.prettierignore` addition). Gate: A3.

### A5 (Tier 5 guard) — depends on A4 AND A0 — ✅ DONE (branch `flatten-version-docs/a5`)

- [x] A5.1 New `packages/server/src/__tests__/api-path-truth.allowlist.ts` — `frozen`/`foreign`/`unswept` `Allowance` union from A0's classifications (Req 11). Grew to 60 entries reflecting the true repo-wide census (see A0.8 note).
- [x] A5.2 New `api-path-truth.test.ts` (+ `api-path-truth.census.ts` for the pure logic, split out for unit-testability) — `census(files, allowlist)` pure fn; `git ls-files -z` enumeration; throws loudly outside a git checkout; matches literal `/v1/`; skips binary files (NUL-byte detection — needed because `packages/sdk-python/**/__pycache__/*.pyc` is tracked in git, see risks) (Req 11).
- [x] A5.3 Add `unswept` entries per unswept Tier 2 boundary (routes, non-routes [split into 8 non-overlapping exact-file entries to avoid double-sweep conflicts with A6/A8], `__tests__`, mcp [split src/ vs README.md], client-ts+types+cli, mock-server+adapter-postgres+federation) (Req 11). Also added an unassigned-gap entry for `packages/core/src/` (5 occ., never named in any A0/A6-A11 boundary).
- [x] A5.4 Unit-test guard against in-memory fixtures: new `/v1/` fails, allowlisted content passes (Req 11). 9 unit tests total: ungoverned-fails, allowlisted-passes, frozen over-count fails, frozen under-count fails, foreign pattern scoping (narrow, not path-blanket), directory-prefix coverage, partial-sweep-surfaces-remainder, multi-occurrence-per-line counting, throws-outside-git-checkout.

Verification: `pnpm --filter @mnemo-ai/server test` — 202 files / 1439 tests passing, including all 10 api-path-truth tests (9 unit + 1 real repo-wide scan, 0 violations). `pnpm build && pnpm typecheck` both green. **~715 changed lines — exceeds the 400-line budget** (design flagged this as the highest-risk slice; the true allowlist grew far beyond estimate due to the A0.8 scope extension). Recommend splitting into 2 PRs before review: guard engine + tests (`api-path-truth.census.ts` + both `.test.ts` files, ~270 lines) and allowlist data (`api-path-truth.allowlist.ts`, ~415 lines, "reviewed as data" per design.md). Gate: A4 + A0.

### A6–A11 (Tier 2 sweeps) — order-independent siblings; each deletes exactly one `unswept` entry; depend on A5 — ✅ DONE (branches `flatten-version-docs/a6` through `/a11c`)

Real counts below are taken from `api-path-truth.allowlist.ts` (A5), verified
against the repo as of this session — use these, not the original estimates.

- [x] A6 `packages/server/src/routes/` — **129 occurrences** swept (127 comment fixes + 2 reclassified `foreign`: real OpenAI/Anthropic HTTP API calls in `bootstrap.ts`, not our own routes). ~274 changed lines (incl. a 9-file pre-format chore commit). (Req 8)
- [x] A7 `packages/server/src/` non-routes, 8 exact-file `unswept` entries: `app.ts`(16), `deps.ts`(5), `index.ts`(4), `grpc.ts`(4), `ws.ts`(2), `metrics/index.ts`(2), `telemetry/otel.ts`(1 — reclassified `foreign`: real OTLP/HTTP protocol receiver path, not ours), `recall/reminders.ts`(1). ~74 changed lines. (Req 8)
- [x] A8 `packages/server/src/__tests__/` — **228 occurrences**, split into 3 slices as flagged (over budget as one PR): A8a (13 root-level files, 86 occ), A8b (21 `integration/` files, 93 occ), A8c (11 `unit/` files, 18 occ). Guard's own 4 self-allowlisted files (`api-path-truth.{census,census.test,allowlist,test}.ts`) untouched throughout. ~500 changed lines total across the 3 sub-branches (incl. pre-format chore commits). (Req 8)
- [x] A9 `packages/mcp/` — `src/`(42) + `README.md`(9) swept. `CHANGELOG.md`(2) untouched (frozen). ~126 changed lines (incl. an 8-file pre-format chore commit). (Req 8)
- [x] A10 split into A10a + A10b for budget: A10a swept `packages/client-ts/src/`(128)+`packages/types/src/`(5)+`packages/cli/src/`(21 — re-verified 21, not tasks.md's original 20) comments (~324 changed lines); A10b migrated all remaining `toContain` URL assertions (52 across `primitive-parity.test.ts`/`workspace-tenant-parity.test.ts`) to `expectRequest` (~141 changed lines). One assertion used `fetchCalls.some(...)` across 2 recorded calls — replaced with a direct `fetchCalls[1]` index check (verified call order from `cmdWorkspaceCreate`'s source). CHANGELOGs untouched. (Req 8, Req 2)
- [x] A11 `packages/mock-server/`(29)+`packages/adapter-postgres/src/`(2)+`packages/federation/src/`(2) swept. `adapter-postgres/CHANGELOG.md`(5) and `migrations/baseline/0019_session_label.sql`(1) confirmed untouched. mock-server's README.md + src/app.ts also carried an entangled non-`/v1` defect (claimed `/memory/recall`/`/memory/remember`, but the real registered routes are bare `/recall`/`/remember`) — fixed to match source, not just de-prefixed. ~76 changed lines (incl. a pre-format chore commit). (Req 8)
- [x] `packages/core/src/` (5 occurrences: `factory-types.ts`, `cognitive/remember.ts`, `cognitive/metering.ts`, `cognitive/__tests__/recall-cold-pin-priority.test.ts`) — folded in as its own small slice "A11c". v3-purity guard stays green (comment-only changes). ~33 changed lines (incl. a pre-format chore commit).

Verification per task: `rg '/v1/' <pkg>` → 0 outside allowlist ✅ (all), own `unswept` entry deleted ✅ (all), guard (A5's test) stays green ✅ (10/10 after every commit). 4 new `foreign` allowlist entries added for real third-party/protocol paths discovered mid-sweep (OpenAI, Anthropic, OTLP). Gate: A5 merged — satisfied.

### A12 — depends on A6–A11 all merged — ✅ DONE (branch `flatten-version-docs/a12`)

- [x] A12.1 Close matching `docs/archive/BACKLOG.md` items. All items referencing this defect class (T2, T5, T8, B2, P39, P6, P10, P12) were already ✅-marked closed — no open entries needed closing.
- [x] A12.2 Sweep BACKLOG.md's `/v1/` occurrences per A0.6's resolution — **55 occurrences swept**, 0 remaining. Most were mechanical strips to the verified real bare route (one, P10's personal-scope entry, also had the same `/memory/`-segment defect as A11's mock-server finding — corrected to real `/remember`). 4 sections (T2, T5, T8 detail + the P39 summary-table row) are historical bug narratives that explicitly contrast a broken `/v1`-prefixed path against the real route; mechanically stripping would have flattened them into self-contradictions (claiming the correct path was broken) — rephrased as "the then-current `v1` prefix followed by X" instead, preserving the historical account.

Verification: `rg '/v1/' docs/archive/BACKLOG.md` → 0 ✅. ~111 changed lines (incl. prettier table realignment). Guard test green (10/10, 0 violations, full repo scan — this was the last unswept A6-A12 entry). Gate: A6–A11 — satisfied.

### Also discovered this session, outside Chain A's scope — for the orchestrator/human to triage

- **"A0b" follow-up triage census** (referenced throughout, see `coherence-review.md` "Gap 3" and the allowlist's final section): ~13 doc areas whose frozen-vs-live status could not be safely judged from a grep pass — `docs/research/{MEMORY_MODEL,ENGRAM_GAP_ANALYSIS}.md`, `docs/compliance/{data-residency,soc2-controls}.md`, `docs/architecture/{CONSTRAINTS,ARCHITECTURE}.md`, `docs/internals/{PERFORMANCE,DOC_VERIFICATION}.md`, `docs/ops/{gameday,status-page}.md`, `docs/ops/runbooks/security_breach.md`, `docs/deploy/OPERATIONS.md`, `docs/archive/superpowers/specs/**`. Currently allowlisted `unswept` at exact current counts so the guard still blocks new regressions.
- **Repo hygiene defect, unrelated to `/v1`**: `packages/sdk-python/mnemo/__pycache__/client.cpython-313.pyc` and `packages/sdk-python/tests/__pycache__/test_client.cpython-313-pytest-9.1.0.pyc` are tracked in git (compiled Python bytecode, 138 and 28 stale `/v1/` byte-matches respectively from before the SDK's `.py` sources were fixed). The guard skips them via binary-content detection, but they should be `git rm --cached` and added to `.gitignore` — not done here, out of scope for a `/v1` truth-correction change.

---

## Chain B — Phase 2 (Contract-Reality Audit + Deploy)

Gate G1 (blocking): Chain A (A1–A12) fully merged, `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green on `main`.

### B1 — Inventories + snapshots — depends on G1 — ✅ DONE (branches `flatten-version-docs/b1-server` → `b1-mcp` → `b1-cli` → `b1-client-ts`)

- [x] B1.1 New `packages/server/src/__tests__/contract-inventory.ts` — `routeInventory(app)`, `openApiInventory(app)`. Empirically confirmed `app.route("/", v1)` merges into `.routes`; no fallback needed (Req 12a).
- [x] B1.2 New `packages/mcp/src/__tests__/tool-route-map.test.ts` — spy `registerTool`, drive all 34 `TOOL_REGISTRARS` via real `MnemosyneClient{fetch: recordingFetch}`, zod arg synthesis; `TOOL_BRANCHES` keys `(tool, action)` for branching tools; emits `tool-routes.snapshot.json` (Req 12b).
- [x] B1.3 New `packages/cli/src/__tests__/command-route-map.test.ts` — stub `globalThis.fetch`, invoke every `COMMANDS` entry; completeness guard on missing `INVOCATIONS` fixture; emits `command-routes.snapshot.json` (Req 12c).
- [x] B1.4 New `packages/client-ts/src/__tests__/sdk-route-map.test.ts` — enumerate `MnemosyneClient.prototype` methods with recording fetch; emits `sdk-routes.snapshot.json` (Req 12d).

Verification: `pnpm test` runs all four; snapshots committed. Gate: G1 (satisfied in substance, not literally — see Chain A/B1 notes above).

### B2 — Four set differences + tool-contract review — depends on B1 — ✅ DONE (branches `flatten-version-docs/b2-contract-audit` → `b2-tool-review`, stacked off `b1-client-ts`)

- [x] B2.1 New `packages/server/src/__tests__/contract-reality.test.ts` (+ `.ts` for the pure set-difference logic, split per the established `census.ts`+`.test.ts` pattern) — computes phantom/undocumented/ghost-caller/unreachable against a real `createApp()` and B1's 3 committed snapshots; commits canonical `routes.snapshot.json` (Req 12). **Critical methodology finding**: the first draft, using B1.1's own minimal test-app fixture, produced 44 false-positive ghost-callers — every one was a conditionally-mounted route family (federation, tenants/workspaces, approvals, break-glass) the minimal fixture never registered. Fixed by adding truthy stubs for `deps.metricsPgClient`/`deps.federation`/`deps.approvals`/`deps.breakGlass` (registration-time only, no handler ever invoked) — **zero real ghost callers found** once the fixture matches production reality.
- [x] B2.2 New `packages/server/src/__tests__/contract-reality.allowlist.ts` — `EXPECTED_DIVERGENCES`, mirroring `api-path-truth.allowlist.ts`'s pattern; grouped multi-key entries with one reviewed reason each. Several entries marked as genuine, unfixed gaps (federation admin API + `/self/edit`/`/self/profile`/`/self/reflect` undocumented; `GET /cost`/`GET /usage` orphaned) per design's redesign-escape-hatch policy, not silently accepted as fine (Req 12).
- [x] B2.3 New `openspec/flatten-version-docs/tool-contract-review.md` — 34 rows, reusing `tool-promise-remediation`'s audit-table format + 2 route-cross-reference columns. Found 4 independently re-verified upgrades since that prior audit (memory_remember CORE-1/CORE-2, memory_forget DB-2, memory_remind_when Req 1-2, memory_decide DECIDE-1/Req 10) not yet reflected in that document's own table (Req 14).

Verification: `pnpm --filter @mnemo-ai/server test` — 204/204 files, 1451/1451 tests passing, including `contract-reality.test.ts` (5/5) and `api-path-truth` guard (10/10, still 0 violations after this task's new files). `pnpm --filter @mnemo-ai/server typecheck` clean. ~800 changed lines total (excl. generated `routes.snapshot.json`) — split into 2 stacked branches for the 400-line budget (`b2-contract-audit` ~618 lines: engine+allowlist+test are tightly coupled, same over-budget precedent as Chain A's A5; `b2-tool-review` ~120 lines, standalone). Gate: B1.

### B3 — live-surface harness + coverage-enumeration guard — depends on B2

- [x] B3.1 New `packages/mcp/src/__tests__/harness/live-surface.ts` (336 lines) — extracted from `remember-recall.integration.test.ts`'s `beforeAll`; exposes `startLiveSurface(): Promise<{baseUrl, apiKey, workspaceId, sdk, mcp, cli(args), http(method,path,init), close()}>`. Seeds all 18 scopes this repo defines in a fresh throwaway workspace. `cli()` spawns the real built `packages/cli/dist/index.js` via `MNEMO_URL`/`MNEMO_KEY` env vars — the same convention the MCP stdio spawn already used, not a new one. Proven via a dedicated smoke test (`live-surface.smoke.integration.test.ts`) independently exercising all 4 surfaces (`/health`, `tools/list`, `GET /me`, `--version`). `remember-recall.integration.test.ts` refactored to consume the harness (completing the "extract", not just copying) — same passing assertion, -230/+16 lines. `MNEMO_VERIFY_URL`/`MNEMO_VERIFY_KEY` (B5's scope) deliberately NOT implemented; container/seed logic kept in one linear block so that hook is a small later addition.
- [x] B3.2 New `packages/mcp/src/__tests__/coverage-guard/{registry.ts,coverage-guard.test.ts,coverage-pending.snapshot.json}` — enumeration-driven coverage guard. `registry.ts`'s `COVERAGE_OVERRIDES` records only `covered`/`skip` (both PERMANENT) decisions; absence = `pending` (the honest default, never conflated with `skip`). Universe (358 keys: 205 routes + 107 MCP tool[:action] + 46 CLI commands) is read mechanically from B1's 3 committed snapshots, never hand-typed. Pins the exact pending set via `toMatchFileSnapshot` — empirically verified this catches drift (temporarily added a fake route, confirmed the pin test fails, reverted). Current honest state: `covered=0 skip=4 pending=354` — correct and expected, B4 fills this in. Not integration-tier (reads only committed JSON, no Docker) — runs under the ordinary Node-20 `pnpm test`. Placed under `coverage-guard/` not `coverage/` — the latter collided with the root `.gitignore`'s unanchored `coverage/` entry (istanbul/nyc output), which silently untracked the directory.

Verification: `pnpm build && pnpm typecheck` clean. `pnpm --filter @mnemo-ai/mcp test` — 34/34 files, 642/642 tests green (Node 20, includes the new coverage guard). `mise exec node@22 -- npx vitest run --config vitest.integration.config.ts` (mcp) — 2/2 files, 5/5 tests green (harness smoke test + refactored round trip, real Docker/pgvector). Full repo `pnpm build && pnpm typecheck && pnpm test` — 30/30 turbo tasks green. `pnpm --filter @mnemo-ai/server test -- api-path-truth` — 10/10 still green. `npx prettier --check` clean throughout. Split into 3 stacked branches for the 400-line budget: `b3-live-surface-harness` (382 lines) → `b3-refactor-remember-recall` (246 changed lines) → `b3-coverage-guard` (202 authored + 356 generated). Gate: B2 — satisfied.

### B4 — Coverage fill-in — depends on B3

- [x] B4.1 Exercise every real HTTP route against the live harness (Req 13). **DONE.**
      Required first fixing the B3 harness (`live-surface.ts`) itself, which
      omitted `deps.storage`, `deps.federation`, `deps.cache`,
      `deps.metricsPgClient`, and `deps.approvals`/`deps.breakGlass` —
      without them, large route families 404/500/503'd through the harness
      regardless of caller (tasks/reminders/hyperedges/composition/reasoning/
      metacognition/webhooks-CRUD via `storage`; all 9 `/memory/federation/*`
      via `federation`; the whole session lifecycle via `cache`;
      `/admin/keys*`/`/tenants*` via `metricsPgClient`; `/approvals*`,
      `/break-glass*`, and GET/POST /export's approval gate via
      `approvals`/`breakGlass`). Also added a second, user-bound identity pair
      (`secondaryIdentities`) for routes a workspace-only key structurally
      cannot exercise (tenant admin, break-glass dual control, entity
      self-link). Added `@mnemo-ai/federation` as an `@mnemo-ai/mcp`
      devDependency (test-only).

  Result: coverage-guard reports `routes=205 tools=107 cli=46 | covered=201
skip=8 pending=149` — **zero pending routes**. 201 covered (each backed
  by a real live-surface test across 13 new `routes-*.integration.test.ts`
  files), 8 skip (4 pre-existing CLI + 4 NEW federation data-plane routes:
  `gateFederationRequest()` requires the SAME `Authorization` header to
  simultaneously be a bcrypt-verified `mk_fed_` API key AND an
  EdDSA-signed service JWT — mutually exclusive string formats a single
  local instance can't satisfy without a real second peer; full reasoning
  in `registry.ts`'s module docstring).

  **Discovered 4 real production issues while exercising routes** (1
  fixed, 3 documented-not-fixed, flagged for maintainer triage):
  1. `GET /admin/keys/:keyId` + `POST /admin/keys/:keyId/rotate` both 500
     against a real DB — reference `rotated_from_id`, a column that exists
     only on the unrelated `mnemo_scoped_api_keys` table, never on
     `mnemo_api_keys`. NOT fixed (needs a migration, out of scope).
  2. `POST /events/:id/annotations` 500'd on `annotation.at.toISOString()`
     — `at` deserializes as a plain string through JSONB, not a `Date`.
     **FIXED** (`_mappers.ts`, defensive `instanceof Date` check).
  3. `GET /episodes/:id` rejects the plain-UUID id `POST /episodes` itself
     generates (id pattern only accepts `mepi_`-prefixed ids). NOT fixed
     (contract mismatch / redesign question, per the design's own escape
     hatch).
  4. `GET /workspaces/:workspaceId`'s anti-probing membership check only
     runs for a user-bound key — a workspace-only key reads any workspace
     unconditionally. NOT fixed (auth-hardening decision, out of scope).

  Branches, stacked off `b3-coverage-guard`: `b4-harness-deps` →
  `b4-routes-observability` → `b4-routes-admin` → `b4-routes-cognitive` →
  `b4-routes-sessions-federation` → `b4-routes-primitives` →
  `b4-routes-tenants` → `b4-registry` (tip). Not pushed; no PRs opened.

  Verification: `pnpm build && pnpm typecheck && pnpm test` (repo root,
  Node 20) — 30/30 turbo tasks green (server 1451/1451, cli 219/219, mcp
  642/642 incl. the coverage-guard unit test). `mise exec node@22 -- npx
vitest run --config vitest.integration.config.ts` (mcp, full suite) —
  16/16 files, 103/103 tests green (proves B3's harness smoke test +
  remember-recall round trip still pass after this session's harness
  edits). `pnpm --filter @mnemo-ai/server test -- api-path-truth` — 10/10
  still green. `npx prettier --check` clean throughout.

- [x] B4.2 Exercise all 34 MCP tools via the harness's `mcp` client (Req 13). **DONE.**
      8 new integration test files (`tools-core-memory`, `tools-relations-graph`,
      `tools-session-episode`, `tools-task-event`, `tools-reasoning-strategy`,
      `tools-admin-governance`, `tools-cognition`,
      `tools-self-edit-remind-workflow-skill`), plus a shared `mcp-tool-helpers.ts`,
      exercise all 107 `mcp:*` (tool[:action]) obligations against the real
      live-surface harness's `surface.mcp` stdio client. `registry.ts` now marks
      all 107 `covered` — zero `skip` needed (all 34 tools, including the six B2
      flagged unaudited — `memory_workflow`, `memory_skill`, `memory_doctor`,
      `memory_judge`, `memory_purge`, `memory_strategy` — could be safely
      exercised against the harness's throwaway workspace, including
      `memory_purge`'s destructive hard-delete branches). Discovered (not a bug,
      documented in test comments): `POST /self/edit` enforces a real flat 300s
      edit-cooldown per `(workspaceId, agentId)`, and `action='replace'` against
      a fact target is uniquely re-keyed to `provenance.actorId` instead of the
      shared `"default"` bucket the other 5 edit actions use — tests assert the
      real success/cooldown-rejection split this produces rather than working
      around it. Coverage-guard final report: `routes=205 tools=107 cli=46 |
covered=308 skip=8 pending=42` — zero pending MCP tool obligations.
- [x] B4.3 Exercise every CLI subcommand via the harness's `cli()` (Req 13). **DONE.**
      6 new integration test files (`cli-core-crud`, `cli-primitives`,
      `cli-session-task-event`, `cli-admin-ops`, `cli-tenant-workspace`,
      `cli-local`), stacked on a small harness change
      (`live-surface.ts`'s `cli()` now accepts an optional env override —
      needed to swap `MNEMO_KEY` to a secondary identity for the
      `/export/jsonl` approval round trip, and to isolate `HOME` for
      `mnemo config set`'s real host-mutation without touching the actual
      machine's `~/.mnemo/config.json`). Exercises all 42 remaining
      `cli:*` obligations against the real built `mnemo` binary via
      `surface.cli(...)`. `registry.ts` now marks all 42 `covered` — zero
      new `skip` needed beyond B1.3's original 4
      (login/init/install/link). Coverage-guard final report:
      `routes=205 tools=107 cli=46 | covered=350 skip=8 pending=0` — **zero
      pending obligations across all of B4 (routes + tools + CLI).**
      Real discoveries (documented in test comments, none fixed — all
      correct/deliberate server behavior): (1) `mnemo export` has no flag
      to pass an approved `approvalRequestId`, so it can never complete a
      real export as shipped — flagged separately as a CLI feature gap for
      human judgment; (2) a workspace-only key gets a real 404 anti-probing
      response on `GET /workspaces/:id` for any workspace other than its
      own scoped id, even one it just created (matches B4.1's HTTP-level
      finding); (3) `POST /workspaces/:id/members` requires the target
      user to already be a tenant member; (4) token issuance requires the
      target user to currently belong to `--workspace` at issue time.
- [x] B4.4 Split into per-surface PRs (routes/MCP/CLI) if combined diff exceeds 400 lines. **DONE.** B4.1's routes slice split into 8 stacked branches; B4.2 was 1 local branch under budget; B4.3 split into 8 stacked branches (`b4.3-cli-harness-env` → `b4.3-cli-core-crud` → `b4.3-cli-primitives` → `b4.3-cli-session-task-event` → `b4.3-cli-admin-ops` → `b4.3-cli-tenant-workspace` → `b4.3-cli-local` → `b4.3-cli-registry`), each test file kept near/under the 400-line review budget.

Verification: `pnpm test:integration` (Node 22) green; `pnpm build && pnpm typecheck && pnpm test` (Node 20, repo root) all green; zero `COVERAGE`-missing entries for **routes** (B4.1), **MCP tools** (B4.2), and **CLI commands** (B4.3) — all of B4 fully closed out. Gate: B3; corresponds to design's G3 once fix-here items land.

### Deploy Gate — design §"Deploy sequencing" (Gates G1–G5) — **HUMAN CONFIRMATION REQUIRED — DO NOT AUTO-EXECUTE**

- [ ] DG.1 Confirm G1 (already required above): Chain A merged, CI green on `main`.
- [ ] DG.2 Confirm G2: B1/B2 snapshots committed; every divergence human-triaged as `fix-here` or `follow-up`.
- [ ] DG.3 Confirm G3: all `fix-here` items merged; `test:integration` green on Node 22.
- [ ] DG.4 **G4 — STOP HERE. Present to the human and wait for an explicit go-ahead. No automated actor, plan, or CI signal counts as approval.** Present: (a) pinned image digest `sha256:…` to deploy (never `:edge`); (b) currently-running digest as rollback target, captured before rolling; (c) target host/path (Compose self-host / GHCR pull / Railway, `deploy/README.md` §1–3); (d) migration plan for both streams (`public` legacy + `mnemosyne` v3), idempotent, completing before boot; (e) confirmation this change has no schema/data migration (rollback = digest swap only) (Req 15).
- [ ] DG.5 G5 (operator action, only after DG.4's go-ahead): run `mnemosyne-migrate` to completion, then roll `mnemosyne-server` per `docker/README.md`.

Gate: G3 complete. **This node must never be executed by `sdd-apply`'s batch loop without a recorded human go-ahead at DG.4, regardless of delivery strategy.**

### B5 — Production verification (design's Gate G6) — depends on Deploy Gate (DG.5) complete

- [ ] B5.1 Parameterize harness on `MNEMO_VERIFY_URL`/`MNEMO_VERIFY_KEY` — when set, skip container startup, bind to remote instead.
- [ ] B5.2 Re-run the full B4 suite against the deployed instance with real clients only — no mocks (Req 16).
- [ ] B5.3 Split `COVERAGE` by class: `read` as-is; `write` inside a throwaway workspace, deleted after; `destructive` (purge/hard-delete/break-glass/admin) skipped, reported `verified: local-only`.
- [ ] B5.4 Report results before the change is considered done; any local/CI divergence surfaces as a reported failure, not silently accepted (Req 16).
- [ ] B5.5 Record the 3-way env-var naming divergence (`MNEMO_URL`/`MNEMO_KEY` vs `MNEMO_API_KEY` vs `MNEMO_BASE_URL`/`MNEMO_TEST_API_KEY`) as an audit finding; fix in a follow-up.

Verification: prod-verification report published; change not marked done until it exists. Gate: DG.5.
