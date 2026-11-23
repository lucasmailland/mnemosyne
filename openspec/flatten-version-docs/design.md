# Design: flatten-version-docs

## Technical Approach

Two halves, **two independent delivery chains**, one gate between them.

|             | Chain A — `/v1` truth-correction (Tiers 0–5) | Chain B — Phase 2 (contract-reality + deploy)                       |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------- |
| Nature      | Mechanical text + 13 broken call sites       | New introspection harness + irreversible prod action                |
| Risk class  | Revertible, no behavior change               | Findings may be redesign-class; ends in a shared-system mutation    |
| Deliverable | Corrected corpus + one vitest guard          | Committed contract snapshots + full-surface suite + verified deploy |
| Gate        | —                                            | Chain A merged, CI green on `main`                                  |

The durable artifact in **both** halves is the same shape: a **committed inventory that CI diffs on every run**. Chain A pins "where `/v1/` is allowed to exist"; Chain B pins "which (method, path) pairs exist and who calls them". Neither is a one-shot sweep, because a one-shot sweep is exactly what produced this debt on 2026-06-25.

---

## Half 1 — Chain A

### A0. Blocking pre-step: re-census before the tier allowlist is frozen

The proposal's tier classification is correct but its **file inventory is incomplete**. A `/v1/` census taken during this design found six areas the proposal's tier lists do not name. The allowlist cannot be authored until each is classified, so this runs first, as part of PR A1.

| Found                                                                  | Occurrences              | Proposed tier                                                                                        | Why it matters                                                                                |
| ---------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/mock-server/src/app.ts` + `README.md`                        | 10 + 11                  | **2** (comments only — verified: all 21 are `//` comments and a header block, no mounted `/v1` path) | A whole package missing from the Tier 2 boundary list → needs its own sweep PR                |
| `packages/adapter-postgres/migrations/baseline/0019_session_label.sql` | 1                        | **3 — must allowlist**                                                                               | An _applied_ migration. Editing it changes its checksum. The guard must never force this edit |
| `docs/archive/superpowers/plans/**`                                    | ~250 (wave-S alone: 126) | **3**                                                                                                | Proposal names `docs/archive/superpowers/specs/` only                                         |
| `docs/archive/sdd/archive/**`                                          | ~110                     | **3**                                                                                                | Sealed SDD records; not named at all                                                          |
| `openspec/flatten-version-docs/**`                                     | 27 and growing           | **3 — must allowlist**                                                                               | The guard would otherwise fail on the PR that introduces it                                   |
| `docs/archive/BACKLOG.md`                                              | 40                       | **open — see Q1**                                                                                    | A _live_ reader-facing doc; allowlisting it weakens the guard's own promise                   |
| `packages/federation/src/MtlsAuthAdapter.ts`                           | 2                        | **must classify: 2 or 4**                                                                            | Unverified whether these are our federation routes or a peer's third-party path               |

Output of A0 is the allowlist file itself, reviewed as data before any sweep runs.

### A1. Guard design (Tier 5)

**Home**: `packages/server/src/__tests__/api-path-truth.test.ts`, with data split into `api-path-truth.allowlist.ts`.

| Decision                                                                                      | Chosen                                                    | Rejected                                         | Rationale                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which package hosts a **repo-wide** guard                                                     | `@mnemo-ai/server`                                        | `@mnemo-ai/types` (hosts the other purity guard) | The claim being guarded — "there is no `/v1` path segment" — is _proved by_ `packages/server/src/app.ts:577` and `versioning.ts`. A failing guard should land the reader in the package that owns the truth. `types` would be arbitrary |
| Guard as vitest vs. root script                                                               | vitest test                                               | root `scripts/*.mjs` + CI step                   | Repo convention is explicit and load-bearing: `CLAUDE.md` warns that guards are vitest tests, _not_ lint scripts. A script would need new CI wiring and would be invisible to `pnpm test`                                               |
| Turborepo cache staleness (a `/v1/` added in `docs/` not invalidating a cached `server#test`) | Non-issue — **verified**                                  | Declaring `$TURBO_ROOT$` inputs                  | `turbo.json` already sets `"cache": false` on the `test` task. The guard re-runs every invocation                                                                                                                                       |
| File enumeration                                                                              | `git ls-files -z` from repo root, read + count in-process | `git grep -c`                                    | An in-process pure counting function is unit-testable with an in-memory fixture map; `git grep` would put the logic in flag semantics. Cost is ~1s                                                                                      |
| Not a git checkout                                                                            | **Throw loudly**                                          | Skip silently                                    | `CONTRIBUTING.md` design principle: "No silent failures." A guard that no-ops outside git is a guard that no-ops in the one place it matters                                                                                            |

