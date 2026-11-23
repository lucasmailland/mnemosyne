# Mnemosyne Plugin

**English** · [Español](README.es.md)

Persistent memory for AI coding agents. Remembers architectural decisions, bug fixes, user preferences, and session context across every session.

## Installation

### Claude Code

**Recommended** — `mnemo install` (run by the CLI, see [CLI guide](https://github.com/lucasmailland/mnemosyne/blob/main/docs/guides/CLI.md)) drives the native marketplace flow for you: `claude plugin marketplace add`, `claude plugin marketplace update`, `claude plugin uninstall`, then `claude plugin install` — refreshing an existing install and self-healing a stale one on every run. It requires the `claude` CLI on `PATH`; if it's missing, the Claude Code branch skips with an actionable message instead of failing silently.

Manual equivalent, if you prefer to run the commands yourself:

**Step 1** — Register the Mnemosyne marketplace (once per machine):

```bash
claude plugin marketplace add lucasmailland/mnemosyne
```

**Step 2** — Install the plugin:

```bash
claude plugin install mnemosyne@mnemosyne
```

Claude Code will install the plugin and auto-wire session hooks. On the next session start, the memory protocol is injected automatically.

**Step 3** — Register the MCP server. The plugin ships hooks and skills but **no MCP server**: `.claude-plugin/plugin.json` deliberately declares none, because the server takes its key from `MNEMO_KEY` and a plugin manifest could only embed it or require it in the environment Claude Code starts with, and because a plugin-declared server gets plugin-namespaced tool names that would not match the `mcp__mnemosyne__*` tools the hooks point the model at. `mnemo install` does this step for you; by hand:

```bash
claude mcp add --scope user mnemosyne \
  -e MNEMO_URL=https://your-server -e MNEMO_KEY=mns_live_... \
  -- npx -y @mnemo-ai/mcp
```

Without it, the hooks still recall automatically, but the model has no `memory_*` tools to call.

> The marketplace is defined in `.claude-plugin/marketplace.json` at the repo root.
> The plugin source lives at `packages/plugin/` and is referenced via `"source": "./packages/plugin"`.

Alternatively, via the slash command inside a Claude Code session:

```
/plugin marketplace add lucasmailland/mnemosyne
```

**Local development install** — `mnemo install --local` installs the plugin from your local working-tree `packages/plugin/` instead of via the marketplace (useful for testing uncommitted plugin changes). This is a development install only: it is not git-tracked, has no `gitCommitSha`, and Claude Code will never update it automatically — a later `mnemo install` (no flag) replaces it with the published plugin. `--local` never calls `claude plugin marketplace`/`claude plugin install`/`uninstall`.

If `claude plugin marketplace add` fails, this is most often because `lucasmailland/mnemosyne` is private and inaccessible to your current GitHub account — authenticate with `gh auth login` or SSH, or use `mnemo install --local` as a workaround. The error message states this as a _possible_ cause, not a certainty, since the underlying `claude` exit codes for this failure mode are undocumented.

### Cursor

1. Copy `.cursor-plugin/` to your project root (or a global location Cursor scans for plugins).
2. Add the MCP server to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "node",
      "args": ["/path/to/mnemosyne/packages/mcp/dist/index.js"],
      "env": {
        "MNEMO_URL": "http://localhost:3939",
        "MNEMO_KEY": "your-api-key"
      }
    }
  }
}
```

3. Copy `AGENTS.md` to your project root so Cursor loads the memory protocol automatically.

### Gemini CLI

1. Copy `GEMINI.md` and `gemini-extension.json` to your project root.
2. Gemini CLI will load `GEMINI.md` as context and register the extension.

Alternatively, copy `GEMINI.md` to `~/.gemini/GEMINI.md` for global activation across all projects.

### Codex (OpenAI)

1. Copy `.codex-plugin/` to your project root.
2. Set environment variables (see Configuration below).
3. The plugin will load `AGENTS.md` as the memory protocol.

### Manual (any runtime)

1. Start a Mnemosyne server (see [deployment docs](https://github.com/lucasmailland/mnemosyne/blob/main/docs/DEPLOYMENT.md)).
2. Set environment variables:

```bash
export MNEMO_URL=http://localhost:3939
export MNEMO_KEY=your-api-key
```

Or create `~/.mnemo/config.json`:

```json
{
  "url": "http://localhost:3939",
  "apiKey": "your-api-key"
}
```

> The env vars take precedence over the file, in the CLI and in every hook. That
> is easy to forget once they are exported from a shell profile: a stale
> `export MNEMO_URL` silently wins over a correct config file, and the hooks talk
> to whatever it points at.

### `recallTimeoutMs` — budget for the hook's auto-recall

The `UserPromptSubmit` hook recalls context for your first message of a session
and gives that request a bounded budget. The default is **1.5 s**, measured
against a local stack (Ollama, rerank off).

A remote server does not honour that measurement. Against an instance behind TLS
with a hosted embedding provider, the same recall costs roughly **0.5–1.8 s**
depending on whether the embedding cache hits — straddling the default, so
auto-recall fails _intermittently_. That reads like an unstable server rather
than a budget that is too tight, which is why it is worth naming here.

```bash
mnemo config set recallTimeoutMs 3000
```

Milliseconds, positive integer. Anything else (non-numeric, `0`, negative) is
rejected by the CLI and ignored by the hook, which falls back to the default —
`curl --max-time 0` means _no limit_, the opposite of what `0` suggests. Values
above 8 s are clamped: the hook has a hard ceiling in `hooks.json`, and a budget
past it buys nothing except losing the "call `memory_recall` yourself"
degradation message.

Leaving it unset keeps the 1.5 s default, which is the right value for a local
server — this exists so a remote deployment does not force its latency on one.

3. Add the MCP server to your runtime's MCP configuration pointing to `packages/mcp/dist/index.js`.
4. Copy `SKILL.md` (or `AGENTS.md` / `GEMINI.md`) to your project root so the memory protocol is loaded automatically.

---

## File Structure

```
packages/plugin/
├── .claude-plugin/plugin.json       # Claude Code plugin manifest
├── .cursor-plugin/plugin.json       # Cursor plugin manifest
├── .codex-plugin/plugin.json        # Codex plugin manifest
├── gemini-extension.json            # Gemini CLI extension registration
├── AGENTS.md                        # Protocol for Cursor, Windsurf, Copilot
├── GEMINI.md                        # Protocol for Gemini CLI (static version)
├── hooks/
│   └── hooks.json                   # Claude Code hook definitions
├── scripts/
│   ├── _helpers.sh                  # Shared shell helpers
│   ├── session-start.sh             # Session start hook
│   ├── session-stop.sh              # Session stop hook
│   ├── post-compaction.sh           # Post-compaction recovery hook
│   ├── user-prompt-submit.sh        # Per-prompt hook
│   └── subagent-stop.sh             # Subagent stop hook
└── skills/memory/
    ├── SKILL.md                     # Canonical memory protocol (all runtimes)
    └── references/
        ├── claude-code-tools.md     # Claude Code tool mapping
        ├── cursor-tools.md          # Cursor tool mapping
        └── gemini-tools.md          # Gemini CLI tool mapping
```

---

## How It Works

The plugin injects the memory protocol (`SKILL.md`) at session start. The protocol instructs the agent to:

1. Call `memory_recall` before the first response in every session.
2. Call `memory_remember` proactively after decisions, bug fixes, and preferences — without being asked.
3. In a pure-MCP session, send the real exchanges with `memory_session(action: "turn", ...)` and call `memory_episode_end` before saying "done"; when the hooks manage the session, do not end it.
4. Compaction does not end the session: after it, keep the same `sessionId`, call `memory_status` and `memory_recall`.

All memory is stored in a Mnemosyne server instance. The MCP server (`packages/mcp/`) serves all 37 memory tools (`MNEMO_MCP_TOOLS=core` trims them to 9).

---

## Requirements

- A running Mnemosyne server (local or hosted). See [DEPLOYMENT.md](https://github.com/lucasmailland/mnemosyne/blob/main/docs/DEPLOYMENT.md).
- `MNEMO_URL` and `MNEMO_KEY` configured (env vars or `~/.mnemo/config.json`).
- MCP support in your runtime (Claude Code, Cursor Agent mode, Gemini CLI, Codex).
