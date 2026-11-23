# CLI Specification — @mnemo-ai/cli

**English** · [Español](CLI.es.md)

> **Status:** 🔶 Alpha (per root `CLAUDE.md`) — but functionally the widest command surface in the client layer as of 2026-07-31 (CLI-PARITY-1): every one of the 10 cognitive primitives, all 9 locked relation verbs, and the operational tools (pin/timeline/judge/purge/consolidate/remind) are reachable from the CLI, matching the MCP tool surface. Run `mnemo help` for the authoritative, always-current command list — this doc mirrors it but the binary's own `--help` output is the source of truth if the two ever drift.
> **Source:** [packages/cli/src/commands.ts](../../packages/cli/src/commands.ts) (command implementations) + [packages/cli/src/index.ts](../../packages/cli/src/index.ts) (dispatch). Built on `@mnemo-ai/client-ts` — no ad-hoc HTTP calls except for the handful of routes without a typed client method yet (see `docs/archive/BACKLOG.md` P34/P35).

## Binary

`mnemo` — installed via `npm install -g @mnemo-ai/cli` or `pnpm add -g @mnemo-ai/cli`

## Configuration

Priority (highest to lowest):

1. Environment variables: `MNEMO_URL`, `MNEMO_KEY`
2. Config file: `~/.mnemo/config.json`
3. Error (required fields missing)

Config file format:

```json
{
  "url": "http://localhost:3939",
  "apiKey": "mns_live_..."
}
```

Manage config:

```bash
mnemo config set url http://localhost:3939
mnemo config set apiKey mns_live_...
mnemo config get          # shows all, masks apiKey
mnemo config get url      # shows single key
```

## Setup

```bash
mnemo login               # interactive: prompts for URL + API key, writes ~/.mnemo/config.json
mnemo init                 # setup wizard: verifies connectivity, optionally registers a user, wires MCP clients
mnemo init --docker        # full local bootstrap: starts Postgres/Redis/server via Docker Compose, generates a workspace + API key
mnemo install              # installs the Mnemosyne MCP server + plugin into every detected AI coding agent
mnemo install --local      # Claude Code only: installs the plugin from the local working tree (packages/plugin/) instead of the native marketplace — development install, not git-tracked
```

## Core memory operations

```bash
mnemo recall [--json] [--limit N] <query>   # 7-stage hybrid recall (vector + ACT-R + worth)
mnemo remember <text>                        # store a fact
mnemo forget <id>                            # soft-delete (bitemporal close, not a real delete)
mnemo list [--limit N]                       # recent facts, newest first
mnemo search <query>                         # full-text search (recall's FTS fallback path)
mnemo show <factId>                          # full JSON for one fact
mnemo pin <factId>                           # protect a fact from worth decay
mnemo unpin <factId>
mnemo timeline [--limit N] [--since <iso>]   # recent fact-lifecycle events
```

## The 10 cognitive primitives

Facts are covered above (`remember`/`forget`/`list`/`show`). The other 9:

