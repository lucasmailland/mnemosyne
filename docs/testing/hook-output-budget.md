# Hook output failure-mode catalog

Contract: the 2026-10-21 hook-output-budget request; behavioral rules come from
`packages/plugin/skills/memory/SKILL.md`. All entries are confirmed; no product
decisions are pending. Tests run through `pnpm test:hooks`.

### FM-HOOK-01: Host persists oversized context instead of showing the protocol

- **Category:** boundary
- **Risk:** save instructions disappear from the model's context.
- **Trigger:** realistic startup/compaction payload, oversized Unicode metadata,
  or an oversized upstream session identifier.
- **Observed:** pre-fix `packages/plugin/scripts/session-start.sh:235` and
  `packages/plugin/scripts/post-compaction.sh:22` print the full skill.
- **Expected:** total stdout is at most the shared budget (no more than 1500 bytes
  since 2026-11-22; 6000 before),
  valid UTF-8, including its final newline; optional details may be shortened.
- **Status:** confirmed (request, requirement 1)
- **Tests:** FM-HOOK-01 realistic/oversized output, 128-character and oversized
  session IDs, both hooks and both copies.

### FM-HOOK-02: Provenance and recovery instructions arrive after the preview

- **Category:** business-contract
- **Risk:** remembered facts become orphaned; compaction ends a live session.
- **Trigger:** open session followed by compaction.
- **Observed:** pre-fix `packages/plugin/scripts/post-compaction.sh:28-31` appends
  recovery/sessionId after the skill; `packages/plugin/scripts/session-start.sh:270`
  appends the open-episode marker without a sessionId instruction.
- **Expected:** recovery and managed-session context precede the condensed protocol;
  the complete sessionId instruction ends within the first 600 bytes.
- **Status:** confirmed (request, requirement 2; skill, Episodes and recovery)
- **Tests:** FM-HOOK-02 prefix/order; existing session-lifecycle tests retain mapping checks.

### FM-HOOK-03: Condensing context removes behavioral rules

- **Category:** business-contract
- **Risk:** agents stop saving or misapply scope, lifecycle, workspace or error rules.
- **Trigger:** normal hook execution, missing session mapping, or unavailable upstreams.
- **Observed:** both hooks currently rely on the full skill for these rules.
- **Expected:** retain all seven save triggers and the skill's behavioral rules;
  end with a reference to `mnemosyne:memory`. Missing IDs must never be invented.
- **Status:** confirmed (request, requirement 2; full skill)
- **Tests:** FM-HOOK-03 triggers/protocol, unavailable session/upstreams, missing host ID.

### FM-HOOK-04: Distributed plugin differs from the canonical source

- **Category:** equivalence
- **Risk:** CLI users receive the old broken hooks.
- **Trigger:** editing only one plugin tree.
- **Observed:** `packages/cli/scripts/sync-plugin.cjs:4-10` copies the entire tree;
  `packages/cli/package.json` runs it during prebuild.
- **Expected:** identical file sets and bytes across both plugin trees.
- **Status:** confirmed (request, requirement 3; existing sync script)
- **Tests:** FM-HOOK-04 recursive copy parity.

### FM-HOOK-05: Test entry point depends on plugin depth or caller environment

- **Category:** equivalence
- **Risk:** the bundled test invokes nonexistent hooks, accepts two empty file
  sets as parity, and crashes while inspecting empty stdout.
- **Trigger:** run the identical test from `packages/cli/plugin`, or inherit
  local configuration, binaries, or hook-specific environment variables.
- **Observed:** `scripts/__tests__/hook-output-budget.test.sh:5` uses a fixed
  four-parent root; the bundled copy resolves to `packages`, produces zero bytes,
  and raises `IndexError` at inline Python line 119, even with an empty HOME.
- **Expected:** both entry points find the actual repo, reject missing trees,
  and run hooks with disposable HOME, explicit environment and local PATH stubs.
  Missing configuration, workspace binding, session mapping or `mnemo` must
  preserve the bounded UTF-8 protocol and report unavailable IDs without guessing.
- **Status:** confirmed (2026-10-21 follow-up request, requirements 1–2)
- **Tests:** FM-HOOK-05 tree prerequisites, isolated toolchain, empty-home and
  no-mapping scenarios; FM-HOOK-01/02/03 continue checking each output.

## Initial validation (2026-10-21)

Measured stdout, including the final newline, using the same realistic offline
fixture before and after the fix. Both plugin copies produce identical sizes.

| Hook | Before (bytes) | After (bytes) | Hard budget (bytes) |
| --- | ---: | ---: | ---: |
| `session-start.sh` | 17229 | 4553 | 6000 |
| `post-compaction.sh` | 17521 | 4493 | 6000 |