**Match pattern**: the literal `/v1/` (with trailing slash), per the proposal. A deliberate consequence: the Tier 3 banner text must be written as `` `/v1` `` (**no trailing slash**) so adding banners does not perturb pinned counts and does not itself trip the guard.

**Allowlist shape** — two kinds, because the two out-of-scope tiers have opposite growth behavior:

```ts
export type Allowance =
  | {
      kind: "frozen"; // Tier 3 — sealed history
      path: string; // repo-relative file, or prefix ending in "/"
      expected: number; // EXACT occurrence count, pinned
      reason: string;
    }
  | {
      kind: "foreign"; // Tier 4 — third-party versioned APIs
      path: string;
      pattern: RegExp; // e.g. /\/api\/v1\/query/  — narrow, not blanket
      reason: string;
    }
  | {
      kind: "unswept"; // TEMPORARY — Tier 2 packages not yet swept
      path: string; // prefix, e.g. "packages/server/src/routes/"
      expected: number;
      sweptBy: string; // the chained PR that deletes this entry
    };
```

Three properties fall out of this shape, and they are the point of it:

1. **`frozen` uses `expected` as an exact equality, not a ceiling.** Over-count catches a new false `/v1/` slipping into a CHANGELOG. Under-count catches someone "cleaning" frozen history — which the proposal forbids and which a `≤` ceiling would silently permit.
2. **`foreign` is pattern-scoped, never path-blanket.** `scripts/collect-soc2-evidence.sh` is allowed to contain `/api/v1/query`; it is not allowed to contain `/v1/recall`.
3. **`unswept` makes each Tier 2 PR self-verifying.** Every sweep PR deletes its own `unswept` entry. If the sweep is partial, the entry's removal makes the count non-zero and CI fails. A half-done sweep cannot merge — which is precisely the 2026-06-25 failure mode.

**Self-test without polluting the repo**: the scan is a pure function

```ts
export function census(
  files: ReadonlyMap<string, string>, // repo-relative path -> contents
  allowlist: readonly Allowance[]
): Violation[];
```

The success criterion "the guard fails on a newly introduced `/v1/`" is asserted against an in-memory fixture map, not by mutating a real file.

### A2. Full-path assertions and `cmdImport`'s first tests (Tier 0)

The bug class is that `.toContain("/export/jsonl")` passes against `${url}/v1/export/jsonl`. The fix is not a better string — it is **parsing the URL**:

```ts
// packages/cli/src/__tests__/helpers/expect-request.ts  (new, shared)
export function expectRequest(
  call: { url: string; opts?: RequestInit },
  expected: { method?: string; pathname: string; search?: Record<string, string> }
): void {
  const u = new URL(call.url);
  expect(u.pathname).toBe(expected.pathname); // exact — not a substring
  if (expected.method) expect(call.opts?.method ?? "GET").toBe(expected.method);
  if (expected.search) {
    expect(Object.fromEntries(u.searchParams)).toEqual(expected.search);
  }
}
```

`pathname` equality is base-URL-agnostic and query-agnostic, so it survives config changes while still failing on a stray prefix. Rollout is staged so it does not inflate A1: the helper ships in A1 and is applied to `export`/`import` there; the ~60 remaining `toContain("/…")` assertions in `primitive-parity.test.ts` and `workspace-tenant-parity.test.ts` are migrated in **A10**, the PR that already touches `packages/cli`.

