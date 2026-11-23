# Roadmap

Mnemosyne is in alpha, on the `3.6.x` line. What exists today is in
[`docs/STATUS.md`](./docs/STATUS.md) and the README; this file only lists what is still ahead.

## Where it stands (2026-11-19)

- 18 workspace packages under `packages/` (17 libraries and services plus the dashboard), the
  `packages/plugin` host plugin, a Python SDK and a Go SDK.
- 79 v3 migrations (`packages/adapter-postgres/migrations/baseline/`) and the 40-file v2 stream
  (`packages/core/migrations/`).
- An MCP server with 37 tools, a CLI with 49 commands, and the web dashboard.
- On npm: `@mnemo-ai/cli`, `@mnemo-ai/mcp`, `@mnemo-ai/client-ts` and `@mnemo-ai/types`.
  Everything else is internal.

## Next

- **Release from git again.** npm carries versions that git never had; the next CLI needs a new
  `@mnemo-ai/types` first. The manual process is in [`docs/RELEASING.md`](./docs/RELEASING.md).
- **CI.** GitHub Actions is off; until it is back, the release gate is
  `FULL=1 bash scripts/full-sweep.sh` run locally.
- **Publish the SDKs.** The Python SDK (`mnemo-ai-sdk`) is not on PyPI and the Go module has no
  tag yet; both install from the repository today.
- **A real linter.** `pnpm lint` runs the typecheck-based and custom checks only; there is no
  ESLint or Biome.
- **Worked examples** beyond `examples/graph-viewer`.
- **First stable release.**

## Later

- More storage adapters beyond Drizzle (raw `pg`, Prisma) against the storage port.
- Recall research: pluggable rerankers, learned fusion weights, graph-walk strategies.

## Deferred (on purpose)

- A framework-coupled `<MemoryGraph/>` component. `@mnemo-ai/core/graph` ships data and canvas
  primitives; the UI stays in the consumer's app.

---

Have an idea or a need this doesn't cover? Open an
[issue](https://github.com/lucasmailland/mnemosyne/issues).
