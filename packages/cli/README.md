# @mnemo-ai/cli

**English** · [Español](README.es.md)

> The `mnemo` command for [Mnemosyne](https://github.com/lucasmailland/mnemosyne), cognitive memory for AI agents: recall and remember from the terminal, manage sessions, keys and workspaces, and run `mnemo install` to register the MCP server in Claude Code, Cursor, Codex, Gemini CLI, OpenCode and Windsurf.
>
> [Repository](https://github.com/lucasmailland/mnemosyne) · [CLI guide](https://github.com/lucasmailland/mnemosyne/blob/main/docs/guides/CLI.md) · [Status](https://github.com/lucasmailland/mnemosyne/blob/main/docs/STATUS.md)

The official command-line interface for Mnemosyne.

> **Needs a running Mnemosyne server and an API key.** The [quickstart](https://github.com/lucasmailland/mnemosyne#quickstart) starts one with Docker in a few minutes.

## Overview

`mnemo` is a lightweight CLI for interacting with a running Mnemosyne server. It is intended for
operators checking server health, developers storing and searching facts during local development,
and shell scripts that need to integrate memory operations into automation pipelines.

**Design philosophy** — the binary uses native Node.js `fetch` only. There is no CLI framework
(no `commander`, no `yargs`), no HTTP client library (no `axios`). Besides the Mnemosyne client and types it depends
only on two small parsers, `jsonc-parser` and `smol-toml`. This keeps the install footprint minimal and startup time fast.

## Installation

```bash
# pnpm (recommended)
pnpm add -g @mnemo-ai/cli

# npm
npm install -g @mnemo-ai/cli
```

Verify the install:

```bash
mnemo help
```

You should see the command reference printed to stdout.

## Standalone Binary (no Node required)

You can build a self-contained binary that ships the runtime with the application code.
It is built with **bun compile**, so the build machine needs Bun.

### bun compile

Produces a single `mnemo-standalone` binary that embeds the Bun runtime (~58 MB on macOS arm64).
No Node.js or npm needed on the target machine.

**Prerequisites:** [Bun](https://bun.sh) ≥ 1.1 installed on the _build_ machine.

```bash
# From the repo root
pnpm --filter @mnemo-ai/cli build:standalone

# Or from packages/cli directly
bun build src/index.ts --compile --outfile dist/mnemo-standalone --target bun
```

**Test it:**

```bash
./packages/cli/dist/mnemo-standalone help
./packages/cli/dist/mnemo-standalone version
```

**File size:** ~58.6 MB (arm64 macOS).

**Distribute:**

```bash
# Install globally on the build machine
cp packages/cli/dist/mnemo-standalone /usr/local/bin/mnemo
chmod +x /usr/local/bin/mnemo

# Or copy to a server / CI artefact
scp packages/cli/dist/mnemo-standalone user@server:/usr/local/bin/mnemo
```

> **macOS code-signing note:** The bun-compiled binary is an unsigned Mach-O executable.
> On macOS you may need to ad-hoc sign it before running it outside a terminal:
>
> ```bash
> codesign --force --sign - dist/mnemo-standalone
> ```

### Does `dist/index.js` work on another machine?

Yes, with caveats. The tsup output (`dist/index.js`) is a self-contained ESM bundle with no
external npm dependencies — it only needs Node ≥ 20 on the target machine.

```bash
# Copy the single file and run it directly
scp packages/cli/dist/index.js user@server:/usr/local/lib/mnemo.js
chmod +x /usr/local/lib/mnemo.js

# Run (Node 20+ required)
node /usr/local/lib/mnemo.js help
```

For a zero-install distribution without Node, use the standalone binaries above.

## Configuration

`mnemo` stores its configuration in `~/.mnemo/config.json`. The directory and file are created
automatically on first `config set`.

**Config file format**

```json
{
  "url": "http://localhost:3939",
  "apiKey": "mns_live_..."
}
```

**Environment variable override**

Both values can be overridden at runtime without touching the config file:

| Variable    | Overrides | Example                             |
| ----------- | --------- | ----------------------------------- |
| `MNEMO_URL` | `url`     | `MNEMO_URL=http://prod.example.com` |
| `MNEMO_KEY` | `apiKey`  | `MNEMO_KEY=mns_live_yourkey`        |

**Priority** — environment variables take precedence over the config file. If neither is set,
`mnemo` exits with code 3 and prints an actionable error message.

### Language

`mnemo` speaks American English (`en-US`) and Latin American Spanish (`es-419`). The language is picked once, before anything prints, from the first of:

1. The global `--locale <tag>` flag. It must come **before** the subcommand: `mnemo --locale es-419 recall "query"`. The `--locale=es-419` form is not supported, and after the subcommand the flag is handed to the command untouched and does not change the language (same rule as `--workspace`).
2. `MNEMO_LOCALE`.
3. `"locale"` in `~/.mnemo/config.json` (`mnemo config set locale es-419`).
4. The first one set of `LC_ALL`, `LC_MESSAGES`, `LANG`.
5. `en-US`.

Any tag starting with `es` (`es`, `es-MX`, `es_AR.UTF-8`) maps to `es-419`; a tag that is not Spanish or English maps to `en-US`. An invalid `--locale` value is a usage error. In the `MNEMO_LOCALE`, config and POSIX steps an unknown value is skipped and the chain continues: `MNEMO_LOCALE=fr` with `LANG=es_AR.UTF-8` gives Spanish.

`MNEMO_LOCALE` is also read by `@mnemo-ai/mcp` (the MCP server). Like `MNEMO_URL` and `MNEMO_KEY`, if you export it in a shell, an MCP server started from that shell inherits it.

In Spanish, prompts show `[s/N]` and accept `s`, `sí` or `si` as well as `y`/`yes`. `--json` output, flag names, command names and exit codes never change.

**Initial setup**

```bash
mnemo config set url http://localhost:3939
mnemo config set apiKey mns_live_yourkey

# Verify (apiKey is masked in output)
mnemo config get
```

Expected output:

```
{
  "url": "http://localhost:3939",
  "apiKey": "****...rkey"
}
```

## Commands

### `mnemo recall <query>`

Search memory using hybrid semantic + lexical search. Returns the top 10 hits ranked by
relevance score (vector weight 0.7, lexical weight 0.3).

**Syntax**

```
mnemo recall <query>
```

**Example**

```bash
mnemo recall "user prefers TypeScript"
```

**Output**

```
id                                     │ score    │ statement
──────────────────────────────────────────┼──────────┼──────────────────────────────────────────────────
01j9abc123def456ghi789jkl012mno345pq   │ 0.9412   │ The user prefers TypeScript over Python
01j9abc789rst012uvw345xyz678abc901de   │ 0.8203   │ TypeScript generics allow type-safe reuse
```

Columns are fixed-width and aligned. The `statement` column truncates at 80 characters with an
ellipsis (`…`) if the text is longer.

If no results are found:

```
No results found.
```

---

### `mnemo remember <text>`

Store a new fact in memory. The text is stored as a single statement and immediately embedded.

**Syntax**

```
mnemo remember <text>
```

**Example**

```bash
mnemo remember "The user prefers TypeScript over Python"
```

**Output**

```
✓ Remembered: 01j9abc123def456ghi789jkl012mno345pq
```

The returned ID is a ULID that uniquely identifies this fact. Save it if you need to delete it
later with `mnemo forget`.

---

### `mnemo forget <id>`

Soft-delete a fact by its ID. The fact is removed from future search results.

**Syntax**

```
mnemo forget <id>
```

**Example**

```bash
mnemo forget 01j9abc123def456ghi789jkl012mno345pq
```

**Output**

```
✓ Forgotten: 01j9abc123def456ghi789jkl012mno345pq
```

Exits with code 4 if the ID does not exist (see [Exit Codes](#exit-codes) for other failures).

---

### `mnemo status`

Check server health. Hits `/health` and pretty-prints the response with color-coded status
values: green for `ok`/`healthy`, yellow for `degraded`, red for anything else.

**Syntax**

```
mnemo status
```

**Example**

```bash
mnemo status
```

**Output (healthy)**

```json
{
  "status": "ok",
  "version": "0.1.0",
  "checks": {
    "db": "ok",
    "redis": "ok",
    "embeddings": "ok"
  }
}
```

**Output (degraded)**

```json
{
  "status": "degraded",
  "checks": {
    "db": "ok",
    "redis": "degraded",
    "embeddings": "ok"
  }
}
```

The status strings are colorized in a terminal that supports ANSI escape codes.

---

### `mnemo config set <key> <value>`

Persist a configuration value to `~/.mnemo/config.json`.

**Valid keys** — `url`, `apiKey`, `uiMode` (`delight`, `verbose`, `quiet`), `locale` (`en-US`, `es-419`).

**Syntax**

```
mnemo config set <key> <value>
```

**Examples**

```bash
mnemo config set url http://localhost:3939
mnemo config set apiKey mns_live_abc123xyz
mnemo config set uiMode delight
mnemo config set locale es-419
```

**Output**

```
✓ Set url
```

Exits with code 2 if an unknown key is supplied.

---

### `mnemo config get [key]`

Read configuration values. The `apiKey` is always masked — only the last 4 characters are shown.

**Syntax**

```
mnemo config get           # print all values
mnemo config get url       # print a single value
mnemo config get apiKey    # print masked apiKey
```

**Examples**

```bash
$ mnemo config get
{
  "url": "http://localhost:3939",
  "apiKey": "****xyz"
}

$ mnemo config get url
http://localhost:3939

$ mnemo config get apiKey
****xyz
```

Prints `(not set)` for keys that have no value in either the config file or environment.

---

### `mnemo login [--url <url>] [--key <apiKey>]`

Save server credentials to `~/.mnemo/config.json` (created securely with mode `0600`). Supports both interactive prompts and non-interactive flags:

```bash
# Non-interactive (scripting / CI):
npx -y @mnemo-ai/cli login --url https://mnemo.example.com --key mns_live_...

# Interactive:
mnemo login
```

---

### `mnemo install`

Automatically detect and configure all installed AI coding agents on this machine (**Claude Code**, **Cursor**, **OpenCode**, **Codex**, **Gemini CLI**):

```bash
npx -y @mnemo-ai/cli install
```

What `mnemo install` does:

1. **Registers the MCP Server**: Configures `@mnemo-ai/mcp` across all detected agents.
2. **Installs Hooks & Skills**: Automatically registers session hooks (`session-start`, `user-prompt-submit`, `session-end`) and cognitive skills for Claude Code, Cursor, and Gemini.

> ℹ️ **Manual JSON vs. Auto-Installer:** Adding the `mcpServers` JSON block manually to Claude Desktop or Cursor registers the MCP tools, but does **not** install session hooks or skills. Use `mnemo install` for a complete automatic setup.

---

### `mnemo info` / `mnemo whoami`

Display current session context, including connected server URL, active workspace ID, user identity, tenant role, and storage stats.

```bash
mnemo info
```

---

### `mnemo doctor`

Run server-side diagnostics including API connectivity, RLS status, table grants, and embedding worker queues.

```bash
mnemo doctor
```

---

### `mnemo workspace list` / `mnemo workspace members <id>`

List workspaces accessible to the authenticated user, or inspect workspace members.

```bash
mnemo workspace list
mnemo workspace members 00000000-0000-0000-0000-000000000001
```

---

### `mnemo keys <list|create|revoke|show|rotate|scoped>`

Manage API keys for the active workspace:

```bash
mnemo keys list
mnemo keys create --label "CI Agent" --scopes memory:read,memory:write
mnemo keys rotate mk_abc123def456 "scheduled rotation"
mnemo keys scoped create --type sess --scopes memory:read --expires 8h
mnemo keys scoped revoke mk_sess_a1B2c3D4e5F6
```

`keys scoped create|rotate|revoke` manages the scoped-scheme keys that `MNEMO_SCOPED_AUTH=1` verifies (`POST /admin/scoped-keys`). `--type admin` issues a break-glass `mk_admin_` key bound to your user and prints its TOTP secret once; every request with it needs a current code in `x-mnemo-mfa`.

---

### `mnemo policy <list|get|set|delete>`

Manage the RBAC policy of each agent in the workspace (needs `memory:admin`). An agent is identified by the id of its API key (`mnemo keys list`). `set` creates or replaces the whole policy from a JSON file; the server rejects unknown fields and scopes. A key cannot change its own policy, and a change applies at once on the server that took it and within 60 seconds on other replicas.

```bash
mnemo policy list
mnemo policy get 6f1c2d3e-0000-4000-8000-000000000001
mnemo policy set 6f1c2d3e-0000-4000-8000-000000000001 --file acme-agent-policy.json
mnemo policy delete 6f1c2d3e-0000-4000-8000-000000000001
```

The file holds every field of the policy (`namespaces` is optional; a limit of `0` means unlimited):

```json
{
  "readScopes": ["memory:read"],
  "writeScopes": ["memory:write"],
  "selfEdit": { "enabled": false },
  "taskScopes": { "canCreate": true, "canDelegate": false, "canDelegateTo": [] },
  "limits": {
    "maxRecallsPerMinute": 600,
    "maxWritesPerMinute": 120,
    "maxSessionsConcurrent": 10,
    "maxSelfEditsPerSession": 3
  },
  "requireApprovalFor": ["delete_fact", "bulk_export"],
  "federationAccess": "none",
  "namespaces": ["acme-*"]
}
```

---

### `mnemo list [--limit N]`

List recent facts from the workspace, sorted by creation date descending. Default: 20 facts.

```bash
mnemo list
mnemo list --limit 50
```

---

### `mnemo search <query>`

Full-text search without Claude. Uses the recall pipeline with FTS fallback — works even without `MNEMO_LLM_API_KEY`.

```bash
mnemo search "TypeScript generics"
mnemo search "bug fixed in auth"
```

---

### `mnemo show <factId>`

Display all fields of a fact as pretty-printed JSON.

```bash
mnemo show mfact_abc123def456
```

---

### `mnemo sessions`

List active and recent sessions for the workspace.

```bash
mnemo sessions
```

---

### `mnemo tasks`

List tasks in the workspace.

```bash
mnemo tasks
```

---

### `mnemo events`

List events recorded in the workspace log.

```bash
mnemo events
```

---

### `mnemo health`

Show detailed health information including `/health/ready` and `/health` endpoints. More detailed than `mnemo status`.

```bash
mnemo health
```

---

### `mnemo export`

Export workspace memory as gzip-compressed JSONL to stdout. Pipe with `gunzip` to process:

```bash
mnemo export | gunzip | jq .
mnemo export > backup.jsonl.gz
```

---

### `mnemo import <file.jsonl.gz>`

Import a previously exported JSONL archive. Supports `--from mem0|zep|claude` for third-party formats and `--conflict-resolution skip|overwrite|newest`.

```bash
mnemo import ./backup.jsonl.gz
mnemo import ./claude-memory.json --from claude
mnemo import ./export.jsonl.gz --conflict-resolution newest
```

---

### `mnemo init [--docker]`

Setup wizard with two modes:

- **Without `--docker`**: prompts for server URL + API key, configures Claude Code MCP and Claude Desktop.
- **With `--docker`**: bootstraps a complete local stack — starts Docker (Postgres + Redis), runs migrations, generates an API key, configures MCP. Requires the Mnemosyne monorepo.

```bash
mnemo init             # cloud/manual mode
mnemo init --docker    # full local Docker bootstrap
```

---

### `mnemo link [--label <name>] [--force]`

Write a `.mnemo.json` file in the current directory, pinning it to the active API key's workspace. Project-local config that `SessionStart` hooks (installed by `mnemo install`) auto-discover, so agents launched from this directory resolve the right workspace without re-running `mnemo login`.

```bash
mnemo link                        # pin cwd to the current workspace
mnemo link --label "backend-svc"  # optional human-readable label
mnemo link --force                # overwrite an existing .mnemo.json
```

Fails if `.mnemo.json` already exists (pass `--force` to overwrite), or if the active API key can't resolve a `workspaceId` (needs at least `memory:read`, same as `mnemo whoami`).

---

### `mnemo reset --workspace <id> --confirm`

Runs a **dry-run** safety check for a workspace embedding-model reset (`targetModel: "reset"`) — does not delete or mutate data. Blocked entirely when `NODE_ENV=production`, and requires explicit `--confirm` even outside production.

```bash
mnemo reset --workspace 3fa85f64-5717-4562-b3fc-2c963f66afa6 --confirm
```

---

### `mnemo completion <shell>`

Generate shell completion scripts. Supported shells: `bash`, `zsh`, `fish`, `pwsh`.

```bash
mnemo completion bash >> ~/.bashrc
mnemo completion zsh >> ~/.zshrc
source <(mnemo completion fish)
```

---

### `mnemo help`

Print the built-in command reference to stdout.

```bash
mnemo help
# or simply
mnemo
```

## Exit Codes

| Code | Meaning                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------- |
| `0`  | Command completed successfully.                                                                                     |
| `1`  | Generic failure: anything not covered below. Scripts that only test for non-zero keep working.                      |
| `2`  | Usage error: unknown command or flag, missing or invalid argument. Also `mnemo export` while it waits for approval. |
| `3`  | Authentication or authorization: no server or key configured, HTTP 401 or 403.                                      |
| `4`  | Not found: HTTP 404 (for example `mnemo forget <unknown id>`).                                                      |
| `5`  | Transient failure worth retrying: network error, timeout, HTTP 408, 429 or 5xx.                                     |

## Output streams

stdout carries only the command's result. Banners (`🧠 ... [mnemosyne] ...`), progress text and
error messages are written to stderr, so `--json` output and pipes are never polluted.
`--json` is available on `recall`, `remember`, `status`, `health` and `doctor`; the other
list/show commands already print JSON payloads on stdout.

## Scripting

Because `mnemo` writes clean output to stdout and errors to stderr, it integrates naturally
into shell scripts.

**Check whether a remember succeeded**

```bash
if mnemo remember "Deploy completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"; then
  echo "Memory stored."
else
  echo "Failed to store memory." >&2
  exit 1
fi
```

**Use environment variables for per-job credentials**

```bash
MNEMO_URL=https://prod.example.com \
MNEMO_KEY=mns_live_yourkey \
mnemo status
```

**Capture the ID from remember**

The confirmation line goes to stderr; use `--json` to get the saved record on stdout:

```bash
ID=$(mnemo remember --json "fact goes here" | jq -r '.id')
echo "Stored as: $ID"
```

**Branch on the failure class**

```bash
mnemo recall --json "deploy" > out.json
case $? in
  0) ;;
  3) echo "check MNEMO_KEY" >&2 ;;
  5) echo "server unavailable, retry later" >&2 ;;
esac
```

**Pipe recall output as JSON**

`mnemo recall` with `--json` outputs structured JSON:

```bash
mnemo recall --json "user preferences" | jq '.hits[].statement'
```

Or call the HTTP API directly:

```bash
curl -s -X POST "$MNEMO_URL/recall" \
  -H "Authorization: Bearer $MNEMO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "user preferences", "limit": 10}' \
  | jq '.memories.hits[].content'
```

**Search without LLM (FTS fallback)**

`mnemo search` uses full-text search even without an API key:

```bash
mnemo search "TypeScript strict mode"
```

**Health check in CI**

```bash
if ! mnemo status --json 2>/dev/null | grep -q '"ok"'; then
  echo "Mnemosyne not healthy — aborting." >&2
  exit 1
fi
```

## License

Apache-2.0 — see [LICENSE](https://github.com/lucasmailland/mnemosyne/blob/main/LICENSE).
