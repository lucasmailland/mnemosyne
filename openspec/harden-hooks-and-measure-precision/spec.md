# Harden Hooks and Measure Precision — Specification

## Purpose

Close two live silent-failure defects in the Claude Code plugin hooks, add contract tests that make
a third class of silent failure impossible, and expose a precision-at-k report over recall
telemetry that already exists. No retrieval behaviour changes; no schema migration; no new writes.

Verified against HEAD:

- `packages/plugin/scripts/user-prompt-submit.sh:68` — recall fetch at `curl --max-time 1.5`.
- `packages/server/src/routes/recall.ts:351` — `const rerank = body.rerank ?? true` (rerank is on).
- `packages/plugin/scripts/session-start.sh:60,83,95` — three sequential curls at `--max-time 2`;
  `packages/plugin/hooks/hooks.json` grants that hook a 10 s ceiling.
- `packages/plugin/hooks/hooks.json` declares exactly four events: `SessionStart`,
  `UserPromptSubmit`, `Stop`, `SubagentStop`.
- `packages/core/src/cognitive/recall-cold.ts:969-988` — `recordRecall` persists `sessionId`,
  `hitRank`, `tdCredit = 0.7^rank`, `activationScore` per served hit.
- `packages/core/src/session/collapse.ts:677-690` — `propagateTdCredit` over `createdFactIds`.

## Capability: recall-injection-reliability

### Requirement 1: The auto-recall hook MUST NOT lose its injection to rerank

The `UserPromptSubmit` recall fetch MUST complete within its curl budget under the server's
**default** recall configuration, including when RecMem elects to spend the LLM rerank call.

Because rerank is on by default server-side, the hook MUST make its own latency requirement
explicit rather than inheriting it. The implementation MUST follow `IMPLEMENTATION_PLAN.md` M2 and
MUST NOT change the server-side default.

#### Scenario: RecMem spends a rerank call on a hook-originated recall

- **WHEN** the hook issues its recall request and the server's RecMem gate decides to rerank
- **THEN** the hook still receives a response inside its curl budget
- **AND** `additionalContext` is injected

#### Scenario: the request genuinely exceeds the budget

- **WHEN** the recall request cannot complete in time for any reason
- **THEN** the hook exits 0 with valid JSON and no `additionalContext` (unchanged fail-open)
- **AND** it emits the degradation marker of Requirement 4 — silence is not an acceptable outcome

### Requirement 2: `session-start.sh` MUST retain headroom under its declared ceiling

The hook's total worst-case network time MUST leave enough margin under the `hooks.json` ceiling
for `jq` parsing, bash startup, and the `SKILL.md` emission that occurs after all network calls.

#### Scenario: every upstream call is slow but reachable

- **WHEN** each upstream request takes its full per-call budget
- **THEN** the hook completes and emits the `SKILL.md` protocol injection before the ceiling
- **AND** the workspace-context section is emitted with whatever data arrived

#### Scenario: an upstream call fails

- **WHEN** any individual upstream call fails or times out
- **THEN** the hook still emits `SKILL.md` and exits 0 (unchanged fail-open)
- **AND** the affected section reports unavailability per Requirement 4

## Capability: hook-event-contract

### Requirement 3: Declared host events MUST be asserted against an allowlist

An automated test MUST assert that every event key in `packages/plugin/hooks/hooks.json` belongs to
a maintained allowlist of real Claude Code hook events, and that every script the manifest
references exists and is executable.

This exists to make a specific failure impossible: an event name that the host never fires produces
no error, no log, and no capture — it simply never runs. The test MUST fail on a wrong name.

#### Scenario: an event is renamed to a value the host does not fire

- **WHEN** a manifest event key is changed to a name absent from the allowlist
- **THEN** the test suite fails, naming the offending key

#### Scenario: the manifest references a missing script

- **WHEN** a declared hook points at a script path that does not exist
- **THEN** the test suite fails

## Capability: hook-degradation-contract

### Requirement 4: Unavailability MUST be distinguishable from emptiness

Where a hook currently degrades to an empty string, it MUST instead emit a marker distinguishing
"Mnemosyne could not be reached" from "Mnemosyne returned nothing". Markers MUST be terse and MUST
NOT alter the fail-open contract: hooks still exit 0 and still emit valid JSON.

#### Scenario: the server is unreachable at session start

- **WHEN** upstream calls fail
- **THEN** the injected context states that memory is unavailable
- **AND** the model is not led to infer that the workspace is empty

#### Scenario: the server is reachable and genuinely has nothing

- **WHEN** upstream calls succeed and return no results
- **THEN** the output says so, distinctly from the unavailable case

## Capability: recall-precision-report

### Requirement 5: A precision-at-k report MUST be computable from existing telemetry

The system MUST expose a report answering: **of the hits served at rank < k, what fraction went on
to receive TD credit or an explicit positive outcome in the same session.**

It MUST be derived **only** from data already persisted — `mnemo_recall_log` (`sessionId`,
`hitRank`, `tdCredit`, `activationScore`), TD(λ) worth propagation, and session feedback. This
change MUST NOT add a write path, a port method, or a schema migration.

The surface MUST extend an existing operator endpoint (`GET /admin/stats` or `memory_doctor`) per
`IMPLEMENTATION_PLAN.md` A2's "don't add tools" constraint.

#### Scenario: a workspace with collapsed sessions

- **WHEN** the report is requested for a workspace with recall history and at least one collapsed
  session
- **THEN** it returns precision at each of at least k ∈ {1, 3, 5}, and the sample size behind each

#### Scenario: insufficient data

- **WHEN** a workspace has no recall history, or none of its sessions ever collapsed
- **THEN** the report returns an explicit insufficient-data result, never a fabricated 0 or 1

#### Scenario: workspace isolation

- **WHEN** the report is computed
- **THEN** every query runs through `withMnemoTx` and returns only the caller's workspace data

### Requirement 6: The report MUST NOT claim more than the data supports

The response MUST carry the sample size and MUST document that TD credit is a **coarse** utility
proxy, not per-hit attribution — that instrument is gated on D5 and out of scope here.

## Invariants preserved

- `packages/core/src/cognitive/` keeps zero infrastructure imports.
- All workspace-scoped access goes through `withMnemoTx`.
- The relation verb set stays at 9; no new primitives.
- Sensitivity compares via `SENSITIVITY_ORDER`; ceiling violations return 404, not 403.
- Writes resolve identity through `resolveProvenance()`.
- Hooks remain fail-open: always exit 0, always emit valid JSON.
- `packages/cli/plugin/` is regenerated via `node packages/cli/scripts/sync-plugin.cjs`, never
  hand-edited.