The first test-first run reported `57 passed, 66 failed`, reproducing oversized
output, missing early provenance/recovery and the missing full-skill pointer.
The final output contract suite reports `183 passed, 0 failed`: both hooks in
both copies, realistic payload, oversized Unicode metadata, long and oversized
IDs, unavailable upstreams, and missing host session ID. Valid sessionId
instructions fit completely in the first 600 bytes; all seven save triggers and
the condensed behavioral rules remain present.

The repository's `pnpm test:hooks` runner reports **455 passed, 0 failed across
13 test files**. It ran offline in a disposable copy inside the worktree: existing
hardcoded `/tmp/mnemo...` marker paths were relocated inside that copy, and a GNU
`date` shim supplied the nanoseconds expected by an existing timing test on macOS.
The runner's command and hook behavior were otherwise unchanged. pnpm dependency
preparation was disabled; no dependencies were installed. The new output contract
suite also passed directly against the actual worktree, without path adaptation.
Shell syntax checks and `git diff --check` pass. No questions remain pending.

Changed files:

- `packages/plugin/scripts/_hook-output.sh`: shared budget, condensed protocol,
  early provenance/recovery and bounded auxiliary details.
- `packages/plugin/scripts/session-start.sh`: use the shared renderer and retain
  the existing workspace diagnostics and episode mapping lifecycle.
- `packages/plugin/scripts/post-compaction.sh`: restore the same session before
  injecting the condensed protocol.
- `packages/plugin/scripts/__tests__/hook-output-budget.test.sh`: output contract
  and complete plugin-tree parity checks.
- The same four paths under `packages/cli/plugin`, generated with
  `node packages/cli/scripts/sync-plugin.cjs` (the existing CLI prebuild step).
- `CHANGELOG.md`: unreleased fix entry.
- `docs/testing/hook-output-budget.md`: failure-mode catalog and measured evidence.

Proposed commit (not created):
`fix(plugin): keep hook context within the host output budget`

## Empty-HOME follow-up (2026-10-21)

The failure is independent of HOME: the bundled test's fixed parent count finds
`<repo>/packages` instead of `<repo>`, invokes nonexistent hooks under
`packages/packages/plugin`, and then indexes the empty output's last line.
Reproduction: canonical entry point exits 0 (183/183); bundled entry point exits
1 with zero hook-output bytes and `IndexError` at inline Python line 119.

Both identical tests now locate the checkout by `pnpm-workspace.yaml`, verify
required files before comparing trees, and safely handle empty stdout. Every
hook invocation gets its own HOME, an explicit environment, an isolated utility
PATH, and local curl/git stubs; no installed `mnemo` is exposed. Added empty-home
and missing-mapping cases cover startup and recovery separately. The existing
hook renderer already degrades correctly, so this follow-up requires no further
production-hook changes. FM-HOOK-01–05 pass; no decisions remain pending.

Executed from a disposable subdirectory inside the worktree, against the
actual worktree entry points, with either an empty temporary HOME or the caller's
default environment. All four stdout streams are identical:

| Entry point | Caller HOME | Result |
| --- | --- | --- |
| `packages/plugin/scripts/__tests__/hook-output-budget.test.sh` | Empty | 259 passed, 0 failed |
| `packages/cli/plugin/scripts/__tests__/hook-output-budget.test.sh` | Empty | 259 passed, 0 failed |
| `packages/plugin/scripts/__tests__/hook-output-budget.test.sh` | Default | 259 passed, 0 failed |
| `packages/cli/plugin/scripts/__tests__/hook-output-budget.test.sh` | Default | 259 passed, 0 failed |

With no configuration, workspace binding, mapping or binary, startup emits
**4570 bytes** and post-compaction **4502 bytes**: valid UTF-8, final newline,
complete behavioral rules and explicit unavailable sessionId, with no requests
or stderr. Realistic configured output is 4559/4493 bytes; the largest measured
output is 4743 bytes (startup with a 128-character ID), below the 6000-byte limit.

Both complete plugin shell suites pass: **531 passed, 0 failed across 13 files
per copy**. As in initial validation, suites ran in disposable copies inside
the worktree, relocating literal `/tmp` paths inside that scratch directory and
providing nanoseconds for macOS `date +%s%N`. A fallback curl stub prevents real
network calls; all HOME/TMPDIR writes stay inside the worktree. The four budget
runs above use the actual files without adaptations. Full stdout/stderr and exit
codes: [hook-output-budget-results.txt](./hook-output-budget-results.txt).

Shell syntax checks and `git diff --check` pass. No commit was created.

## Update (2026-11-22, audit package 3.4)

The protocol no longer travels in the hooks. It is in the MCP server's
instructions (at most 2,048 characters, the size Claude Code keeps) and in
`skills/memory/SKILL.md`, which the hooks point to. The hooks now print only
per-session data: session id and episode status, the workspace details, a
one-line heading and the skill pointer. The budget dropped from 6000 to 1500
bytes, and the budget test checks that the hooks do not repeat the protocol.
Measured on the realistic fixture: session-start 535 bytes, post-compaction
463 bytes. The tables above are the 2026-10-21 record and are kept as history.
