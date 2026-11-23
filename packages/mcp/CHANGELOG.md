# Changelog

## 3.6.4 (unreleased)

### Changed

- **Opt-in tool profile.** The server still lists all 37 tools by default (no change from 3.6.x);
  `MNEMO_MCP_TOOLS=core` trims the list to 9 (recall, fact, remember, decide, update, forget,
  search, status, context) for hosts that load every schema on every request. `full` names the
  default explicitly; any other value serves `full` with one stderr warning. `tools/list` drops
  from ~68 KB to ~45 KB (full) or ~13 KB (core): no `$schema`, no repeated regexes, shorter field
  descriptions. Validation is unchanged.
- The server instructions fit in 2,048 characters (they were 5,772, and hosts that cut near 2 KB
  never showed the second half). Recall is asked for only when no `<untrusted_memory>` block was
  injected.

### Fixed

- `memory_recall` with `asOf` ranks what memory held at that instant. The argument used to be
  accepted and ignored, so an agent asking for the past got today's memory.

### Added

- `memory_recall` takes `includeGraph`: each memory also lists its relations and the groups it
  belongs to, as hints the agent can follow.

## 3.6.0-alpha.0 (2026-07-06)

### Added

- **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
- **mcp:** accept §29 introspect aspects via alias mapping to §31 backend (F22)
- **mcp:** add memory_doctor — 27th tool with 8 operational diagnostics
- **mcp:** P1 §24 — unified memory_session tool + task/strategy domain verbs
- **mcp:** Task 13 — workflow + skill tools and event.annotate action
- memory_context MCP tool + mnemo info CLI command
- **multi-tenant:** populate scope_owner on all new facts
- **multi-tenant:** targetWorkspaceId on memory_remember — write to any accessible workspace
- **p4:** memory_update, FTS fallback, passive capture, memory_judge
- **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
- **P9:** wire scope + scopeRef into memory_remember and memory_recall
- path-to-100 — Tasks 12–16 complete (all 16 tasks done)
- **reasoning:** RSN-2 procedural unit tests, RSN-4 durable self-edit budgets, RSN-5 fix memory_introspect description
- **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
- **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
- **W0:** Quality Baseline & CI Hard Gate

### Fixed

- §15 Hebbian relation weight (wrong relation) · §31 introspect limit (MCP+client)
- **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
- complete Mnemosyne remediation phases A-F
- **mcp/sdk/plugins:** expose asOf + anticipation context/lookAhead; clamp plugin write sensitivity
- **mcp:** cast typed SDK returns through unknown to satisfy TS2352
- **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
- **tests:** resolve TS errors in grpc-unary + admin-route + mcp reasoning

### Documentation

- comprehensive accuracy pass — align all public docs + diagrams with shipped reality
- **mcp:** sync README to the §24 MCP contract
- RDD-9/API-9/RET-4 — document Postgres idempotency + session-L1 decisions, annotate memory_session split

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @mnemo-ai/client-ts bumped to 3.6.0-alpha.0
  - devDependencies
    - @mnemo-ai/client-ts bumped to 3.6.0-alpha.0

## 3.5.0-alpha.0 (2026-07-06)

### Added

- **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
- **mcp:** accept §29 introspect aspects via alias mapping to §31 backend (F22)
- **mcp:** add memory_doctor — 27th tool with 8 operational diagnostics
- **mcp:** P1 §24 — unified memory_session tool + task/strategy domain verbs
- **mcp:** Task 13 — workflow + skill tools and event.annotate action
- memory_context MCP tool + mnemo info CLI command
- **multi-tenant:** populate scope_owner on all new facts
- **multi-tenant:** targetWorkspaceId on memory_remember — write to any accessible workspace
- **p4:** memory_update, FTS fallback, passive capture, memory_judge
- **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
- **P9:** wire scope + scopeRef into memory_remember and memory_recall
- path-to-100 — Tasks 12–16 complete (all 16 tasks done)
- **reasoning:** RSN-2 procedural unit tests, RSN-4 durable self-edit budgets, RSN-5 fix memory_introspect description
- **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
- **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
- **W0:** Quality Baseline & CI Hard Gate

### Fixed

