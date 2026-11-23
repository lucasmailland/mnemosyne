# Contributing to Mnemosyne

**English** · [Español](CONTRIBUTING.es.md)

Thanks for your interest. This file is the quickest path to a working dev setup and a green PR.

## Before you start

- **Questions and ideas** go to [Discussions](https://github.com/lucasmailland/mnemosyne/discussions).
- **Bugs and feature requests** go to [Issues](https://github.com/lucasmailland/mnemosyne/issues/new/choose); the forms ask for what we need to reproduce.
- **Security problems** never go in a public issue: report them privately as [SECURITY.md](SECURITY.md) explains.
- **Larger changes** (a new primitive, a schema change, a new public API) start with an issue or a discussion, so the design is agreed before the code is written.
- Looking for a first task? Issues labelled [`good first issue`](https://github.com/lucasmailland/mnemosyne/labels/good%20first%20issue) and [`help wanted`](https://github.com/lucasmailland/mnemosyne/labels/help%20wanted) are a good start.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

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

1. Fork the repository and branch from `main`: `git checkout -b feat/your-thing`
2. Make changes. Tests live next to source as `*.test.ts`; a bug fix comes with a test that fails without it.
3. `pnpm build && pnpm lint && pnpm typecheck && pnpm test` must pass. If you touched RLS, recall,
   migrations or the database adapters, run `pnpm test:integration` too (it needs Docker).
4. Use **Conventional Commits** in your commit messages (`feat:`, `fix:`, `docs:`, `chore:`, and `feat!:` or a `BREAKING CHANGE:` footer for a breaking change). Whoever cuts the release reads them to pick the version bump.
5. Sign off every commit with `git commit -s`. The `Signed-off-by:` line certifies the
   [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change or
   have the right to submit it under the project's licence. This is the project's contribution
   licence statement; a pull request with unsigned commits is not merged.
6. If users will notice the change, add a line under **Unreleased** in [`CHANGELOG.md`](CHANGELOG.md)
   (`Added`, `Changed`, `Fixed`, `Removed` or `Security`). Internal refactors and test-only
   changes do not need one.
7. Open a pull request and fill in the template. Keep it focused: one change per pull request.

Do **not** run `changeset add`: Changesets has been removed.

## Checks and review

GitHub Actions is turned off for this repository, so no check runs on your pull request by
itself. The repository's pre-push hook runs the same gate a release uses
(`FULL=0 COVERAGE=1 bash scripts/full-sweep.sh`: build, lint, typecheck and every unit suite); it
takes several minutes. Before merging, a maintainer runs the gate on your branch, and the
integration suites when the change needs them.

We aim to answer a new pull request or issue within a week. Changes to security-sensitive
code (RLS, sensitivity, authentication, provenance) get a second look against the invariants in
[`CLAUDE.md`](CLAUDE.md).

## Releases

Releases are manual and every package shares one version, starting at `0.1.0`. The steps, the
publish order and the versioning rules are in [`docs/RELEASING.md`](docs/RELEASING.md).

## Design principles

- **Core has no I/O.** Everything is an adapter interface. This is what lets us swap Drizzle for raw `pg`, swap OpenAI for Anthropic, etc.
- **Bitemporal by default.** `valid_time` (when the fact is true in the world) and `transaction_time` (when we learned it) are first-class.
- **RLS + FORCE.** Multi-tenant isolation at the SQL layer. The app role never bypasses it.
- **No silent failures.** Every adapter capability is feature-flagged; missing capabilities surface as typed errors, never as empty results.

## Code style

Prettier (no ESLint: `pnpm lint` runs typecheck-based and custom checks). Run `pnpm format` before committing.