```bash
# Decisions — architectural/policy calls with rationale
mnemo decide create --kind <k> --title <t> --body <b> [--topic-key tk] [--scope-ref sr]
mnemo decide list [--status active|superseded|withdrawn] [--limit N]
mnemo decide show <id>
mnemo decide supersede <id> --by <newDecisionId>
# kind: decision|architecture|policy|process|bugfix|learning|discovery|config

# Episodes — buffered sessions with richer LLM-summarized collapse extraction
mnemo episode start [--label l] [--agent-id a]
mnemo episode collapse <id> [--hint h] [--strategy auto|explicit]

# Entities — people, orgs, projects, concepts, places
mnemo entity create --name <n> --kind <k> [--aliases a,b] [--description d]
mnemo entity list [--kind k] [--q text] [--limit N]
mnemo entity show <id>
mnemo entity update <id> [--name n] [--kind k] [--aliases a,b] [--canonical-id id|null]
mnemo entity facts <id> [--limit N]     # facts linked via mnemo_fact.entity_id
# kind: person|organization|project|concept|place|other

# Link a kind=person entity to a real platform account (mnemo_user.id).
# Self-link (your own userId) is always allowed. Linking a DIFFERENT user —
# or reassigning an entity already linked to someone else — requires
# memory:admin scope and an owner/admin role in the workspace. Unlink is
# bitemporal (closes the row, creates an unlinked successor), never an
# in-place overwrite. linkedUserId is never settable via create/update.
mnemo entity link-user <id> <userId>
mnemo entity unlink-user <id>

# Strategies — "when X, do Y" heuristics
mnemo strategy create --trigger <t> --action <a> [--context c] [--scope-ref sr]
mnemo strategy list [--status active|superseded|archived] [--limit N]
mnemo strategy show <id>
mnemo strategy update <id> [--trigger t] [--action a] [--context c] [--status s]
mnemo strategy archive <id>
mnemo strategy rate <id> <success|failure>   # Beta-Bernoulli worth recompute

# Workflows — reusable multi-step process templates
mnemo workflow create --name <n> --steps '["step 1","step 2"]' [--description d] [--scope-ref sr]
mnemo workflow list [--status s] [--scope-ref sr] [--limit N]
# --steps accepts plain strings (shorthand for {action}, order/expectedDurationMs auto-filled)
# or full {action, expectedDurationMs?, condition?, tools?} objects for control over duration/tools —
# either way the CLI builds valid WorkflowStep objects before sending; a raw string array previously
# reached the server as-is and was rejected with 400 (server requires order + expectedDurationMs).
mnemo workflow show <id>

# Skills — reusable prompt templates
mnemo skill create --name <n> --prompt <p> [--variables v1,v2] [--required-context c1,c2] [--sensitivity s]
mnemo skill list [--limit N]
mnemo skill show <id>
# sensitivity: public|internal|confidential|restricted

# Tasks — action items with lifecycle
mnemo tasks [list]
mnemo tasks create --title <t> --assigned-to <agent> [--description d] [--priority critical|high|medium|low] [--due-at iso]
mnemo tasks show <id>
mnemo tasks update <id> [--status s] [--outcome o] [--lessons-learned l]
mnemo tasks delegate <id> --to <agent>

# Events — immutable, append-only occurrences
mnemo events [list]
mnemo events create --type <t> --name <n> --description <d> --source <s> [--occurred-at iso]
mnemo events show <id>
mnemo events archive <id>    # refused: events are immutable (the server answers 409, exit 1)
mnemo events sensitivity <id> <public|internal|confidential|restricted>   # raise-only; server 422s a lowering attempt
# type: system|external|user|agent|scheduled

# Reasoning — chain-of-thought cache
mnemo reasoning create --question <q> --conclusion <c> --chain '<json array>' [--topic-key tk]
mnemo reasoning list [--limit N]
mnemo reasoning show <id>
mnemo reasoning archive <id>
mnemo reasoning resolve <query>          # check the CoT cache before re-running inference
mnemo reasoning record --question <q> --conclusion <c> --chain '<json array>' [--outcome success|fail]
mnemo reasoning feedback <id> <success|fail>
# chain item shape: {"step":1,"reasoning":"...","conclusion":"..."}
```

## Relations (9 locked verbs)

```bash
mnemo relate <sourceKind> <sourceId> <verb> <targetKind> <targetId> [--reason r] [--confidence c] [--marked-by-kind user|agent|system|llm_judge]
mnemo relate list [--judgment-status pending|judged|dismissed] [--limit N]
mnemo relate history <sourceKind> <id> [--max-depth N]   # walk the supersedes/derived_from chain from <id> — "why is this the current one, what did it replace"
# kind: fact|decision|entity|episode
# verb (locked, server 400-rejects anything else):
#   related | compatible | scoped | conflicts_with | supersedes |
#   not_conflict | derived_from | part_of | member_of
```

Hyperedges (n-ary relations, 3+ members in one co-activation cluster):

```bash
mnemo hyperedge create --members id1,id2,id3 [--label l] [--description d] [--context-query q]
mnemo hyperedge list [--member-id id] [--limit N]
mnemo hyperedge show <id>
mnemo hyperedge update <id> [--label l] [--description d] [--context-query q]
mnemo hyperedge archive <id>
```