- §15 Hebbian relation weight (wrong relation) · §31 introspect limit (MCP+client)
- **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
- complete Mnemosyne remediation phases A-F
- **mcp/sdk/plugins:** expose asOf + anticipation context/lookAhead; clamp plugin write sensitivity
- **mcp:** cast typed SDK returns through unknown to satisfy TS2352
- **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
- **tests:** resolve TS errors in grpc-unary + admin-route + mcp reasoning

### Documentation

- comprehensive accuracy pass — align all public docs + diagrams with shipped reality
- **mcp:** sync README to the §24 MCP contract
- RDD-9/API-9/RET-4 — document Postgres idempotency + session-L1 decisions, annotate memory_session split

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @mnemo-ai/client-ts bumped to 3.5.0-alpha.0
  - devDependencies
    - @mnemo-ai/client-ts bumped to 3.5.0-alpha.0

## 3.4.0-alpha.0 (2026-07-05)

### Added

- **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
- **mcp:** accept §29 introspect aspects via alias mapping to §31 backend (F22)
- **mcp:** add memory_doctor — 27th tool with 8 operational diagnostics
- **mcp:** P1 §24 — unified memory_session tool + task/strategy domain verbs
- **mcp:** Task 13 — workflow + skill tools and event.annotate action
- memory_context MCP tool + mnemo info CLI command
- **multi-tenant:** populate scope_owner on all new facts
- **multi-tenant:** targetWorkspaceId on memory_remember — write to any accessible workspace
- **p4:** memory_update, FTS fallback, passive capture, memory_judge
- **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
- **P9:** wire scope + scopeRef into memory_remember and memory_recall
- path-to-100 — Tasks 12–16 complete (all 16 tasks done)
- **reasoning:** RSN-2 procedural unit tests, RSN-4 durable self-edit budgets, RSN-5 fix memory_introspect description
- **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
- **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
- **W0:** Quality Baseline & CI Hard Gate
- **wave-ac:** schema & contract completeness — final sweep (AC1–AC4 §34.6/7/9)

### Fixed

- §15 Hebbian relation weight (wrong relation) · §31 introspect limit (MCP+client)
- **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
- **ci:** doc-lint tool count 14→23 + add mnemo_owner role to baseline migration
- **mcp/sdk/plugins:** expose asOf + anticipation context/lookAhead; clamp plugin write sensitivity
- **mcp:** cast typed SDK returns through unknown to satisfy TS2352
- **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
- **tests:** resolve TS errors in grpc-unary + admin-route + mcp reasoning

### Documentation

- comprehensive accuracy pass — align all public docs + diagrams with shipped reality
- **mcp:** sync README to the §24 MCP contract
- RDD-9/API-9/RET-4 — document Postgres idempotency + session-L1 decisions, annotate memory_session split

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @mnemo-ai/client-ts bumped to 3.4.0-alpha.0
  - devDependencies
    - @mnemo-ai/client-ts bumped to 3.4.0-alpha.0

## 3.3.0-alpha.0 (2026-07-05)

### Added

- **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
- **mcp:** accept §29 introspect aspects via alias mapping to §31 backend (F22)
- **mcp:** add memory_doctor — 27th tool with 8 operational diagnostics
- **mcp:** P1 §24 — unified memory_session tool + task/strategy domain verbs
- **mcp:** Task 13 — workflow + skill tools and event.annotate action
- memory_context MCP tool + mnemo info CLI command
- **multi-tenant:** populate scope_owner on all new facts
- **multi-tenant:** targetWorkspaceId on memory_remember — write to any accessible workspace
- **p4:** memory_update, FTS fallback, passive capture, memory_judge
- **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
- **P9:** wire scope + scopeRef into memory_remember and memory_recall
- path-to-100 — Tasks 12–16 complete (all 16 tasks done)
- **reasoning:** RSN-2 procedural unit tests, RSN-4 durable self-edit budgets, RSN-5 fix memory_introspect description
- **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
- **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
- **W0:** Quality Baseline & CI Hard Gate
- **wave-ac:** schema & contract completeness — final sweep (AC1–AC4 §34.6/7/9)

### Fixed

- §15 Hebbian relation weight (wrong relation) · §31 introspect limit (MCP+client)
- **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
- **ci:** doc-lint tool count 14→23 + add mnemo_owner role to baseline migration
- **mcp/sdk/plugins:** expose asOf + anticipation context/lookAhead; clamp plugin write sensitivity
- **mcp:** cast typed SDK returns through unknown to satisfy TS2352
- **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
- **tests:** resolve TS errors in grpc-unary + admin-route + mcp reasoning

