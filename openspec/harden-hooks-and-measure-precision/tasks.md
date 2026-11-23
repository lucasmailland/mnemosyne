# Tasks: harden-hooks-and-measure-precision

Ordered. Slices 1–3 are independent of each other; slice 4 is independent of all of them. Each
slice should land as its own conventional commit.

Read `docs/research/IMPLEMENTATION_PLAN.md` §0 before starting — it corrects three claims in the
research documents, and the corrections are load-bearing here.

---

## Slice 1 — Recall-injection reliability (Requirement 1)

- [x] 1.1 Confirm the defect before fixing it: rerank default at
      `packages/server/src/routes/recall.ts:351`, hook budget at
      `packages/plugin/scripts/user-prompt-submit.sh:68`. Establish what a rerank-spending recall
      actually costs in wall time against the local stack rather than assuming.
      **Measured** (local docker stack, `mnemosyne-server-1` wired to `mnemosyne-ollama` /
      `qwen2.5:0.5b` for this measurement only, then restored): rerank=false baseline ~15-20ms;
      a forced rerank-spending recall (`recurrenceThreshold:0` to deterministically trigger the
      RecMem gate, since `MNEMO_EMBED_STUB=true` hash-based embeddings can't naturally cross the
      0.6 recurrence threshold on non-identical text) cost ~390ms cold-start up to a steady
      ~900-1000ms warmed — 60-70% of the hook's 1.5s curl budget from a small local model over
      the Docker-internal network alone, before any real hosted-model + real-network latency.
      Confirms the defect.
- [x] 1.2 Apply the M2 fix from `IMPLEMENTATION_PLAN.md`. Do **not** change the server-side default.
      `user-prompt-submit.sh:66-67` now sends `rerank: false` in the recall body (call-scoped
      only). `recall.ts:351` (`body.rerank ?? true`) left untouched.
- [x] 1.3 Add a bash test proving the hook still exits 0 with valid JSON when recall exceeds its
      budget, and that it injects when recall returns in time.
      Added Tests 7-9 to `packages/plugin/scripts/__tests__/user-prompt-submit.test.sh`: (7)
      captures the payload sent to curl and asserts `rerank:false`; (8) simulates curl's own
      timeout exit code (28) and asserts exit 0 + valid JSON + no `additionalContext` (fail-open
      unchanged); (9) asserts `additionalContext` is injected when recall returns in time. 25/25
      assertions pass.
- [x] 1.4 Regenerate the plugin mirror: `node packages/cli/scripts/sync-plugin.cjs`.
      Ran; `packages/cli/plugin/scripts/user-prompt-submit.sh` and its test file are now
      byte-identical to `packages/plugin/`.

## Slice 2 — `session-start.sh` headroom (Requirement 2)