## Prospective memory

```bash
mnemo remind create --content <c> [--condition c] [--trigger-at iso]
mnemo remind list [--status pending|triggered|dismissed|all] [--limit N]
mnemo remind dismiss <id>
```

At least one of `--condition` (semantic, evaluated on every recall) or `--trigger-at` (temporal, swept every 30s) is required.

## Conflict resolution

```bash
mnemo judge [list] [--limit N]                                          # list unresolved conflicting fact pairs
mnemo judge resolve <relationId> <supersede_a|supersede_b|keep_both|merge> [--merged-statement s]
# --merged-statement is required when the resolution is 'merge' — the CLI rejects locally (no request made)
# before the server would 400 for the same reason.
```

## Consolidation

```bash
mnemo consolidate [--mode fast|deep] [--dry-run]
```

Manual `deep` mode and `--dry-run` currently return HTTP 422 — only `fast` mode with no dry-run actually runs. The flags are accepted for forward compatibility.

## Destructive operations

```bash
mnemo purge <factId> --confirm          # hard-delete one fact. IRREVERSIBLE. Requires memory:hard_delete scope.
mnemo purge --all-closed --confirm       # hard-delete every closed (forgotten) fact in the workspace. IRREVERSIBLE.
```

Both require `--confirm` — there is no interactive confirmation prompt, the flag itself is the gate. Use only in test workspaces; purge is not GDPR erasure.

```bash
mnemo erase --user <userId> --confirm <userId>      # GDPR crypto-erasure: destroy every encryption key of a user. IRREVERSIBLE.
mnemo erase --actor <actorId> --confirm <actorId>   # same for one actor (the key:<id> ref on its facts)
```

`erase` calls `POST /admin/erasure` (scope `memory:hard_delete`): the person's or actor's
confidential and restricted memory can never be decrypted again. `--confirm` must repeat the id.

## Session status & operations

```bash
mnemo status                 # alias for `mnemo health`
mnemo health                 # readiness probe (/health/ready) + app-level detail (/health)
mnemo sessions [list]         # list every session in the workspace
mnemo sessions show <id>      # fetch one session (status, label, lastRecallAt)
mnemo info                    # server, workspace, user, tenant, stats, available workspaces
mnemo whoami                  # alias for info
mnemo doctor                  # 8 operational diagnostics: connectivity, grants, schema, migrations, embeddings, workspace_id, env config, MCP tool registration
```

## Workspace & key management

See [architecture/MULTI_TENANCY.md](../architecture/MULTI_TENANCY.md) for the full user/tenant/workspace/token model these commands operate on.

```bash
mnemo workspace list                                    # your own workspace memberships, with your role in each
mnemo workspace show <workspaceId>
mnemo workspace members <workspaceId>
mnemo workspace create --name <name> [--tenant <id>] [--slug <slug>] [--visibility private|public] [--owner <userId>]
mnemo workspace invite <workspaceId> <userId> [--role owner|admin|write|read]     # default role: read
mnemo workspace set-role <workspaceId> <userId> <owner|admin|write|read>
mnemo workspace remove <workspaceId> <userId>

mnemo tenant create --name <name> [--kind personal|organization] [--plan <plan>] [--owner-token [--workspace-name <name>]]  # --owner-token also returns a token for the new tenant (your key keeps acting in its own)
mnemo tenant show <tenantId>
mnemo tenant members <tenantId>
mnemo tenant invite <tenantId> <email> [--role owner|admin|member] [--create-if-missing]  # auto-provisions the account if it doesn't exist yet
mnemo tenant remove <tenantId> <userId>
mnemo tenant workspaces <tenantId>

mnemo user create --email <email> [--display-name <name>]

mnemo token issue <tenantId> <userId> --label <label> --workspace <homeWorkspaceId> [--scopes <s1,s2>] [--expires 90d] [--test]  # mints a uk_live_* token for ANOTHER user — requires tenant owner/admin
mnemo token list <tenantId> <userId>
mnemo token revoke <tenantId> <userId> <keyId>

mnemo keys list [--expired]
mnemo keys create --label <l> --scopes <s1,s2> [--expires 30d] [--plan free|pro] [--test] [--ip-allowlist <cidr>] [--max-sensitivity public|internal|confidential|restricted]
mnemo keys revoke <keyId>
mnemo keys show <keyId>
mnemo keys rotate <keyId> [reason]
mnemo link [--label <name>] [--force]    # writes .mnemo.json binding this repo to the active workspace
```