### Documentation

- comprehensive accuracy pass — align all public docs + diagrams with shipped reality
- **mcp:** sync README to the §24 MCP contract
- RDD-9/API-9/RET-4 — document Postgres idempotency + session-L1 decisions, annotate memory_session split

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @mnemo-ai/client-ts bumped to 3.3.0-alpha.0
  - devDependencies
    - @mnemo-ai/client-ts bumped to 3.3.0-alpha.0

## 3.2.0-alpha.0 (2026-06-21)

### Added

- **mcp:** Task 13 — workflow + skill tools and event.annotate action
- path-to-100 — Tasks 12–16 complete (all 16 tasks done)
- **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @mnemo-ai/client-ts bumped to 3.2.0-alpha.0
  - devDependencies
    - @mnemo-ai/client-ts bumped to 3.2.0-alpha.0

## 3.1.0-alpha.0 (2026-06-19)

### Added

- **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
- **consolidation-mcp:** activate memory_consolidate + consolidation scheduler in server boot
- **mcp:** add memory_compose MCP tool — list/create/patch/dry-run composition rules (Wave H5)
- **mcp:** memory_event tool (Wave B2)
- **mcp:** memory_hyperedge tool — 20 tools total (Wave D3)
- **mcp:** memory_reasoning tool (Wave B3)
- **mcp:** memory_self_edit tool (Wave B5)
- **mcp:** memory_strategy tool + HTTP routes + SDK methods (Wave B4)
- **mcp:** memory_task tool (Wave B1)
- **mcp:** P1 §24 — unified memory_session tool + task/strategy domain verbs
- **p2:** merge Wave A–I — §30-33, compositionality, anticipation, consensus
- **prospective-memory:** reminders schema, evaluator, HTTP routes, MCP tool activation
- **reasoning:** RSN-2 procedural unit tests, RSN-4 durable self-edit budgets, RSN-5 fix memory_introspect description
- **self-edit:** Wave M2 — Self-Editing Memory with 6-action policy + agent profile + reflection cadence (spec §13)
- **server,mcp,client-ts:** /v1/anticipation + memory_anticipate (Wave G4)
- **server,mcp,client-ts:** /v1/metacognition + memory_introspect (Wave F4)
- **session-collapse:** wire factory.collapseSession() to real pipeline + activate episode MCP
- **wave-ac:** schema & contract completeness — final sweep (AC1–AC4 §34.6/7/9)

### Fixed

- §15 Hebbian relation weight (wrong relation) · §31 introspect limit (MCP+client)
- **audit:** resolve all remaining audit issues — ALG-01/02/03, FED-01, API-02, ARCH-01
- **ci:** doc-lint tool count 14→23 + add mnemo_owner role to baseline migration
- **mcp/sdk/plugins:** expose asOf + anticipation context/lookAhead; clamp plugin write sensitivity
- **mcp:** cast typed SDK returns through unknown to satisfy TS2352
- **mcp:** double-cast structuredContent in self_edit for strict TS
- **mcp:** introspect structuredContent cast to unknown first (Wave F5 typecheck)
- **tests:** resolve TS errors in grpc-unary + admin-route + mcp reasoning
- **wave-g:** rebuild stale type dists — SequentialPatternRow/PeriodicPatternRow now in adapter and mcp builds

### Documentation

- **mcp:** mark all 14 tools as live, add 4 missing schema cards
- **mcp:** sync README to the §24 MCP contract
- **mcp:** Wave B6 closeout — 19 tools, README, STATUS.md
- RDD-9/API-9/RET-4 — document Postgres idempotency + session-L1 decisions, annotate memory_session split
- **repo:** Phase 1+3 — LLM-oriented docs, TSDoc, and algorithm explanations
- **repo:** Phase 2 — MCP tool status flags and API.md banner
- **repo:** Phase 5+4 remaining — ADD_A_PRIMITIVE guide, ADD_AN_LLM_PROVIDER guide, MCP schema cards

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @mnemo-ai/client-ts bumped to 3.1.0-alpha.0
  - devDependencies
    - @mnemo-ai/client-ts bumped to 3.1.0-alpha.0