**`cmdImport` — first-ever coverage.** Five cases, chosen against the actual code at `commands.ts:209–260`, not against a guess:

| #   | Case                                       | Asserts                                                                                                                                                                                              |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `import fixture.jsonl.gz`                  | `POST` `/import`, empty search, `Content-Type: application/octet-stream`, `Authorization: Bearer …`, body byte-length == file                                                                        |
| 2   | `--from mem0 --conflict-resolution newest` | search is exactly `{from: "mem0", conflictResolution: "newest"}` — pins both the qs builder and the subtle `flagValues` set at `:219` that keeps flag _values_ from being mistaken for the file path |
| 3   | Missing file path                          | usage line printed, `exit 1`                                                                                                                                                                         |
| 4   | Unreadable file                            | `Error reading file:` printed, `exit 1`                                                                                                                                                              |
| 5   | Non-2xx response                           | server error surfaced, `exit 1`                                                                                                                                                                      |

Case 2 also pins a latent defect worth recording: a trailing `--from` with no value leaves `from === undefined`, so `flagValues` contains `undefined` and the file-path heuristic degrades. The test documents current behavior; changing it is out of scope here.

### A3. Sequencing and PR chain (auto-chain, ≤400 changed lines each)

Order follows the proposal's Approach §1–7. Counts are measured, not estimated.

| PR      | Tier | Scope                                                                                                                                                                                                                                                | ~lines | Gate                                              |
| ------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------- |
| **A1**  | 0    | 13 executable call sites (`commands.ts` ×2, `loadtest/run.ts` ×2, `load/k6/*.js` ×9) + `expectRequest` helper + full-path export test + 5 new `cmdImport` tests + **A0 census**                                                                      | ~120   | —                                                 |
| **A2**  | 1    | `docs/STATUS.md` (line 611 + the export/import certification rows), `README.md:194` alt, `.github/assets/session-pipeline.svg` (`<desc>` + 3 `<text>`), CLI help `:3853`, `app.ts:461` comment                                                       | ~40    | A1 merged (STATUS may only describe a landed fix) |
| **A3**  | 1    | Live architecture docs (FEDERATION, ARCHITECTURE_OVERVIEW, IDEMPOTENCY_STRATEGY, MCP_SESSION_TOOL, SDK_INTEGRATION, OBSERVABILITY, ALGORITHMS, STABILITY, package READMEs, `load/README.md`, `loadtest/README.md`) **+ versioning-coherence review** | ~180   | A2                                                |
| **A4**  | 3    | One clarifying banner line per frozen doc (2 CHANGELOGs, 3 dated audits, 4 completion reports). Banner uses bare `` `/v1` ``                                                                                                                         | ~10    | A3                                                |
| **A5**  | 5    | Guard + allowlist + guard unit tests. Ships with **`unswept` entries for every Tier 2 boundary below**                                                                                                                                               | ~280   | A4                                                |
| **A6**  | 2    | `packages/server/src/routes/` — 129 occurrences / 37 files                                                                                                                                                                                           | ~130   | A5                                                |
| **A7**  | 2    | `packages/server/src/` non-routes (`app.ts` remainder, `deps`, `grpc`, `index`, `ws`, `telemetry`, `metrics`)                                                                                                                                        | ~30    | A5                                                |
| **A8**  | 2    | `packages/server/src/__tests__/` — 173 / 46 files (test _titles_ are reader-facing)                                                                                                                                                                  | ~175   | A5                                                |
| **A9**  | 2    | `packages/mcp/` (`src/tools/*`, `src/index.ts`, `README.md`)                                                                                                                                                                                         | ~25    | A5                                                |
| **A10** | 2    | `packages/client-ts/` (~57) + `packages/types/` + `packages/cli/` **+ migrate remaining `toContain` path assertions to `expectRequest`**                                                                                                             | ~140   | A5                                                |
| **A11** | 2    | `packages/mock-server/` (21) + `adapter-postgres/src/repositories/` + `packages/federation/` (after A0 classification)                                                                                                                               | ~25    | A5                                                |
| **A12** | —    | Close matching `docs/archive/BACKLOG.md` items (+ sweep its `/v1/` if Q1 resolves that way)                                                                                                                                                          | ~45    | A6–A11                                            |

