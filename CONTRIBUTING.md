# Contributing to Mnemosyne

**English** · [Español](CONTRIBUTING.es.md)

Thanks for your interest. This file is the quickest path to a working dev setup and a green PR.

## Prerequisites

- Node.js 22.18+
- pnpm 9+
- Docker (for the local Postgres + pgvector stack)

## Setup

```bash
git clone https://github.com/lucasmailland/mnemosyne
cd mnemosyne
pnpm install
pnpm docker:up                   # builds images on first run, starts the local stack (see below)
pnpm build
pnpm test
```

`pnpm docker:up` runs `docker compose` with `docker/docker-compose.yml` and the local
`docker-compose.override.yml`. On the first run it builds the server and migration images (later
runs reuse them; `pnpm docker:build` rebuilds). It starts Postgres + pgvector, Redis, the one-shot
migration runner and the server on port 3939, every port published on `127.0.0.1` only. The model
API comes from `docker/.env` (copy `docker/.env.example` and uncomment one block); local Ollama is
opt-in with `--profile local` (see `docker/README.md`).

### Integration tests

`pnpm test:integration` starts its own Postgres containers through Testcontainers. With OrbStack,
Colima or rootless Docker, point it at your runtime's socket first, for example:

```bash
export DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

## Repository layout

The monorepo uses pnpm workspaces + Turborepo across many packages; the main ones are:

| Package                      | Role                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `@mnemo-ai/types`            | Port interfaces + domain types. Zero runtime deps.                                                         |
| `@mnemo-ai/core`             | Pure business logic. No I/O. Adapter-injected.                                                             |
| `@mnemo-ai/adapter-postgres` | DrizzleORM + Postgres StorageAdapter.                                                                      |
| `@mnemo-ai/adapter-redis`    | Redis CacheAdapter.                                                                                        |
| `@mnemo-ai/adapter-vector`   | pgvector VectorAdapter.                                                                                    |
| `@mnemo-ai/adapter-llm`      | LLMAdapter bridge (delegates to llm-providers).                                                            |
| `@mnemo-ai/llm-providers`    | Pluggable LLM backends (OpenAI, Anthropic, …).                                                             |
| `@mnemo-ai/server`           | Hono HTTP server wrapping core. Stateless; horizontally scalable.                                          |
| `@mnemo-ai/mcp`              | Standalone MCP server (stdio). Talks to the HTTP API.                                                      |
| `@mnemo-ai/client-ts`        | Typed TypeScript client SDK for the HTTP API.                                                              |
| `@mnemo-ai/cli`              | Operations CLI (`recall`, `remember`, `status`, `forget`, `config`).                                       |
| `@mnemo-ai/consolidation`    | Background memory consolidation service.                                                                   |
| `@mnemo-ai/cup`              | CUP — v2→v3 data migration (rule-based; LLM re-classification is opt-in).                                  |
| `@mnemo-ai/federation`       | Cross-instance federation (peer discovery + voting).                                                       |
| `@mnemo-ai/plugins`          | Plugin loader infrastructure.                                                                              |
| `@mnemo-ai/harness`          | Local transcript harness: session capture for Claude Code, Codex and OpenCode (opt-in).                    |
| `@mnemo-ai/dashboard`        | Web dashboard (Next.js): observability, configuration, interactive recall.                                 |
| `@mnemo-ai/mock-server`      | Offline mock server with deterministic in-memory fixtures (no database).                                   |
| `packages/plugin`            | Host plugin for AI coding agents (Claude Code, Codex, Cursor, OpenCode, Gemini): hooks, skill, MCP wiring. |
| `packages/sdk-go`            | Go client SDK for the HTTP API.                                                                            |
| `packages/sdk-python`        | Python client SDK for the HTTP API (`mnemo-ai-sdk`, not on PyPI yet).                                      |

See [`CLAUDE.md`](./CLAUDE.md) for the complete architecture and LLM coding guide.

## Workflow

1. Branch from `main`: `git checkout -b feat/your-thing`
2. Make changes. Tests live next to source as `*.test.ts`.
3. `pnpm test && pnpm lint && pnpm typecheck` — must pass before opening a PR.
4. Use **Conventional Commits** in your commit messages (`feat:`, `fix:`, `docs:`, `chore:`, and `feat!:` or a `BREAKING CHANGE:` footer for a breaking change). Whoever cuts the release reads them to pick the version bump.
5. Sign off every commit with `git commit -s`. The `Signed-off-by:` line certifies the
   [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change or
   have the right to submit it under the project's licence. This is the project's contribution
   licence statement; a pull request with unsigned commits is not merged.
6. Open a PR.

Do **not** run `changeset add`: Changesets has been removed.

## Releases

Releases are manual. GitHub Actions is turned off for this repository, so nothing in
`.github/workflows/` runs, release-please included. The steps, the publish order and the
versioning rules are in [`docs/RELEASING.md`](docs/RELEASING.md).

## Design principles

- **Core has no I/O.** Everything is an adapter interface. This is what lets us swap Drizzle for raw `pg`, swap OpenAI for Anthropic, etc.
- **Bitemporal by default.** `valid_time` (when the fact is true in the world) and `transaction_time` (when we learned it) are first-class.
- **RLS + FORCE.** Multi-tenant isolation at the SQL layer. The app role never bypasses it.
- **No silent failures.** Every adapter capability is feature-flagged; missing capabilities surface as typed errors, never as empty results.

## Code style

Prettier (no ESLint: `pnpm lint` runs typecheck-based and custom checks). Run `pnpm format` before committing.