- [x] 2.1 Reproduce the worst case: all three curls at full budget against the declared ceiling.
      **Calculated** (deterministic, `--max-time` bounds each call): old sequential worst case was
      3 x 2s = 6s against the 10s `hooks.json` ceiling for `SessionStart`/`startup|clear`, leaving
      ~4s (40%) for `jq` parsing, bash startup, and the `SKILL.md` cat/printf that only runs after
      all three. Confirmed against current line numbers: curls at `session-start.sh:72,79,89`
      (post-fix; were `:57,77,92` pre-fix, close to spec.md's cited `:60,83,95`), ceiling at
      `hooks.json:11` (`"timeout": 10`, matcher `startup|clear`).
- [x] 2.2 Remove the cliff per `IMPLEMENTATION_PLAN.md` M3, preserving fail-open on every path.
      **Dependency-chain finding**: traced all three calls' actual inputs — `/me` only needs
      `MNEMO_URL`/`MNEMO_KEY`; `/session/start`'s body (`{"label":"claude-session-${SESSION_ID}"}`)
      only uses `SESSION_ID` from the Claude hook's own stdin JSON, never anything from `/me`'s
      response (`$ME_JSON`/`$ACTIVE_WS_ID` are never referenced in that block); `/admin/stats` only
      needs `MNEMO_URL`/`MNEMO_KEY`. **All three are independent in this script as it exists
      today** — M3's caution ("`/session/start` consumes `/me`-derived state... check the real data
      dependencies before assuming all parallelise") does not hold for the current code; it reads
      as a forward-looking caution for a hypothetical future call (e.g. `/canon` keyed off `/me`'s
      workspace id), not a description of what's here now. All three now launch as background curl
      jobs writing to per-call temp files, followed by a single `wait`; parsing happens after,
      reading from the temp files (unchanged fail-open: empty/missing file behaves identically to
      the old empty-`$VAR` case). Documented in the header comment that a future dependent call
      must NOT join this parallel block.
- [x] 2.3 Prove `SKILL.md` is still emitted when every upstream call is slow, and when each fails.
      Added Tests 9-10 to `packages/plugin/scripts/__tests__/session-start.test.sh`, run end to end
      against the real script (not just helpers): (9) all three curls `sleep 2` then return fixture
      JSON — asserts exit 0, wall time < 4000ms (measured 2031ms, vs. the 6s sequential worst case),
      `SKILL.md`'s protocol heading present, workspace-context section present, and both `/me`- and
      `/admin/stats`-derived content present; (10) all three curls exit 7 (unreachable) — asserts
      exit 0, `SKILL.md` heading present, workspace-context section present. 17/17 assertions pass
      (8 pre-existing + 9 new).
- [x] 2.4 Update the header comment — it documents the _old_ sequential budget maths and will be
      wrong after 2.2. Rewrote: explains the three curls now run in parallel via
      `curl ... & ... & wait`, why none depends on another's response, that worst case is now their
      MAX (~2s) not their SUM (~6s), leaving ~8s (80%) of the 10s ceiling — roughly double the old
      ~4s (40%) margin — and a note that any future genuinely-dependent call must run after `wait`,
      not inside the parallel block.
- [x] 2.5 Regenerate the plugin mirror.
      Ran `node packages/cli/scripts/sync-plugin.cjs`; `packages/cli/plugin/scripts/session-start.sh`
      and its test file are now byte-identical to `packages/plugin/`. Verified with `diff -q` on
      both files after sync, and re-ran the mirrored test copy (17/17 pass).

## Slice 3 — Event contract + degradation markers (Requirements 3, 4)

- [x] 3.1 Write the allowlist test **first** and watch it fail for the right reason: temporarily
      rename an event key in a fixture and confirm the failure names it. A test that cannot fail is
      the failure mode this slice exists to prevent.
      New file `packages/plugin/scripts/__tests__/hook-event-contract.test.sh`. Allowlist (10 events)
      corroborated from `~/.claude/cache/changelog.md` prose plus 3 independent locally-installed
      plugins (`engram` declares the identical 4 events this plugin does; `vercel`'s own structural
      test references `SubagentStart`/`SubagentStop`; `hookify` exercises `PreToolUse`/`PostToolUse`).
      RED proved manually first (`check_hook_events` on a fixture with `SessionStart` renamed to
      `NotARealClaudeCodeEvent` correctly flagged and named it) before being folded into the test
      file itself as a permanent regression test (Test 1) — so the checker's ability to fail can
      never silently regress into a tautology. Test 3 asserts the real (unmodified) `hooks.json`
      passes clean.
- [x] 3.2 Assert every referenced script exists and is executable.
      Same file, `check_hook_scripts()`. Also RED-proved first against a fixture pointing a command
      at a nonexistent script (correctly flagged and named the resolved path) — Test 2 — before Test
      4 asserts every real script referenced by `hooks.json` exists and is `-x`. 4/4 assertions pass.
- [x] 3.3 Add degradation markers wherever a hook currently degrades to an empty string
      (`session-start.sh`'s stats/identity sections; `user-prompt-submit.sh`'s recall section).
      Terse; fail-open contract unchanged.
      `session-start.sh`: added `ME_REACHED`/`STATS_REACHED` booleans (true only when the temp file
      has content, i.e. curl actually returned something) driving 3-way branches — has-data /
      "responded but returned no workspace identity" / "responded but returned no usable stats" /
      "could not be reached" — replacing the prior silent omission when `ACTIVE_WS_ID`/`STATS` were
      both empty. `user-prompt-submit.sh`: added `RECALL_REACHED` (curl exit 0 + non-empty +
      `jq -e .`-valid body) and split the previously-conflated
      "Automatic recall found nothing (or the server was unreachable)" sentence (A6's own
      IMPLEMENTATION_PLAN.md text flagged this exact ambiguity) into two distinct sentences: "...
      reached Mnemosyne but found nothing relevant..." vs. "Mnemosyne could not be reached for
      automatic recall...". A curl timeout (exit 28, Requirement 1's "genuinely exceeds the budget"
      scenario) is correctly bucketed under "could not be reached", not "found nothing".