A6–A11 are order-independent siblings of A5 and may land in any sequence or in parallel; each deletes exactly one `unswept` entry, so partial completion cannot merge. A7/A9/A11 are small enough to combine if reviewers prefer fewer PRs.

**Boundary rule**: the split is by _package/directory_, never by "first N occurrences". A reviewer of A6 can hold one mental model — "server route JSDoc" — and needs no context from A8.

**Stall safety** (proposal §2): if the chain is cut after A5, the repo is strictly better — nothing executable is broken, nothing authoritative lies, and the `unswept` entries keep the guard blocking _new_ regressions in the packages that were never swept.

### A4. Versioning-coherence review — how it is executed, not just asserted

A read-and-confirm pass is easy to fake. Make it produce evidence: A3 adds one row per reviewed doc to a table in `openspec/flatten-version-docs/coherence-review.md`.

| Doc                        | Discusses versioning? | `Mnemosyne-Version` described? | Action                   |
| -------------------------- | --------------------- | ------------------------------ | ------------------------ |
| `docs/architecture/API.md` | yes                   | yes                            | reference — unchanged    |
| …                          | yes/no                | yes/no/**gap**                 | none / one-line addition |

`docs/architecture/API.md` is the reference oracle. Any row marked **gap** gets a one-line addition pointing at `packages/server/src/versioning.ts` — not new documentation, just refusing to let a subtraction remove the only true statement.

---

## Half 2 — Chain B (Phase 2)

### B0. Core decision: the audit is executable, not a document

| Option                                                                      | Verdict                                                                                                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A one-time manual cross-reference producing a markdown findings list        | **Rejected.** Identical in kind to the 2026-06-25 sweep. Its output rots the day after it merges, and the whole premise of this change is preventing a third round |
| A standalone `scripts/audit-contracts.mjs` an operator remembers to run     | **Rejected.** Nothing forces it. Same failure mode as STATUS.md's ✅ for unexecuted code                                                                           |
| **Introspection tests that emit a committed snapshot and fail CI on drift** | **Chosen**                                                                                                                                                         |

The audit's deliverable _is_ the snapshot files. They are the "concrete list" the proposal's success criteria demand, and they are re-derived on every `pnpm test`. A new route, a renamed path, or a new MCP tool shows up as a reviewable diff in the PR that introduces it.

### B1. The five inventories and how each is introspected

Everything below is machine-derived. No surface is enumerated by hand.

| #   | Inventory                   | Mechanism                                                                                                                                                                                                                                                                                                                                                            | Verified hook                                                                                    |
| --- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | **Registered routes**       | `createApp(...)` → read `app.routes` (Hono's public `RouterRoute[]`: `{method, path, handler}`). Hono's `app.route("/", v1)` re-registers the sub-app's routes onto the parent, so the flat list is complete                                                                                                                                                         | `packages/server/src/app.ts:108,577`                                                             |
| 2   | **OpenAPI spec**            | `await app.request("/openapi.json")` in-process — no server boot, no Docker. `mountOpenApi` already serves it                                                                                                                                                                                                                                                        | `packages/server/src/openapi.ts:19`                                                              |
| 3   | **MCP tool → HTTP path**    | Re-use `registry.test.ts`'s proven trick: spy `server.registerTool` to capture `(name, config, handler)` for all `TOOL_REGISTRARS`. Drive each captured `handler` with a **real** `MnemosyneClient` constructed with `{ fetch: recordingFetch }`, and args synthesized from that tool's own `inputSchema` zod shape. Record the `(method, pathname)` actually issued | `registry.test.ts:19–23`; `MnemosyneClient` accepts `options.fetch` (`client.ts:200`)            |
| 4   | **CLI command → HTTP path** | `COMMANDS` is an exported record. Stub `globalThis.fetch`, invoke each command, record `(method, pathname, search)`                                                                                                                                                                                                                                                  | `packages/cli/src/commands.ts` exports `COMMANDS`; already used by `primitive-parity.test.ts:12` |
| 5   | **SDK method → HTTP path**  | Enumerate `MnemosyneClient.prototype` own method names via `Object.getOwnPropertyNames`; invoke each with a recording `fetch`                                                                                                                                                                                                                                        | `client.ts:191`                                                                                  |

**Zod arg synthesis (3)** is ~60 lines and fully general: `string → "x"`, `number → 1`, `boolean → false`, `enum → first member`, `array → []`, `object → recurse`, `optional → omit`. Handlers are invoked directly (bypassing the SDK's own validation, as `registry.test.ts` already does), so a minimal-valid object is sufficient. This is what makes the MCP inventory **self-maintaining**: adding a registrar to `TOOL_REGISTRARS` automatically enrolls the tool.

**CLI arg synthesis (4) cannot be derived** — CLI flags are ad-hoc `args.indexOf("--flag")` parsing with no machine-readable schema. This is the one place a fixture table is unavoidable, so the design makes the _checklist_ automatic even though the _inputs_ are not:

```ts
// completeness is enforced, inputs are not derivable
const missing = Object.keys(COMMANDS).filter((c) => !(c in INVOCATIONS));
expect(missing).toEqual([]); // a new command with no fixture fails CI
```

That inversion is the whole answer to "not by manually listing them": you cannot auto-generate CLI inputs, but you can auto-generate the obligation to provide them. `cmdImport` shipped with zero coverage precisely because no mechanism ever computed that obligation.

### B2. The audit itself — four set differences

With inventories 1–5 in hand, the entire structural audit is four assertions plus one snapshot:

| Assertion                                       | Finds                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `openApiPaths \ routePaths`                     | **Phantom endpoints** — documented, not implemented                                   |
| `routePaths \ openApiPaths`                     | **Undocumented endpoints** — implemented, not in the spec                             |
| `(mcpPaths ∪ cliPaths ∪ sdkPaths) \ routePaths` | **Ghost callers** — exactly the `/v1/export/jsonl` bug class, now caught structurally |
| `routePaths \ (mcpPaths ∪ cliPaths ∪ sdkPaths)` | **Unreachable routes** — informational, feeds B3's coverage target                    |

Each difference is compared against a committed `EXPECTED_DIVERGENCES` list carrying a one-line reason per entry. Known-and-accepted gaps stay green; a _new_ gap fails. This mirrors the `unswept` mechanic from Chain A: an allowlist you must shrink deliberately.

**Where the tests live** (each next to the surface it introspects, so a package owner is the reviewer):

| File                                                     | Owns                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/server/src/__tests__/contract-inventory.ts`    | Pure helpers: `routeInventory(app)`, `openApiInventory(app)`, canonical sort/serialize |
| `packages/server/src/__tests__/contract-reality.test.ts` | The four set differences + `routes.snapshot.json`                                      |
| `packages/mcp/src/__tests__/tool-route-map.test.ts`      | 34 tools → paths + `tool-routes.snapshot.json`                                         |
| `packages/cli/src/__tests__/command-route-map.test.ts`   | `COMMANDS` → paths + completeness guard                                                |
| `packages/client-ts/src/__tests__/sdk-route-map.test.ts` | SDK methods → paths                                                                    |

**Semantic promises stay human.** "No MCP tool description promises a capability that doesn't exist" is a natural-language judgment; no set difference decides it. Design: the MCP test _generates_ `openspec/flatten-version-docs/tool-contract-review.md` — 34 rows of `tool name | description | recorded (method, path) | that route's OpenAPI summary + response schema` — and a human reviews 34 pre-assembled rows instead of reading 34 files. `docs/archive/openspec/tool-promise-remediation/` already established this review format (see the audit block in `packages/mcp/src/tools/pin.ts:17–39`); reuse it verbatim rather than inventing a second one.

### B3. Full-surface test coverage — architecture

**Extend the existing harness; do not build a new one.** `packages/mcp/src/__tests__/remember-recall.integration.test.ts` already does the hard part end-to-end: pgvector testcontainer → both migration streams via built CLIs → **real** Hono app bound to a real loopback port via `@hono/node-server`'s `getRequestListener` → real MCP stdio child process pointed at it via `MNEMO_URL`/`MNEMO_KEY`.

Extract its `beforeAll` into a reusable `packages/mcp/src/__tests__/harness/live-surface.ts` exposing:

```ts
interface LiveSurface {
  baseUrl: string;
  apiKey: string;
  workspaceId: string;
  sdk: MnemosyneClient; // real client-ts
  mcp: Client; // real MCP stdio client
  cli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
  http(method: string, path: string, init?: RequestInit): Promise<Response>;
}
```

Then coverage becomes **enumeration-driven**, not list-driven — the same inversion as B1:

```ts
for (const route of routeInventory(app)) {
  const plan = COVERAGE[key(route)];
  it(`${route.method} ${route.path} is exercised`, ...);
}
expect(routeInventory(app).filter((r) => !(key(r) in COVERAGE))).toEqual([]);
```

Every route, all 34 tools, and every `COMMANDS` key must have either an exercise or an explicit `{ skip: "<reason>" }`. **A new route or tool added later without coverage fails CI** — that is the requirement, stated concretely.

Node/Docker constraints are inherited, not invented: the suite runs under `test:integration` (`"cache": false`, `fileParallelism: false`) and needs **Node 22** — `testcontainers` → `undici@8` → `webidl.util.markAsUncloneable`, absent on Node 20. CI's dedicated `integration` job already pins 22.

### B4. Deploy sequencing and the human checkpoint

Reading `docs/DEPLOYMENT.md` + `deploy/README.md` surfaced the load-bearing distinction:

> **Publishing is already automatic. Deploying is not.** `docker-publish.yml` pushes `mnemosyne-server:edge` + `mnemosyne-migrate:edge` to GHCR on every `main` push. Merging Chain A therefore _publishes_ an image with zero human involvement. The irreversible act is pulling that image onto the target host and restarting — an operator action outside CI. **That is where the checkpoint belongs**, not at merge.

| Gate   | Condition                                                                                         | Automatic?                  |
| ------ | ------------------------------------------------------------------------------------------------- | --------------------------- |
| **G1** | Chain A (A1–A12) merged; `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green on `main` | ✅ CI                       |
| **G2** | Chain B audit snapshots committed; every divergence triaged **fix-here** or **follow-up**         | Human triage                |
| **G3** | `fix-here` items merged; full-surface `test:integration` green on the Node 22 job                 | ✅ CI                       |
| **G4** | 🛑 **HUMAN CHECKPOINT — hard stop**                                                               | ❌ Never automatic          |
| **G5** | Run `mnemosyne-migrate` to completion, then roll `mnemosyne-server` (`docker/README.md`)          | Operator                    |
| **G6** | B5 production verification; report before the change is called done                               | ✅ suite, ❌ interpretation |

**G4 is a real pause point.** The implementing agent stops and presents, then waits for an explicit go-ahead:

1. **Image digest to deploy** — pinned `sha256:…`, never the `:edge` tag. A moving tag makes the rollback target ambiguous, which is the difference between a rollback and an outage.
2. **Currently-running digest** — the rollback target, captured _before_ the roll.
3. **Target host / deployment path** — Compose self-host, GHCR pull, or Railway (`deploy/README.md` §1–3).
4. **Migration plan** — both streams (`public` legacy + `mnemosyne` v3), idempotent, must complete before the server boots.
5. **Confirmation that this change contains no schema or data migration** (per the proposal's Rollback section) — so rollback is a digest swap, nothing more.

An affirmative answer from any agent, plan, or CI signal is **not** the go-ahead. Only the operator's own explicit instruction is.

### B5. Production verification

Parameterization only — same suite, different target. Three design points:

**1. Dedicated env vars, not the existing ones.** The repo already has three conventions in flight: `MNEMO_URL`/`MNEMO_KEY` (MCP, `AGENTS.md`), `MNEMO_URL`/`MNEMO_API_KEY` (`deploy/README.md`), and `MNEMO_BASE_URL`/`MNEMO_TEST_API_KEY` (k6, root `package.json`). Reusing any of them risks a stray shell export pointing prod tests at localhost — or worse, the reverse. The harness reads **`MNEMO_VERIFY_URL` + `MNEMO_VERIFY_KEY`**, and when they are set it **skips container startup entirely** and returns a `LiveSurface` bound to the remote. Absent → local testcontainer path, unchanged. (The three-way naming divergence is itself a contract-coherence finding; record it in the audit output, fix it in a follow-up.)

**2. Real clients, no shortcuts.** `sdk` → real `MnemosyneClient` at the remote URL. `mcp` → the real built stdio server spawned with `MNEMO_URL`/`MNEMO_KEY` set to the remote (already how the harness spawns it). `cli` → the real built `mnemo` binary against a temp `~/.mnemo/config.json`. `http` → plain `fetch`. Nothing is mocked; that is the point of the step.

**3. Write safety on a shared system.** Split the coverage table into `read` / `write` / `destructive`:

| Class         | Prod behavior                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`        | Runs as-is                                                                                                                                                       |
| `write`       | Runs inside a **throwaway workspace** created for the verification run; RLS + workspace scoping contain the blast radius, and the workspace is deleted afterward |
| `destructive` | **Skipped** (`memory_purge`, hard delete, break-glass, admin-destructive) and reported as `verified: local-only`                                                 |

The report states explicitly which surfaces were _not_ prod-verified. Silently skipping and reporting 100% would reproduce, in a new place, the exact STATUS.md defect this change exists to correct.

### B6. Judgment call — Phase 2 is its own chain (recommended)

**Recommendation: split. Same OpenSpec change (`flatten-version-docs`), two delivery chains, gate at G1.**

| Argument                                                                                                                              | Weight                                             |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| The proposal's own Dependencies section already says Phase 2 depends on Tiers 0–5 being merged                                        | Decisive                                           |
| Different risk class: Chain A is revertible text; Chain B introduces a new harness and ends in an irreversible shared-system mutation | Decisive                                           |
| Different reviewer skill: A6–A11 want a fast mechanical skim; B1–B3 want architectural review of introspection code                   | Strong                                             |
| A blocked Chain B must not hold Chain A hostage — Chain A alone already satisfies 10 of the 11 non-Phase-2 success criteria           | Strong                                             |
| Splitting into a _separate change_ would lose the shared tier/contract inventory Phase 2 explicitly reuses                            | Against a full split → keep one change, two chains |

Chain B PRs: **B1** inventories + snapshots · **B2** the four set differences + `EXPECTED_DIVERGENCES` + generated tool-contract review · **B3** `live-surface` harness extraction + coverage enumeration guard · **B4** coverage fill-in (may split per surface if >400 lines) · **B5** prod-verification parameterization + report.

Escape hatch, per the proposal's Risks table: any audit finding that is really a redesign leaves Chain B as a **new** OpenSpec change. It does not get force-fit into B4.

---

## Data Flow — the audit

```
createApp()
   │
   ├─ app.routes ─────────────► routeInventory  ──┐
   └─ GET /openapi.json ──────► openApiInventory ─┤
                                                  │
registerAllTools(spy) ──► 34 handlers             │  4 set
   └─ real MnemosyneClient{fetch: recorder} ──────┤  differences
COMMANDS ──► stubbed global fetch ────────────────┤     │
MnemosyneClient.prototype ──► recorder ───────────┘     ▼
                                            EXPECTED_DIVERGENCES
                                                        │
                                    ┌───────────────────┴────────────────┐
                                    ▼                                    ▼
                            *.snapshot.json                  tool-contract-review.md
                            (CI diffs on drift)              (34 pre-assembled rows,
                                                              human reads for ghosts)
```

## File Changes

| File                                                                                             | Chain  | Action        | Note                                                 |
| ------------------------------------------------------------------------------------------------ | ------ | ------------- | ---------------------------------------------------- |
| `packages/cli/src/commands.ts`                                                                   | A1/A2  | Modify        | 2 fetch paths, help text `:3853`                     |
| `packages/server/loadtest/run.ts`, `load/k6/*.js`                                                | A1     | Modify        | 11 live 404s                                         |
| `packages/cli/src/__tests__/helpers/expect-request.ts`                                           | A1     | **New**       | Full-path assertion helper                           |
| `packages/cli/src/__tests__/cli.test.ts`                                                         | A1     | Modify        | Full-path export test + 5 `cmdImport` tests          |
| `docs/STATUS.md`, `README.md`, `.github/assets/session-pipeline.svg`                             | A2     | Modify        | Sequenced after A1                                   |
| `openspec/flatten-version-docs/coherence-review.md`                                              | A3     | **New**       | Evidence for the coherence pass                      |
| Tier 3 frozen docs (×9)                                                                          | A4     | Modify        | +1 banner line each, bare `` `/v1` ``                |
| `packages/server/src/__tests__/api-path-truth.test.ts` + `.allowlist.ts`                         | A5     | **New**       | The guard                                            |
| Tier 2 sweep targets                                                                             | A6–A11 | Modify        | Comment-only; each deletes one `unswept` entry       |
| `packages/server/src/__tests__/contract-inventory.ts`, `contract-reality.test.ts`                | B1/B2  | **New**       | Route + OpenAPI introspection                        |
| `packages/mcp/src/__tests__/tool-route-map.test.ts`                                              | B1     | **New**       | 34-tool recorder                                     |
| `packages/cli/src/__tests__/command-route-map.test.ts`                                           | B1     | **New**       | `COMMANDS` recorder + completeness guard             |
| `packages/client-ts/src/__tests__/sdk-route-map.test.ts`                                         | B1     | **New**       | SDK recorder                                         |
| `packages/mcp/src/__tests__/harness/live-surface.ts`                                             | B3     | **New**       | Extracted from `remember-recall.integration.test.ts` |
| `packages/core/src/protocol/v1.ts`, arch v2/v3 labels, 3rd-party paths, `0019_session_label.sql` | —      | **Unchanged** | Allowlisted or different axis                        |

## Open Questions

- [ ] **Q1 — `docs/archive/BACKLOG.md` (40 occurrences).** The proposal puts BACKLOG out of scope, but it is a _live_ reader-facing doc. Allowlisting it as `frozen` weakens the guard's stated promise ("no live reader-facing document claims `/v1` exists"). **Recommendation: sweep it in A12** rather than allowlist it — the file is already being edited there to close items, so the marginal cost is near zero.
- [ ] **Q2 — `packages/federation/src/MtlsAuthAdapter.ts` (2).** Unclassified: our federation routes (Tier 2) or a peer instance's third-party path (Tier 4)? Resolved during A0.
- [ ] **Q3 — Chain B target host.** `deploy/README.md` lists three paths; which one is the actual instance to verify against? Needed before G4, not before B1.
- [ ] **Q4 — `expected` counts vs. release-please.** `CHANGELOG.md` is machine-generated and will grow. Exact-count pinning fails if a future commit message contains `/v1/`. Accepted: re-pinning is a one-line diff with a stated reason, and forcing that decision is the feature. Revisit if it fires more than twice.

## Assumptions Requiring Validation at Implementation Time

1. Hono's `app.route("/", v1)` merges the sub-app's routes into the parent's public `.routes` array. Verified by reading Hono's `route()` contract; **confirm empirically in B1's first test**. Fallback if not: introspect `v1.routes` directly and apply the mount prefix.
2. Every MCP tool handler reaches exactly one SDK call under minimal-valid input. Tools with branching (`memory_self_edit`'s 7 actions, `memory_entity`'s `link_user`) need one fixture per branch; the completeness guard must key on `(tool, action)`, not `tool`.
3. `mock-server`'s 21 `/v1/` occurrences are comment-only — spot-verified in `src/app.ts`; re-confirm `README.md` in A0 before classifying the package as Tier 2 rather than Tier 0.
