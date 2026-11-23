# Changelog

## 3.6.5 (unreleased)

### Added

* `mnemo policy list|get|set <agentId> --file <json>|delete` writes and reads agent RBAC
  policies (needs `memory:admin`).

### Fixed

* `mnemo init` writes a Claude Desktop entry that starts when the CLI was installed from npm
  (`npx -y @mnemo-ai/mcp`); it used to write `node "npx -y @mnemo-ai/mcp"`.
* `mnemo install` no longer overwrites a `~/.cursor/AGENTS.md` that is not Mnemosyne's.

### Changed

* Depends on `@mnemo-ai/types` 3.6.2. `3.6.4` pinned types 3.6.1, which lacks `DEFAULT_LOCALE`;
  built from this tree against that version, the CLI fails at start-up.
* Host capture works from an npm install. `@mnemo-ai/harness` (not on npm) ships as its built
  package under `dist/harness`, with its qualification records and fixtures, instead of being
  bundled into `index.js`; bundled, it could not find them and every host fell back to
  `mcp-only` ("harness package root not found").

## 3.6.0-alpha.0 (2026-07-06)


### Added

* **cli:** add mnemo init --docker — full local stack bootstrap in one command
* **cli:** add mnemo init — interactive wizard to configure server + MCP clients
* **cli:** add mnemo install — configures all detected AI coding agents
* **cli:** add shell completion + wire previously unreachable AB6.3 commands
* **cli:** mnemo init creates user + tenant, accepts all key formats
* **cli:** W6 productionize recall/remember/forget + version + test suite
* memory_context MCP tool + mnemo info CLI command
* **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
* **p6:** dynamic LLM config per workspace — DB-stored, hot-swappable
* **P7/P13/P14:** API key management + /me identity + doctor CLI
* plugin marketplace + standalone binary builds
* **plugin:** add Claude Code plugin + workspace mapping (P3)
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy


### Fixed

* **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
* **tests:** mark Date.now() in workspace mapping test as determinism-ok


### Changed

* remove all v1/v2/v3 version labels from codebase


### Documentation

* **cli:** update README with all 20 commands including list/search/show/init --docker
* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* reconcile package maturity labels — honest, consistent Beta across all docs


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.6.0-alpha.0
    * @mnemo-ai/client-ts bumped to 3.6.0-alpha.0

## 3.5.0-alpha.0 (2026-07-06)


### Added

* **cli:** add mnemo init --docker — full local stack bootstrap in one command
* **cli:** add mnemo init — interactive wizard to configure server + MCP clients
* **cli:** add mnemo install — configures all detected AI coding agents
* **cli:** add shell completion + wire previously unreachable AB6.3 commands
* **cli:** mnemo init creates user + tenant, accepts all key formats
* **cli:** W6 productionize recall/remember/forget + version + test suite
* memory_context MCP tool + mnemo info CLI command
* **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
* **p6:** dynamic LLM config per workspace — DB-stored, hot-swappable
* **P7/P13/P14:** API key management + /me identity + doctor CLI
* plugin marketplace + standalone binary builds
* **plugin:** add Claude Code plugin + workspace mapping (P3)
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy


### Fixed

* **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
* **tests:** mark Date.now() in workspace mapping test as determinism-ok


### Changed

* remove all v1/v2/v3 version labels from codebase


### Documentation

* **cli:** update README with all 20 commands including list/search/show/init --docker
* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* reconcile package maturity labels — honest, consistent Beta across all docs


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.5.0-alpha.0
    * @mnemo-ai/client-ts bumped to 3.5.0-alpha.0

## 3.4.0-alpha.0 (2026-07-05)


### Added

* **cli:** add mnemo init --docker — full local stack bootstrap in one command
* **cli:** add mnemo init — interactive wizard to configure server + MCP clients
* **cli:** add mnemo install — configures all detected AI coding agents
* **cli:** add shell completion + wire previously unreachable AB6.3 commands
* **cli:** mnemo init creates user + tenant, accepts all key formats
* **cli:** W6 productionize recall/remember/forget + version + test suite
* **dx:** type/param error format + mk_test_ sandbox keys + CLI subcommands + mock server (spec §35)
* memory_context MCP tool + mnemo info CLI command
* **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
* **p6:** dynamic LLM config per workspace — DB-stored, hot-swappable
* **P7/P13/P14:** API key management + /me identity + doctor CLI
* plugin marketplace + standalone binary builds
* **plugin:** add Claude Code plugin + workspace mapping (P3)
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy


### Fixed

* **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
* **tests:** mark Date.now() in workspace mapping test as determinism-ok


### Changed

* remove all v1/v2/v3 version labels from codebase


### Documentation

* **cli:** update README with all 20 commands including list/search/show/init --docker
* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* reconcile package maturity labels — honest, consistent Beta across all docs


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.4.0-alpha.0
    * @mnemo-ai/client-ts bumped to 3.4.0-alpha.0

## 3.3.0-alpha.0 (2026-07-05)


### Added

* **cli:** add mnemo init --docker — full local stack bootstrap in one command
* **cli:** add mnemo init — interactive wizard to configure server + MCP clients
* **cli:** add mnemo install — configures all detected AI coding agents
* **cli:** add shell completion + wire previously unreachable AB6.3 commands
* **cli:** mnemo init creates user + tenant, accepts all key formats
* **cli:** W6 productionize recall/remember/forget + version + test suite
* **dx:** type/param error format + mk_test_ sandbox keys + CLI subcommands + mock server (spec §35)
* memory_context MCP tool + mnemo info CLI command
* **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
* **p6:** dynamic LLM config per workspace — DB-stored, hot-swappable
* **P7/P13/P14:** API key management + /me identity + doctor CLI
* plugin marketplace + standalone binary builds
* **plugin:** add Claude Code plugin + workspace mapping (P3)
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy


### Fixed

* **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
* **tests:** mark Date.now() in workspace mapping test as determinism-ok


### Changed

* remove all v1/v2/v3 version labels from codebase


### Documentation

* **cli:** update README with all 20 commands including list/search/show/init --docker
* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* reconcile package maturity labels — honest, consistent Beta across all docs


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.3.0-alpha.0
    * @mnemo-ai/client-ts bumped to 3.3.0-alpha.0

## 3.2.0-alpha.0 (2026-06-21)


### Added

* **cli:** add shell completion + wire previously unreachable AB6.3 commands
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.2.0-alpha.0
    * @mnemo-ai/client-ts bumped to 3.2.0-alpha.0

## 3.1.0-alpha.0 (2026-06-19)


### Added

* **cli:** implement mnemo CLI — recall, remember, forget, status, config
* **dx:** type/param error format + mk_test_ sandbox keys + CLI subcommands + mock server (spec §35)
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy


### Fixed

* **cli:** add node types to tsconfig + fix string | undefined type errors
* **cli:** rename unused `match` param to `_match` in status formatter


### Documentation

* comprehensive documentation update for v2.0.0-alpha.1
* fix final-audit findings — accurate API examples, real MCP tool surface, package statuses, session SVG
* **repo:** Phase 1+3 — LLM-oriented docs, TSDoc, and algorithm explanations
* unify repo — remove v3 fragmentation, mega README overhaul


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.1.0-alpha.0
    * @mnemo-ai/client-ts bumped to 3.1.0-alpha.0
