# Changelog

All notable changes to Mnemosyne are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). While the version is `0.x`, a minor release (`0.2.0`)
may break compatibility and a patch release (`0.1.1`) does not.

Every package, the SDKs and the agent plugin share one version number. A pull request that
changes what users see adds a line under **Unreleased**; see [CONTRIBUTING.md](CONTRIBUTING.md).

## [Unreleased]

## [0.1.0] — 2026-11-22

First public release. Versioning starts here: the earlier internal `3.x` line is not continued,
and its history is not part of this repository.

### Memory

- Ten typed kinds of memory (facts, decisions, episodes, entities, strategies, workflows, skills,
  tasks, events and reasoning), each recalled and forgotten in its own way.
- Bitemporal facts: every fact keeps when it holds in the world and when the system learned it.
  Forgetting closes a period; nothing is deleted, so past beliefs stay queryable.
- Hybrid recall: full-text and vector search in one call, relevance first, with memory-graph
  context, a Redis hot tier and an optional LLM rerank.
- Sessions become memories: stream the turns, collapse the session, and facts, decisions and
  entities are extracted from it.
- Conflict detection and corrections that keep lineage; background consolidation; reminders by
  time or by condition; a typed relation graph with nine relation verbs.

### Security and teams

- Postgres row-level security with `FORCE` on tenant tables; workspace isolation tested under a
  restricted database role.
- Four sensitivity tiers on every memory, enforced as a per-key ceiling (a hidden row answers 404).
- Personal data redacted on write; API keys with scopes and a sensitivity ceiling; approvals for
  sensitive actions; an append-only audit log.

### Ways in

- MCP server with 37 tools (`MNEMO_MCP_TOOLS=core` serves 9), a REST API with OpenAPI, gRPC and
  WebSocket, the `mnemo` CLI, a typed TypeScript client, Python and Go SDKs, and a web dashboard.
- Agent plugin for Claude Code, Codex, Cursor, OpenCode and Gemini; conversation capture is
  opt-in per host (`mnemo install --capture <host>`).
- Bring your own model API: OpenAI, Anthropic, Google, Cohere, Mistral, Voyage, AWS Bedrock, or a
  local Ollama behind `--profile local`. No model or key ships with it.

### Known limits

See [`docs/STATUS.md`](docs/STATUS.md): pinning does not raise a fact in recall, default recall
searches seven of the ten kinds, and the Python and Go SDKs are not on PyPI or tagged yet.

[Unreleased]: https://github.com/lucasmailland/mnemosyne/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lucasmailland/mnemosyne/releases/tag/v0.1.0
