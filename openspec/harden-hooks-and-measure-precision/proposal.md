# Proposal: harden-hooks-and-measure-precision

## Intent

Close the four **decision-free** items from `docs/research/IMPLEMENTATION_PLAN.md` (Slice 0) and
ship the **read-side precision report** that Phase 1 needs, without touching anything blocked on
the open product decisions.

Two of these are live defects, not improvements:

1. **The auto-recall injection can fail silently.** `packages/plugin/scripts/user-prompt-submit.sh:68`
   fetches recall with `curl --max-time 1.5`, while rerank is **ON by default** on every live path
   (`packages/server/src/routes/recall.ts:351`, `body.rerank ?? true`). When RecMem decides to spend
   the LLM rerank call, that request cannot complete inside 1.5 s. The hook's documented failure
   mode is "fall through to no `additionalContext`" — so the session simply loses its memory
   injection, with no error anywhere.
2. **`session-start.sh` has no headroom.** Three sequential curls at `--max-time 2` (lines 60, 83, 95) against `hooks.json`'s 10 s ceiling leave ~4 s for `jq`, bash startup, and the `SKILL.md`
   emission that happens _after_ all three. A single slow-but-reachable server loses the entire
   protocol injection.

The third item, host-event contract tests, prevents the worst failure mode in this domain: a
renamed or non-existent hook event captures **nothing**, silently, indefinitely (claude-mem shipped
exactly this for months — `docs/research/MEMORY_SYSTEMS_LANDSCAPE.md` §2, lesson L6).

The fourth is measurement. `docs/research/MEMORY_VALUE_MODEL.md` §2 argues the project's central
weakness is that **everything logged measures exposure and nothing measures utility**. That framing
was half wrong — `IMPLEMENTATION_PLAN.md` §0.3 established that a coarse utility signal already
runs: `recordRecall` persists `sessionId`, `hitRank`, `tdCredit = 0.7^rank` and `activationScore`
per served hit (`packages/core/src/cognitive/recall-cold.ts:969-988`), and collapse propagates
TD(λ) credit from created facts back to session-recalled predecessors
(`packages/core/src/session/collapse.ts:677-690`). **The data to compute precision-at-k already
exists; only the read is missing.**

## Resolved decision (evidence-backed, from this change's exploration)

**D1 — redefine `pinned` as canon membership rather than adding a third flag.** Decided, **not
executed here** (canon does not ship before measurement exists — `PROPOSAL_PATH_TO_TOP.md` §4).

The stated risk was that redefinition costs the ability to express "retain forever but do not
inject". Measured, that risk is theoretical:

| Source                                    | `pinned` | `canonical` | total facts         |
| ----------------------------------------- | -------- | ----------- | ------------------- |
| Local dev DB (`mnemo_fact`, 2 workspaces) | **0**    | **0**       | 204                 |
| Production workspace (`memory_stats`)     | **0**    | —           | 35 live / 45 closed |

Nothing anywhere relies on either flag's current meaning. Redefinition therefore carries **zero
migration cost and no live semantics to break**, and it collapses two confusable concepts into
one while flipping a test that currently certifies a false promise
(`IMPLEMENTATION_PLAN.md` §0.4.4) into one asserting a true one. Recorded so the canon change can
proceed on it later without re-litigating.

## Scope

### In scope

1. **M2.2** — reconcile the auto-recall hook's timeout with rerank. Follow `IMPLEMENTATION_PLAN.md`
   M2; the hook must not be able to lose its injection to a rerank call it cannot wait for.
2. **M3** — remove `session-start.sh`'s timeout cliff (closes gap C1), preserving today's
   fail-open behaviour on every error path.
3. **A6** — contract tests asserting the four declared hook events (`SessionStart`,
   `UserPromptSubmit`, `Stop`, `SubagentStop` — `packages/plugin/hooks/hooks.json`) against an
   allowlist, so a renamed or invented event fails CI instead of capturing nothing; plus the
   degradation markers of H6/C4, so "Mnemosyne unreachable" is distinguishable from "nothing to
   inject".
4. **A2-read** — a precision-at-k report over the data that already exists. No new writes, no new
   port methods, no schema change.
5. Replace the estimated token range in `docs/research/MEMORY_VALUE_MODEL.md` §3.4 with the
   authoritative count from `scripts/measure-tool-surface.mjs`, **if and only if** a credential is
   available; otherwise leave the estimate and its caveat untouched.

### Out of scope — with reasoning

- **The citation write path and `createCitation` (A2's port half).** `CitationPort`
  (`packages/types/src/ports.ts:2109`) is read-only and `createCitation` does not exist anywhere —
  `IMPLEMENTATION_PLAN.md` §0.2 corrected the research's claim that it merely lacked callers. Adding
  it is port design gated on **D5** (attribution shape), and the read-side report deliberately does
  not need it.
- **The canon tier (A3) and the `pinned` redefinition's execution (M4).** D1 is decided above but
  canon must not ship before Phase 1 reports a number; that discipline is the core of
  `PROPOSAL_PATH_TO_TOP.md` and survives contact with the code.
- **The benchmark client and markdown baseline (A1).** Highest-value Phase 1 item, but it carries a
  genuine unresolved question: mem0's harness `add()` takes conversation messages and performs
  LLM extraction, so "what exactly are we comparing" is a measurement-design decision, not wiring
  (`IMPLEMENTATION_PLAN.md` §0.4). It gets its own change.
- **Fusion normalisation (M1), lean projection (A4), tool deferral (M5), `SKILL.md` audit (M6),
  thin shims (M7), `memory_20250818` (A5).** Each blocked on a decision, a prerequisite, or a
  measurement that does not exist yet.
- **Any change to the 35-tool MCP surface.** `PROPOSAL_PATH_TO_TOP.md` §3's "don't" list.

## Capabilities

This repo has no `openspec/specs/` source-of-truth tree; each change carries its own `spec.md`.

### New capabilities

- `hook-degradation-contract` — hook output distinguishes unavailability from emptiness.
- `hook-event-contract` — declared host events are asserted, not assumed.
- `recall-precision-report` — exposure-vs-utility precision-at-k over existing telemetry.

### Modified capabilities

- `autonomous-memory`'s recall injection and session-start budget (timeout reconciliation only;
  no change to what is injected).

## Non-goals

No change to retrieval behaviour, scoring, ranking, or what recall returns. No schema migration.
No new MCP tools. No new HTTP routes beyond the report surface named in `spec.md`.