- [x] 3.4 Cover both branches: unreachable vs. genuinely empty.
      `session-start.test.sh` Test 10 (existing, extended) + new Test 11: all-fail asserts the
      unreachable marker AND asserts the reachable-marker text is absent; reachable-but-garbage
      (`/me` returns `{}`, `/admin/stats` returns non-JSON) asserts the reachable marker AND that the
      unreachable text is absent. 24/24 assertions pass (was 17, +7).
      `user-prompt-submit.test.sh`: extended Tests 3 (curl failure), 4 (empty hits), and 8 (curl
      timeout) with the corresponding marker assertion plus a negative (`assert_not_contains`,
      new helper) proving the other branch's wording never leaks in. 31/31 assertions pass
      (was 25, +6).
- [x] 3.5 Regenerate the plugin mirror.
      Ran `node packages/cli/scripts/sync-plugin.cjs`; `diff -rq packages/plugin packages/cli/plugin`
      reports no differences. All 5 mirrored test files re-run clean under `packages/cli/plugin/`
      (86/86 assertions total across both trees).

## Slice 4 — Precision-at-k report (Requirements 5, 6)

- [x] 4.1 Map the available data end to end before designing the query: `mnemo_recall_log` columns
      written at `recall-cold.ts:969-988`, TD propagation at `collapse.ts:677-690`, and the session
      feedback route. Write down what can and cannot be joined — the answer constrains the metric.
      See `design.md` §4.1 — join exists via `mnemo_recall_log.session_id` → `mnemo_session`
      (`collapsed_at`, `fact_count`); documented imprecision around `learningMode` invisibility.
- [x] 4.2 Define precision-at-k precisely in `design.md`, including how a hit "received credit" is
      decided and what happens to sessions that never collapsed. Ambiguity here produces a number
      nobody can interpret. See `design.md` §4.2.
- [x] 4.3 Implement the read. Adapter-side query; `withMnemoTx`; no new port write method, no
      migration. `RecallPort.getRecallPrecision` (read-only), implemented in
      `RecallRepository.getRecallPrecision` (adapter-postgres) and the in-memory adapter.
- [x] 4.4 Extend `GET /admin/stats` or `memory_doctor` — no new tool, no new route. Extended
      `GET /admin/stats`'s `recall` object (`packages/server/src/routes/admin-stats.ts`).
- [x] 4.5 Return sample size alongside every figure, and the insufficient-data result when a
      workspace lacks history. `RecallPrecisionAtK.sampleSize` + `RecallPrecisionReport.insufficientData`.
- [x] 4.6 Tests: a workspace with known recall+collapse history yields the expected precision; an
      empty workspace yields insufficient-data; cross-workspace isolation holds. See
      `packages/types/src/testing/__tests__/InMemoryStorageAdapter-recall-precision.test.ts` and
      `packages/adapter-postgres/src/__tests__/unit/recall-repository-boundaries.test.ts`
      (`getRecallPrecision` describe block).

## Slice 5 — Close the token number (proposal scope item 5)