### Which workspace does a command run against?

A `mk_live_*`/`mns_live_*` workspace key always runs against its own one workspace — none of the below applies. A `uk_live_*` user token can target ANY workspace the user belongs to via `X-Workspace-Id`, resolved with this precedence (most to least specific):

1. Global `--workspace <id>` flag — **must precede the subcommand** (`mnemo --workspace ws_123 recall "query"`), not appear after it. Several subcommands already define their own unrelated `--workspace <id>` flag (`mnemo reset --workspace <id>` targets a workspace for a destructive admin action; `mnemo token issue ... --workspace <id>` sets a NEW token's home workspace) — putting the global flag after the subcommand would collide with those.
2. `MNEMO_WORKSPACE_ID` environment variable.
3. `.mnemo.json`'s `workspaceId` field (written by `mnemo link`).

### Language

Global `--locale <tag>` flag (`en-US` or `es-419`; any `es*` maps to `es-419`) — like `--workspace`, **it must precede the subcommand** (`mnemo --locale es-419 recall "query"`); the `--locale=es-419` form is not supported (same as `--workspace`); after the subcommand it is passed to the command untouched and does not switch the language. Without the flag the language comes from `MNEMO_LOCALE`, then `"locale"` in `~/.mnemo/config.json` (`mnemo config set locale es-419`), then `LC_ALL`, `LC_MESSAGES` and `LANG`, then `en-US`. In Spanish, prompts show `[s/N]` and also accept `s`, `sí` or `si`. `--json` output never changes. Details: `packages/cli/README.md`.

## Import / export

```bash
mnemo export | gunzip > backup.jsonl                                              # gzip JSONL to stdout
mnemo import <file.jsonl.gz> [--from mem0|zep|claude] [--conflict-resolution skip|overwrite|newest]
```

## Shell completion

```bash
mnemo completion bash    # source <(mnemo completion bash)
mnemo completion zsh     # source <(mnemo completion zsh)
mnemo completion fish    # mnemo completion fish > ~/.config/fish/completions/mnemo.fish
mnemo completion pwsh    # Invoke-Expression (mnemo completion pwsh)
```

## `mnemo help`

Prints the full, current command list — run it after upgrading, since new commands land there before this doc is necessarily updated.

## Exit codes

| Code | Meaning                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success                                                                                                                                              |
| 1    | Any error: auth failure, server unreachable, resource not found, config missing, missing required flag, missing `--confirm` on a destructive command |

## Error handling

All errors write to stderr (never stdout) and exit with code 1:

```
Error: 401 Unauthorized
Error: 404 fact_01j9abc123 does not exist in this workspace
Error: No server configured. Run: mnemo config set url http://... && mnemo config set apiKey msk_...
```

Most commands' output is either a human-readable one-liner (`✓ Pinned: fact_xyz`) or pretty-printed JSON — there is no `--format` flag; JSON output is the default for anything beyond a simple confirmation.

## Implementation notes

- Every command is a thin wrapper over a typed `@mnemo-ai/client-ts` method — no route has bespoke fetch logic unless `client-ts` genuinely has no method for it yet (`sessions` list, `/admin/embedding-migrations` for `reset`).
- Config is stored as plaintext JSON at `~/.mnemo/config.json` (mode `0600`, directory `0700`).
- API key is masked in `config get` output.
- No retry logic — a 500 from the server exits immediately with the status and message.
- `mnemo recall` requests 10 results by default (`--limit N` to override).
- Tests: `pnpm --filter @mnemo-ai/cli test` — stubs `global.fetch` and asserts on request path/method/body per command. This is a regression net for command wiring and output shape; it does not independently verify the server's actual route/schema (see `docs/architecture/API.md` for that contract).