**BLOCKED — stopped per 5.3, exactly as instructed.** Checked the environment before starting any
other slice: neither `ANTHROPIC_API_KEY` nor `ANTHROPIC_AUTH_TOKEN` is set (confirmed via `env` and
`scripts/measure-tool-surface.mjs:213`'s own credential check). Per the handoff's explicit
instruction, did not estimate, did not install or invent a credential, and did not touch
`docs/research/MEMORY_VALUE_MODEL.md` §3.4's existing estimate or its caveat. This slice remains
fully open for the user to run locally with a real credential.

- [x] 5.1 **CLOSED 2026-09-11 by decision: not doing it, and no longer tracking it.** Running
      this needs an Anthropic API key, and the people working on this project use a Claude
      subscription, which exposes no API. Making a research number depend on a credential
      nobody has to hand is how an item stays open forever while pretending to be work. The
      procedure now lives as a comment in `scripts/measure-tool-surface.mjs`, where whoever
      does have a key one day will actually find it — rather than on a list.
- [x] 5.2 **Byte half done 2026-09-11; token half closed with 5.1.** §3.4 was carrying a stale
      measurement (35 tools / 63,903 B) taken before two tools shipped; re-running the script
      produced the current 37 tools / 74,893 B and every derived figure in the doc was updated
      to match, including the V5 row and the §-end summary. The TOKEN range stays an estimate and
      is labelled as one everywhere it appears, which is sufficient: every argument §3.4 makes —
      payload concentration, schema-vs-description, core-vs-deferred — is ratio-independent and
      holds at any conversion rate, so a measured number would sharpen the framing without
      changing a conclusion.
      Original task text: Replace the estimated range in `docs/research/MEMORY_VALUE_MODEL.md` §3.4 with the
      authoritative count, keeping the byte figures. **Blocked**, depends on 5.1.
- [x] 5.3 **If no credential is available, stop and report.** Do not estimate, do not install or
      invent credentials, do not delete the existing caveat. **Done** — stopped here, nothing
      estimated or invented, existing caveat in `MEMORY_VALUE_MODEL.md` §3.4 untouched.

## Verification

- [x] V1 `pnpm build && pnpm lint && pnpm typecheck && pnpm test` from the repo root. **Done**
      (orchestrator, post-merge of all 4 slices): build 18/18, typecheck 28/28, lint 1/1 (only
      `@mnemo-ai/client-ts` has a real lint script), test 30/30 tasks (server 239/239 files,
      1747/1747 tests). One transient `@mnemo-ai/cli` flake on the first full-suite run,
      documented pattern from earlier in this session (EPIPE/parallelism noise) — clean 30/30 on
      retry. `test:integration` (Node 22) not re-run for this docs-and-bash-scripts-plus-one-read-route
      change beyond what Slice 4's own agent already ran for the precision-report code path.
- [x] V2 `bash scripts/doc-lint.sh`. **Done** — all checks passed.
- [x] V3 Bash hook tests pass, including the new failure cases. **Done** — all 5 files, 88/88
      assertions: `hook-event-contract.test.sh` 4/4, `session-lifecycle.test.sh` 16/16,
      `session-mapping.test.sh` 13/13, `session-start.test.sh` 24/24, `user-prompt-submit.test.sh`
      31/31.
- [x] V4 Confirm `packages/cli/plugin/` is in sync and was regenerated, not hand-edited. **Done** —
      `diff -rq packages/plugin packages/cli/plugin` reports zero differences.
- [ ] V5 **The one item left, and it belongs to a human at a keyboard.** Manual smoke: start a session against the local stack, confirm `SKILL.md` still injects and
      recall context still arrives. **Not run** — requires an actual live Claude Code CLI session
      invoking the installed plugin hooks, which this agentic session cannot itself trigger (no
      interactive Claude Code host to hook into). The bash test suite is the closest automated
      proxy and is thorough (Slice 2's `session-start.test.sh` measures real wall-clock time and
      asserts `SKILL.md` emission under slow/failed upstreams; Slice 1/3's
      `user-prompt-submit.test.sh` asserts injection under both timeout and in-budget conditions) —
      but a genuine end-to-end smoke test through the real host is unverified and left for the
      user's morning review.

## Out of scope — do not drift into these

`createCitation` / the citation write path (gated on **D5**); the canon tier; executing the `pinned`
redefinition (**D1** is decided in `proposal.md` but deliberately not executed here); the benchmark
client and markdown baseline; fusion normalisation; lean projection; tool-surface deferral;
`SKILL.md` audit; harness thin-shims; `memory_20250818`.

If an in-scope task appears to require one of these, **stop and report** rather than widening.
