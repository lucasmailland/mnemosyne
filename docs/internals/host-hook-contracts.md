# Coding-agent hosts: extension points available to Mnemosyne

Research date: 2026-08-11. Primary evidence: local clones `engram` and
`claude-mem` (source-verified, cited `file:line`). Everything else is
documentation-sourced and labelled as such.

**Evidence grades used below**

- **[SRC]** — read in a working integration's source in one of the two local clones.
- **[PKG]** — read from an installed package's type definitions on this machine.
- **[DOC]** — official vendor documentation, fetched this session.
- **[UNVERIFIED]** — could not confirm; see the UNVERIFIED section.

---

## The distinction that matters

Three separate capabilities get conflated constantly. Keep them apart:

1. **An extension API exists** — you can run code on agent events. Many hosts have this.
2. **A push channel into model context exists** — your code can put text in front of the
   model without the model asking for it. Far fewer hosts have this.
3. **A reliable close signal exists** — something fires when the conversation ends, so you
   can collapse an episode. This is the scarcest of the three, and it is the one Mnemosyne
   is missing everywhere outside Claude Code.

Hosts with (1) but not (2) can only observe. Hosts with (2) but not (3) can inject but
never close. Only (1)+(2)+(3) gives us the Claude Code experience.

---

## Master table

| Host                               | Hook / event system                                                                                                                                                                     | Context injection (push)                                                                        | Session-end signal                                                                           | Rule file (always-applied)                                                                                    | MCP                                                                                              | Tier                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **Claude Code**                    | Yes — `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PreCompact` **[SRC]**                                                                   | Yes — hook stdout / `hookSpecificOutput.additionalContext` **[SRC]**                            | Yes — `Stop` **[SRC]**                                                                       | `CLAUDE.md` (global `~/.claude/`)                                                                             | Yes + `claude/channel` server push + tool-search deferral **[DOC]**                              | **Full hooks**                                          |
| **Cursor**                         | Yes — ~20 events incl. `sessionStart`, `sessionEnd`, `stop`, `preCompact`, `beforeSubmitPrompt`, `postToolUse` **[DOC]**; older subset source-verified **[SRC]**                        | Yes — `additional_context` on `sessionStart` and `postToolUse` **[DOC]**                        | **Yes — `sessionEnd` with `reason`** **[DOC]**                                               | `.cursor/rules/*.mdc` `alwaysApply: true` — **project-level only** **[SRC]**                                  | Yes                                                                                              | **Full hooks** (upgraded — see below)                   |
| **Codex CLI**                      | Yes — `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Pre/PostToolUse`, `Pre/PostCompact`, `Subagent*`, `Stop` **[DOC]**; plugin marketplace w/ `hooks.json` **[SRC]**               | Yes — `hookSpecificOutput.additionalContext`, `additionalContextLimit` **[DOC][SRC]**           | **Yes — `SessionEnd` + `Stop`** **[DOC]**                                                    | `AGENTS.md`; `model_instructions_file` in `config.toml` **[SRC]**                                             | Yes — `[mcp_servers.<id>]` in **`config.toml`**                                                  | **Full hooks** (gated: `features.hooks` off by default) |
| **Gemini CLI**                     | Yes — `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `Notification`, `PreCompress` **[DOC]** | Yes — `additionalContext` on `SessionStart` / `BeforeAgent` / `AfterTool` **[DOC]**             | **Yes — `SessionEnd`** (fire-and-forget, CLI does not wait) **[DOC]**                        | `~/.gemini/system.md`, `GEMINI.md` **[SRC]**                                                                  | Yes — `~/.gemini/settings.json` `mcpServers`, or an extension                                    | **Full hooks**                                          |
| **Qwen Code**                      | Yes — 17+ events, Gemini/Claude-shaped: `SessionStart`, `SessionEnd`, `Stop`, `Pre/PostToolUse`, `Pre/PostCompact`, `UserPromptSubmit`, `Subagent*` **[DOC]**                           | Yes — `hookSpecificOutput.additionalContext` on 5 events **[DOC]**                              | **Yes — `SessionEnd` + `Stop`** **[DOC]**                                                    | `~/.qwen/QWEN.md` (global) **[SRC]**                                                                          | Yes — `~/.qwen/settings.json` **[SRC]**                                                          | **Full hooks**                                          |
| **VS Code Copilot**                | Yes — 8 events: `SessionStart`, `UserPromptSubmit`, `Pre/PostToolUse`, `PreCompact`, `SubagentStart/Stop`, `Stop` **[DOC]**                                                             | Partial — hooks documented as able to "inject context"; per-event field not confirmed **[DOC]** | Partial — `Stop` only, **no `SessionEnd`** **[DOC]**                                         | `<User>/prompts/*.instructions.md` with `applyTo: "**"` — global **[SRC]**                                    | Yes — `servers` key in User `mcp.json` **[SRC]**                                                 | **Full hooks** (weak close)                             |
| **OpenCode**                       | Yes — typed plugin `Hooks` interface + `event` bus **[PKG]**                                                                                                                            | Yes — `experimental.chat.system.transform` rewrites the system prompt every turn **[SRC][PKG]** | Partial — `session.idle` bus event (idle ≠ end); `session.deleted` **[SRC][DOC]**            | `AGENTS.md`                                                                                                   | Yes — `mcp` key, `type:"local"` **[SRC]**                                                        | **Plugin API**                                          |
| **Amp**                            | Yes — plugin API: `session.start`, `agent.start`, `tool.call`, `tool.result`, `agent.end` **[DOC]**                                                                                     | Partial — `agent.end` can append follow-up messages; no documented system-prompt hook **[DOC]** | Partial — `agent.end` is per-turn, not per-session **[DOC]**                                 | `~/.config/amp/AGENTS.md`, `/etc/ampcode/AGENTS.md` — **global** **[DOC]**                                    | Yes                                                                                              | **Plugin API**                                          |
| **Cline**                          | Yes — `beforeRun`, `afterRun`, `beforeTool`, `afterTool`, `beforeModel`, `afterModel`, `onEvent` **[DOC]**                                                                              | [UNVERIFIED]                                                                                    | Partial — `afterRun` (per-run) **[DOC]**                                                     | `.clinerules` / `.clinerules/` — project **[DOC]**                                                            | Yes — `cline_mcp_settings.json` **[DOC]**                                                        | **Plugin API**                                          |
| **Kiro**                           | Yes — `SessionStart`, `Stop`, `Pre/PostToolUse`, `UserPromptSubmit`, `PostFileSave/Create/Delete`, `Pre/PostTaskExec` **[DOC]**                                                         | Yes — "agent prompt" hook action injects a prompt into the live conversation **[DOC]**          | **Yes — `Stop`** **[DOC]**                                                                   | `.kiro/steering/*.md` — project (global steering added in 0.5) **[SRC][DOC]**                                 | Yes — `~/.kiro/settings/mcp.json` **[SRC]**                                                      | **Full hooks**                                          |
| **Windsurf** (now Devin Desktop)   | Yes — 12 events, all `pre_*`/`post_*` around tools/prompts **[DOC]**; 5 wired in claude-mem **[SRC]**                                                                                   | **No** — hook output cannot inject **[SRC][DOC]**                                               | **No** — closest is `post_cascade_response` (per turn) **[SRC][DOC]**                        | `.windsurf/rules/*.md` — project **[SRC]**; `~/.codeium/windsurf/memories/global_rules.md` — global **[SRC]** | Yes — `~/.codeium/windsurf/mcp_config.json` **[SRC]**                                            | **Hooks, observe-only**                                 |
| **Antigravity**                    | Yes — shares Gemini CLI's `~/.gemini/settings.json` hook schema; 7 events live-verified **[SRC]**                                                                                       | Yes — `hookSpecificOutput.additionalContext` **[SRC]**                                          | **No** — claude-mem deliberately excluded SessionEnd; `PreCompress` is the closest **[SRC]** | `~/.gemini/GEMINI.md` and `~/.agents/rules/*.md` — **global** **[SRC]**                                       | Yes — `~/.gemini/config/mcp_config.json` (and `~/.gemini/antigravity/mcp_config.json`) **[SRC]** | **Full hooks**                                          |
| **Cowork**                         | Yes — Claude Code plugin `hooks/` run here **[DOC]**                                                                                                                                    | Yes (same hook contract) **[DOC]**                                                              | Yes (`Stop`) **[DOC]**                                                                       | Skills; plugin-delivered                                                                                      | Yes (cloud-reachable servers only)                                                               | **Full hooks**                                          |
| **Claude Desktop**                 | Yes, but only in the **Cowork/Code** surfaces; hooks are greyed out in the Chat tab **[DOC]**                                                                                           | Only in Cowork/Code                                                                             | Only in Cowork/Code                                                                          | Skills                                                                                                        | Yes — `.mcpb`, `managedMcpServers`, local stdio                                                  | **Full hooks (Cowork surface) / MCP only (Chat tab)**   |
| **Zed**                            | **No** — lifecycle hooks are a published proposal (Phase 2), not shipped **[DOC]**                                                                                                      | No                                                                                              | No                                                                                           | Not documented in the Agent Panel docs **[DOC]**                                                              | Yes — "context servers"                                                                          | **MCP only**                                            |
| **Continue**                       | **No** — `config.yaml` has no `hooks` key **[DOC]**                                                                                                                                     | No                                                                                              | No                                                                                           | `.continue/rules/` + inline `rules:` — project **[DOC]**                                                      | Yes — `mcpServers` **[DOC]**                                                                     | **Rule file + MCP**                                     |
| **JetBrains AI Assistant / Junie** | **No** public agent-lifecycle hook API **[DOC]**                                                                                                                                        | No (MCP pull only)                                                                              | No                                                                                           | Guidelines files                                                                                              | Yes — Settings → Tools → AI Assistant → MCP **[DOC]**                                            | **MCP only**                                            |
| **Aider**                          | **No** agent hooks (editor wrappers like aidermacs have their own) **[DOC]**                                                                                                            | No — but `read:` in `.aider.conf.yml` force-loads files every run **[DOC]**                     | No                                                                                           | `CONVENTIONS.md` via `read:`; `.aider.conf.yml` in `$HOME` **and** repo root — global available **[DOC]**     | [UNVERIFIED]                                                                                     | **Rule file only**                                      |
| **Devin**                          | No local hooks — cloud agent, REST API + webhooks **[DOC]**                                                                                                                             | Partial — "Knowledge" entries are auto-recalled server-side; write via API **[DOC]**            | No local signal; session state via API polling **[DOC]**                                     | Knowledge / Playbooks (org-level, via API) **[DOC]**                                                          | Yes (per Devin docs)                                                                             | **API integration, not a host plugin**                  |
| **Roo Code**                       | —                                                                                                                                                                                       | —                                                                                               | —                                                                                            | —                                                                                                             | —                                                                                                | **DEAD — shut down 2026-05-15** **[DOC]**               |

Bonus hosts found in the clones that are not on the brief's list and are cheap:
**Kilo Code** (OpenCode-shaped config at `~/.config/kilo/opencode.json` **[SRC]**),
**Pi** (real extension API with `session_start` / `session_shutdown` / `session_compact` /
`before_agent_start` / `tool_execution_end` **[SRC]**), **OpenClaw** (full plugin API with
`session_start` / `session_end` / `before_prompt_build` **[SRC]**), **Goose**
(`~/.config/goose/config.yaml`, MCP only **[SRC]**), **Warp** (`~/.warp/mcp.json` **[SRC]**),
**Copilot CLI** (`~/.github/copilot/mcp.json` **[SRC]**).

---

## Per-host detail

### Claude Code — full hooks

Nothing new here, but the exact contract, for reference when porting.

Hook manifest: `engram/plugin/claude-code/hooks/hooks.json:1-64` —
`SessionStart` (matchers `startup|clear` and `compact`), `UserPromptSubmit`, `SubagentStop`,
`Stop`. Mnemosyne's own is `packages/plugin/hooks/hooks.json`,
structurally identical.

Injection channel: the `SessionStart` script writes the protocol + memory context to **stdout**
and that becomes `additionalContext`
(`engram/plugin/claude-code/scripts/session-start.sh:140-181`, with the
comment `# Inject Memory Protocol + context — stdout goes to Claude as additionalContext`).

Close signal: `Stop` receives `{session_id}` on stdin and posts a session-end
(`engram/plugin/claude-code/scripts/session-stop.sh:10-21`). `async: true`
so it does not block the reply.

**Additionally, and under-used: MCP channels.** A server can declare
`capabilities.experimental['claude/channel']` and then emit
`notifications/claude/channel` with `{content, meta}`. The payload lands **in Claude's
context** as `<channel source="..." k="v">body</channel>` without the model asking
**[DOC]**. This is a _server-side_ push channel — the only one in this whole survey that is
part of an MCP server rather than a host plugin. It is currently research preview and
allowlist-gated (`--dangerously-load-development-channels` for anything not in
`claude-plugins-official`), which is the catch.

### Cursor — **no longer degraded; this is the headline finding**

Both local clones encode an outdated picture. Engram's registry still says
_"Cursor does NOT read global rule files from the filesystem"_ and ships an
"open this file and paste it into User Rules" workaround
(`engram/internal/setup/agents.go:120-134`,
`235-243`). claude-mem's `PARITY.md:129-139` lists "no SessionStart hook" and
"no direct context injection" as Cursor limitations, and its adapter's `formatOutput`
returns only `{continue}` — no injection field
(`claude-mem/src/cli/adapters/cursor.ts:54-56`).

Current Cursor docs **[DOC]** contradict that:

- **Events**: `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`,
  `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`,
  `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`,
  `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`, `afterAgentThought`,
  plus Tab hooks and `workspaceOpen`.
- **Injection**: `sessionStart` and `postToolUse` return an `additional_context` field.
  That is a genuine push channel, no rules file needed.
- **Session end**: `sessionEnd` fires with `session_id`, `reason`
  (`completed|aborted|error|window_close|user_close`), `duration_ms`, `final_status`.
  Fire-and-forget. **This is a real close signal.**
- **Config**: `~/.cursor/hooks.json` (user, global) or `<project>/.cursor/hooks.json`, plus
  Enterprise/Team layers. All layers execute; they do not override each other.
- **Caveat**: `sessionStart`/`sessionEnd` are unavailable in cloud/background agents.
- **Plugins**: Cursor also has a plugin bundle format (`.cursor-plugin/plugin.json`, or the
  open `plugin.json` "Agent Plugin" standard) that can carry rules, skills, agents, commands,
  hooks and MCP servers in one installable unit.

Legacy fallback, still useful as belt-and-braces: claude-mem writes
`.cursor/rules/claude-mem-context.mdc` with `alwaysApply: true` and rewrites it from three
places — `beforeSubmitPrompt`, the worker after a summary, and the `stop` hook
(`claude-mem/cursor-hooks/CONTEXT-INJECTION.md:26-115`). Note this is
**project-level**, i.e. writing into the user's repo, and claude-mem tells users to gitignore
it (`CONTEXT-INJECTION.md:170-173`).

One real Cursor limitation persists: hooks receive no transcript path on stdin. claude-mem
derives it from disk instead —
`~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`, where `<slug>` is the cwd
with `/` and `.` replaced by `-`
(`claude-mem/src/cli/adapters/cursor.ts:22-28`). Note the deliberate
`SAFE_SESSION_ID_RE` guard there against path traversal from a hostile session id.

### Codex CLI — full hooks, but two gates

Codex has a Claude-Code-shaped hook system **and** a plugin marketplace. Engram installs the
plugin with `codex plugin marketplace add <repo> --ref main` then `codex plugin add engram@engram`
(`engram/internal/setup/setup.go:1192-1204`), shipping
`engram/plugin/codex/hooks/hooks.json:1-62` — same four events as Claude
Code, with `${PLUGIN_ROOT}` instead of `${CLAUDE_PLUGIN_ROOT}`.

Injection is real and typed: claude-mem's Codex adapter emits
`hookSpecificOutput: {hookEventName, additionalContext}`
(`claude-mem/src/cli/adapters/codex.ts:105-137`). Its CHANGELOG documents a
strictness quirk worth copying: Codex's `SessionStart` validator **rejects a bare
`{"continue":true}`** and needs a well-formed `hookSpecificOutput` with at least an empty
`additionalContext` (`claude-mem/CHANGELOG.md:269-272`).

Docs **[DOC]** add: events are `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`,
`PostCompact`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`,
`UserPromptSubmit`, `Stop`. **`SessionEnd` exists.** `additionalContextLimit` defaults to
2500 tokens; oversized output is spilled to disk with a preview.

Two gates: hooks are behind `features.hooks` (**default off**, deprecated alias
`features.codex_hooks`), and hooks are **not available on Windows**.

Codex also has a whole-system-prompt channel that needs no hooks at all:
`model_instructions_file` and `experimental_compact_prompt_file` in `config.toml`. Engram
writes both (`engram/internal/setup/setup.go:1249-1268`). There is also
`developer_instructions` for additive injection **[DOC]**.

**Mnemosyne bug (high confidence):** `packages/cli/src/commands.ts:3923-3945` writes the MCP
entry to `~/.codex/config.json` under an `mcpServers` key. Codex reads `~/.codex/config.toml`
under `[mcp_servers.<id>]` **[DOC]**, which is also what Engram writes
(`setup.go:1361-1373`, `1270-1300`). Our Codex MCP registration is almost certainly a no-op.

### Gemini CLI — full hooks, plus a first-class extension bundle

Hook events **[DOC]**: `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeTool`,
`AfterTool`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `Notification`, `PreCompress`.
Configured under a `hooks` object in `settings.json`.

Injection **[DOC]**, per event:

- `SessionStart` → injected as the **first turn in history** (interactive), or prepended to
  the prompt (non-interactive).
- `BeforeAgent` → `appendText` appended to the prompt, **that turn only**.
- `AfterTool` → appended to the tool result.

`SessionEnd` fires at application exit or `/clear`, and the CLI does not wait for it — so it
must be a fast fire-and-forget POST, exactly like our Claude Code `Stop` script.

Engram takes a non-hook route: MCP into `~/.gemini/settings.json` plus writing the whole
protocol to `~/.gemini/system.md`
(`engram/internal/setup/setup.go:980-1001`, `1111-1122`). Note the scar
tissue at `setup.go:990-994` / `1124-1153`: Engram _used_ to set `GEMINI_SYSTEM_MD` in
`~/.gemini/.env` and had to add cleanup code, because that env var makes Gemini resolve
`system.md` relative to **cwd**, breaking every directory that is not `$HOME`. Gemini reads
`~/.gemini/system.md` by default without it. Do not re-introduce that.

Better packaging: a Gemini **extension** at `~/.gemini/extensions/<name>/` with a
`gemini-extension.json` carrying `mcpServers`, `contextFileName`, and an optional
`hooks/hooks.json`, `skills/`, `commands/` **[DOC]**. That is one directory that delivers MCP

- instructions + hooks together.

**Mnemosyne bug (high confidence):** `packages/cli/src/commands.ts:3896-3921` writes
`GEMINI.md` and `gemini-extension.json` **directly into `~/.gemini/`**, not
`~/.gemini/extensions/mnemosyne/`. And our manifest
(`packages/plugin/gemini-extension.json`) has only `name`/`description`/`version`/
`contextFileName` — **no `mcpServers`**. So the Gemini path today registers no MCP server and
the manifest is probably not loaded at all.

Business caveat: claude-mem **removed** Gemini CLI entirely in 13.10.0, because Google
deprecated the free/individual tier (cutoff 2026-06-18) in favour of Antigravity CLI
(`claude-mem/CHANGELOG.md:275-288`). Engram still ships it. The extension
point is fine; the user base may not be.

### Qwen Code — a Gemini CLI fork that kept everything

Same `settings.json` shape, `~/.qwen/` root. Engram treats it as a purely declarative
adapter: MCP into `~/.qwen/settings.json` + protocol block into `~/.qwen/QWEN.md`
(`engram/internal/setup/agents.go:91-104`, `201-211`).

Docs **[DOC]** show it is much richer than that: 17+ hook events including `SessionStart`,
`SessionEnd`, `SessionDelete`, `Stop`, `StopFailure`, `Pre/PostCompact`, `Subagent*`,
`MessageDisplay`, `TodoCreated/Completed`. `hookSpecificOutput.additionalContext` is supported
on `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `PreCompact`.
`UserPromptSubmit` wraps injected context in reserved XML tags. Project-level hooks require
trusted-folder status.

### VS Code Copilot — real hooks, weak close

Eight events **[DOC]**: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PreCompact`, `SubagentStart`, `SubagentStop`, `Stop`. **No `SessionEnd`** — `Stop` is the
closest. Loaded from `.github/hooks/*.json` (workspace, team-shareable), and also from
`.claude/settings.json` and `~/.claude/settings.json`; all locations are collected, none
overrides another. JSON in via stdin, JSON out via stdout; `continue`, `stopReason`,
`systemMessage`; exit code 2 blocks.

Note the odd but convenient fact that Copilot reads Claude Code's own settings paths — a
Claude-Code-shaped hook payload is close to portable here.

Rule file is the strongest global one in the survey: Engram writes
`<VS Code User>/prompts/engram.instructions.md` with frontmatter `applyTo: "**"`
(`engram/internal/setup/agents.go:136-148`, `166-170`), which is a
**user-level** file applying to every workspace. MCP goes to `<VS Code User>/mcp.json` under
a `servers` key with `type: "stdio"` (`agents.go:22-32`, `266-272`).

### OpenCode — the best-documented plugin API, and the one we should do first

Source of truth read directly from the installed package
`~/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts` (v1.15.3)
**[PKG]**. The `Hooks` interface (line 173) exposes:

`event` (generic bus), `config`, `tool`, `auth`, `provider`, `chat.message`, `chat.params`,
`chat.headers`, `permission.ask`, `command.execute.before`, `tool.execute.before`,
`tool.execute.after`, `shell.env`, `experimental.chat.messages.transform`,
`experimental.chat.system.transform`, `experimental.session.compacting`,
`experimental.compaction.autocontinue`, `experimental.text.complete`, `tool.definition`.

**The injection channel is `experimental.chat.system.transform`.** Signature
(`index.d.ts:264-267`): `(input: {sessionID?, model}, output: {system: string[]})`. You mutate
`output.system` and the model sees it — every single turn, surviving compaction. Engram
appends to the **last** existing entry rather than pushing a new one, because Qwen3.5 and
Mistral/Ministral chat templates reject multiple system messages
(`engram/plugin/opencode/engram.ts:401-416`, referencing their issue #23).
Copy that detail; it is not obvious.

Engram also uses the same hook to append a **time-based nudge**: if >15 min since the last
save and the session is >5 min old, append a "call mem_save now" reminder, debounced per
session by `ENGRAM_NUDGE_COOLDOWN_SECS` (default 900) (`engram.ts:418-500`).

Compaction is handled by `experimental.session.compacting`, which gets
`output.context: string[]` and an optional `output.prompt` override. Engram pushes prior-session
context **and** an instruction telling the compressor to put "FIRST ACTION REQUIRED: call
mem_session_summary" at the top of the compacted summary (`engram.ts:511-535`).

**Session end is the weak spot.** There is no `session.end`. The two projects disagree on what
is real:

- Engram subscribes to `session.created` and `session.deleted` only (`engram.ts:285-326`),
  with the `#116` fix that session data is nested under `event.properties.info`, plus
  sub-agent suppression via `parentID` or a title ending in `" subagent)"`.
- claude-mem's allowlist is `["session.idle", "session.deleted"]`
  (`claude-mem/src/integrations/opencode-plugin/index.ts:30-33`), and its
  header records that the previous code subscribed to `session.created`, `message.updated`,
  `session.compacted` and `file.edited` — **which it believed did not exist** — and therefore
  captured nothing for months (`index.ts:17-28`).
- Official docs **[DOC]** list `session.created`, `session.compacted`, `session.deleted`,
  `session.diff`, `session.error`, `session.idle`, `session.status`, `session.updated` as real.

So claude-mem's "never existed" claim is at minimum version-dependent. The lesson to take is
not the specific list — it is the **methodology**: pin the event names to a contract test
against the installed `@opencode-ai/plugin` types, so a typo or an upstream rename fails CI
instead of silently capturing nothing.

Practical close signal: `session.idle` + a debounce. Not a true end, but it is what claude-mem
uses to summarize.

Plugin install path: files in `~/.config/opencode/plugins/` (global) or `.opencode/plugins/`
(project) load automatically **[DOC]**. Engram writes `engram.ts` into the global dir and
patches the binary path into the copy at install time
(`engram/internal/setup/setup.go:525-548`).

### Amp — real plugin API, session-scoped start, turn-scoped end

**[DOC]** Plugins are TS/JS modules. Events: `session.start` (first message of a thread),
`agent.start` (prompt submitted), `tool.call` (can allow/reject/modify/synthesize),
`tool.result`, `agent.end` (turn finished; can append follow-up messages).

`agent.end` is a **turn** boundary, not a session boundary — so it is the same shape as
OpenCode's `session.idle` problem: usable as a "maybe summarize now" trigger with a debounce,
not as a definitive close.

The rule-file story is the best in the survey: `~/.config/amp/AGENTS.md`, `~/.config/AGENTS.md`,
`/etc/ampcode/AGENTS.md` — genuinely global, no writing into the user's repo. Plus project and
subtree tiers, and MCP servers can be bundled inside a skill via `mcp.json`.

### Cline — plugin API, injection unconfirmed

**[DOC]** Seven hooks: `beforeRun`/`afterRun`, `beforeTool`/`afterTool`,
`beforeModel`/`afterModel`, `onEvent`. Plugins can wrap "tools, providers, message rewriters,
automations, or hooks". `beforeModel` + "message rewriters" strongly suggests injection is
possible, but the blog post does not state it and I could not reach a normative reference —
see UNVERIFIED. Hook discovery paths also unconfirmed. Rules live in `.clinerules` or a
`.clinerules/` directory with YAML frontmatter (`paths:` glob conditional); MCP via
`cline_mcp_settings.json`, global or per-project.

### Kiro — hooks that inject prompts, not just observe

**[DOC]** Hooks are JSON files in `.kiro/hooks/` (v1 schema: `trigger`, `matcher`, `action`).
Triggers: `PostFileSave`, `PostFileCreate`, `PostFileDelete`, `PreToolUse`, `PostToolUse`,
`SessionStart`, `Stop`, `UserPromptSubmit`, `PreTaskExec`, `PostTaskExec`.

The distinguishing feature: an action can be `"command"` **or** `"agent"`, and the agent
action _"inject[s] a prompt into the current conversation, steering the agent's behavior."_
That is a first-class injection channel — arguably richer than `additionalContext`, since it
is a prompt rather than appended context.

Steering files at `.kiro/steering/*.md` are the always-applied rule surface. Engram writes
`~/.kiro/steering/engram.md` and `~/.kiro/settings/mcp.json`
(`engram/internal/setup/agents.go:105-118`, `213-226`). Kiro 0.5 added global
steering and remote MCP.

Caveat: hooks configured at `.kiro/hooks/` are **project-level**, i.e. writing into the repo.

### Windsurf / Devin Desktop — hooks that can only watch

Ownership note: `docs.windsurf.com` now 307s to `docs.devin.ai/desktop/...` (Cognition).

**[DOC]** 12 events: `pre_read_code`, `post_read_code`, `pre_write_code`, `post_write_code`,
`pre_run_command`, `post_run_command`, `pre_mcp_tool_use`, `post_mcp_tool_use`,
`pre_user_prompt`, `post_cascade_response`, `post_cascade_response_with_transcript`,
`post_setup_worktree`.

claude-mem wires 5 of them
(`claude-mem/src/services/integrations/WindsurfHooksInstaller.ts:35-41`):
`pre_user_prompt` → session-init, `post_write_code` → file-edit, and
`post_run_command`/`post_mcp_tool_use`/`post_cascade_response` → observation.

**No injection.** The Windsurf adapter's `formatOutput` returns `{continue}` and nothing else
(`claude-mem/src/cli/adapters/windsurf.ts:68-70`), and the docs describe no
return channel. Everything context-shaped goes through files instead: claude-mem writes
`<workspace>/.windsurf/rules/claude-mem-context.md`, **truncated to 6000 chars** with a
"[Truncated — use MCP search for full history]" tail
(`WindsurfHooksInstaller.ts:31`, `81-105`), and it uses a temp-file + `rename` for atomicity
(`:103-104`). Engram instead uses the global
`~/.codeium/windsurf/memories/global_rules.md`
(`engram/internal/setup/agents.go:196-199`) — that is the better path, since
it does not write into the user's repo.

**No session end.** `post_cascade_response` fires per response, and
`post_cascade_response_with_transcript` gives you a JSONL at
`~/.windsurf/transcripts/{trajectory_id}.jsonl` — which is the closest thing to a
"summarize the whole conversation" input, since the transcript is cumulative from the start.
That is the workaround: on each `post_cascade_response_with_transcript`, debounce, and
re-summarize from the full transcript.

Session id comes from `trajectory_id` (fallback `execution_id`), and payload fields live under
`tool_info` (`windsurf.ts:5-19`).

Config paths **[DOC]**: system `/etc/windsurf/hooks.json`, user
`~/.codeium/windsurf/hooks.json` (Desktop) or `~/.codeium/hooks.json` (JetBrains plugin),
workspace `.windsurf/hooks.json`. Merged, all execute, in system → user → workspace order.

### Antigravity — Gemini CLI's hook engine under a different brand

claude-mem's installer carries the most valuable comment in either repo: _"Antigravity CLI
(`agy`) shares Gemini CLI's exact `~/.gemini/` config tree — confirmed 2026-07-03 against a
live install… Same settings.json, same hook JSON schema, same GEMINI.md context file. Not a
typo/leftover."_
(`claude-mem/src/services/integrations/AntigravityCliHooksInstaller.ts:36-42`).

7 live-verified events (`:63-74`): `SessionStart`, `BeforeAgent`, `AfterAgent`, `BeforeTool`,
`AfterTool`, `Notification`, `PreCompress`. **SessionEnd is deliberately excluded** with the
note that `session-complete` has no handler and _"the worker self-completes"_ — so treat
Antigravity as having no usable close signal until proven otherwise.

Injection is confirmed: the adapter emits `hookSpecificOutput.additionalContext`
(`claude-mem/src/cli/adapters/antigravity-cli.ts:72-76`) and strips ANSI from
`systemMessage` (`:67-70`).

MCP path is genuinely ambiguous and both projects hedge. claude-mem **dual-writes** to
`~/.gemini/antigravity/mcp_config.json` and `~/.gemini/config/mcp_config.json`
(`AntigravityCliHooksInstaller.ts:44-51`, "one already populated (old path), one present but
empty"). Engram writes only `~/.gemini/config/mcp_config.json`
(`engram/internal/setup/agents.go:179-182`), which matches current Antigravity
docs **[DOC]**. Global rules: `~/.gemini/GEMINI.md` (Engram) and `~/.agents/rules/*.md`
(claude-mem, `:53-58` — note the comment that a previous version used `process.cwd()` and a
live test proved it wrong).

### Cowork / Claude Desktop — same hooks, different surfaces

**[DOC]** Cowork plugins bundle skills, slash commands, MCP connectors, sub-agents and hooks.
Support explicitly states: _"Hooks and sub-agents run only in Cowork, so they appear greyed
out in chat."_ Claude Desktop's third-party docs confirm plugins carry a `hooks/` directory
of _"hook definitions that run on agent lifecycle events"_, distributed via a git plugin
marketplace or a system `org-plugins/` directory (`/Library/Application Support/Claude/org-plugins/`
on macOS, `C:\Program Files\Claude\org-plugins\` on Windows).

Practical read: **our existing Claude Code plugin already covers Cowork and Desktop's
Cowork/Code tabs.** The Desktop _Chat_ tab and claude.ai chat get skills + MCP only. Cowork
connectors must be reachable from Anthropic's cloud IP ranges — a self-hosted Mnemosyne
server behind a firewall will not work there.

### Zed — MCP only, for now

Agent Panel docs **[DOC]** describe MCP ("context servers") and manual `@`-mentions, and no
hooks, no lifecycle events, no always-applied rule file. Extensibility is an open,
publicly-tracked proposal (issue #57890 / discussion #57943) with a three-phase plan: custom
commands → lifecycle hooks → skills, including a proposed "pre-Agent Request Hook" that would
be exactly the injection point we want. Not shipped. Zed also implements ACP (Agent Client
Protocol), which is about hosting _external_ agents in Zed, not about extending Zed's own.

### Continue — rules + MCP, no hooks

`config.yaml` top-level keys are `name`, `version`, `schema`, `models`, `context`, `rules`,
`prompts`, `docs`, `mcpServers`, `data` **[DOC]**. No `hooks`. Rules can be inline or
`uses: file://…`; workspace rules in `.continue/rules/` are auto-active. Injection is
file-only, and refreshing a rules file mid-session is not a documented reload path.

### JetBrains AI Assistant / Junie — MCP only

**[DOC]** MCP servers configured at Settings → Tools → AI Assistant → Model Context Protocol,
with a "Pass custom MCP servers" toggle for Junie. Configured MCP tools are invoked
automatically by the agent but are not listed in the `/` menu. No documented agent-lifecycle
hook API and no documented programmatic context-injection point for a third-party IDE plugin.

### Aider — rule file only

**[DOC]** `.aider.conf.yml` is discovered in `$HOME`, the git repo root, and the cwd, loaded
in that order with later files winning — so a **global** config is available, which is rare.
`read: [CONVENTIONS.md, …]` force-adds files to every run's context, which is a crude but real
"always applied" channel. Editor wrappers (aidermacs' `aidermacs-before-run-backend-hook`) are
not Aider itself.

### Devin — not a plugin host

**[DOC]** Cloud agent. The integration surface is `https://api.devin.ai/v3/organizations/*` —
sessions, Knowledge, Playbooks, secrets — plus a webhook-to-session bridge. "Knowledge" is a
persistent bank Devin recalls automatically across sessions, which is functionally a
server-side memory we would be duplicating rather than feeding. There is no local hook, no
local rule file, and no way to run our code inside a session.

### Roo Code — dead

**[DOC]** Announced 2026-04-21, shut down 2026-05-15, at ~3M installs; the team went all-in on
Roomote, a Slack-first cloud agent. claude-mem's MCP-only Roo installer
(`claude-mem/src/services/integrations/McpIntegrations.ts:124-130`,
project-level `.roo/mcp.json` + `.roo/rules/claude-mem-context.md`) is now legacy.
**Kilo Code** is the successor and reads existing `.roomodes` and `.roo/rules/` on first start.
Engram already supports Kilo declaratively via the OpenCode config shape at
`~/.config/kilo/opencode.json` + `~/.config/kilo/AGENTS.md`
(`engram/internal/setup/agents.go:149-162`, `274-293`).

---

## Ranked by effort-to-value

**1. Cursor — highest value, and we are currently shipping the worst version of it.**
Cursor is the largest install base in this list and both reference projects have stale
information about it. Today Mnemosyne gives Cursor an `mcp.json` entry and a copy of
`AGENTS.md` into `~/.cursor/` (`packages/cli/src/commands.ts:3807-3840`) — and Cursor does not
read `~/.cursor/AGENTS.md` as an always-applied rule. Cursor now has `sessionStart` with
`additional_context`, `sessionEnd` with a typed `reason`, and a **user-level**
`~/.cursor/hooks.json`. That is push + close + global config, i.e. genuine Claude-Code parity,
for one JSON file and five small scripts. This is the single biggest coverage gain available.

**2. OpenCode — the cheapest _real_ win, exactly as suspected.**
It is a single `.ts` file dropped into `~/.config/opencode/plugins/`. Engram's
`engram.ts` is 537 lines and already solves every hard part: system-prompt injection via
`experimental.chat.system.transform` (appending to the last entry, not pushing a new one),
compaction survival via `experimental.session.compacting`, sub-agent session suppression, and
passive capture on `tool.execute.after` for `Task`. Mnemosyne would be porting a known-good
design against a package whose types we can read locally and pin a contract test to. The only
compromise is the close signal: `session.idle` + debounce instead of a true end.

**3. Codex CLI — two small config fixes and one plugin.**
First, fix the `config.json` → `config.toml` bug; right now our Codex MCP registration
probably does nothing at all, which means Codex users get _zero_ Mnemosyne. Second,
`model_instructions_file` gives whole-system-prompt control **with no hooks and no plugin** —
that alone gets us protocol injection. Third, the hooks are Claude-Code-shaped, so our existing
scripts port nearly verbatim (`${CLAUDE_PLUGIN_ROOT}` → `${PLUGIN_ROOT}`), and `SessionEnd`
exists. Discount for `features.hooks` defaulting off and no Windows support.

**4. Gemini CLI + Antigravity — one bundle, two hosts.**
They share `~/.gemini/`. Ship one Gemini **extension** directory
(`~/.gemini/extensions/mnemosyne/`) carrying `mcpServers` + `contextFileName` + `hooks/hooks.json`
and you have covered both, with real `additionalContext` injection and (for Gemini) a real
`SessionEnd`. This also fixes the current broken install, which writes the manifest to the
wrong directory and omits `mcpServers` entirely. Discount for Google having deprecated Gemini
CLI's free tier — value here is mostly Antigravity.

**5. Qwen Code — nearly free once Gemini is done.**
Same settings shape, `~/.qwen/` root, and a _superset_ of the hook events including
`SessionEnd` **and** `Stop`. Engram already treats it as a pure data-table entry
(`agents.go:91-104`). If our installer is a registry rather than a switch statement, Qwen is
one table row plus a path function.

**6. VS Code Copilot — good injection, weak close, but a genuinely global rule file.**
`<VS Code User>/prompts/mnemosyne.instructions.md` with `applyTo: "**"` is a user-level
always-on instruction file that costs one `writeFileSync`. Hooks are Claude-Code-shaped and
Copilot even reads `~/.claude/settings.json`. Only `Stop`, no `SessionEnd`.

**7. Kiro — small, but the `"agent"` hook action is a genuinely better injection primitive.**
Worth doing after the big five, mainly because injecting a _prompt_ into the live conversation
is stronger than appending context. Project-level config is the cost.

**8. Amp — real plugin API, best global rule files, uncertain audience.**
`~/.config/amp/AGENTS.md` alone would get the protocol in front of every Amp session for the
cost of one file write. The plugin API is worth a second pass if Amp usage justifies it.

**9. Windsurf — currently gets _nothing_ from us; a rule file is an hour's work.**
`packages/cli/src/commands.ts` detects Windsurf (`:3084-3087`) and then falls through to the
`default:` branch printing "Manual config required" (`:3960-3961`). Writing
`~/.codeium/windsurf/mcp_config.json` + a protocol block in
`~/.codeium/windsurf/memories/global_rules.md` — both **global**, exactly as Engram does — is
the cheapest possible improvement over zero. Hooks after that, for observation only.

**Do not spend effort on:** Roo Code (dead — redirect to Kilo Code, which is a
one-table-row declarative adapter), Zed (hooks are a proposal, not a product — MCP only until
Phase 2 ships), Devin (not a plugin host at all), JetBrains (MCP only, no injection point).

---

## Hosts where push is impossible

For these, MCP pull is the whole story, and it is worth being explicit about what that costs.

| Host                                         | Why push fails                                                          | What it costs us                                                                                                                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zed**                                      | No hooks, no rule file documented, no extension→agent context path.     | The model must decide to call `memory_recall`. With Claude Code's tool-search deferral, it may not even see the tool names described well enough to want to. No auto-recall at session start, no auto-save at session end. |
| **JetBrains AI Assistant / Junie**           | MCP tools are invoked by the agent only; no lifecycle API.              | Same as Zed. Junie's own guidelines files are the only lever, and they are user-authored, not agent-managed.                                                                                                               |
| **Devin**                                    | Cloud sandbox; no local process of ours runs anywhere near the session. | We can write into Devin's own Knowledge store via its REST API, which means Mnemosyne becomes a _source_ for a competing memory rather than the memory itself. Round-tripping is impossible.                               |
| **Continue**                                 | No hooks; rules are read at load, not pushed.                           | Static rule file only. A rule file we rewrite mid-session is not guaranteed to be re-read. Effectively "recall works if the model asks".                                                                                   |
| **Aider**                                    | No agent hooks.                                                         | `read:` in a global `.aider.conf.yml` can force-load a file every run — so a _stale snapshot_ is pushable, but nothing live and nothing session-scoped.                                                                    |
| **Windsurf**                                 | Hooks exist but the output channel is `{continue}` only.                | We can observe everything and close nothing. Context lands only via a rules file that Cascade reads at its own cadence; claude-mem caps it at 6000 chars, which tells you how much context actually survives.              |
| **Claude Desktop Chat tab / claude.ai chat** | Hooks and sub-agents are Cowork-only.                                   | Skills + MCP only. Our SKILL.md protocol is the entire mechanism there.                                                                                                                                                    |

The shared cost is the same in every row: **recall becomes opt-in and close never happens.**
A memory system whose episodes are never collapsed accumulates raw turns and never produces
the summaries that make the next session cheap. If we support these hosts at all, the honest
framing is "Mnemosyne as a searchable store", not "Mnemosyne as persistent memory", and the
protocol text in the rule file / server instructions has to carry all the weight.

One partial escape hatch worth noting: **MCP `serverInfo.instructions`** is delivered to the
model on every session in every MCP client, without the model asking. It is not arbitrary
push — it is fixed text set at connect time — but it is the one universal channel that exists
in all of these hosts. Claude Code's tool-search docs explicitly call out server instructions
as the thing that makes deferred tools discoverable **[DOC]**, and Mnemosyne already populates
it (`MCP_INSTRUCTIONS` in `packages/mcp/src/index.ts`, referenced from
`packages/cli/src/commands.ts:3562`). For the pull-only tier, that field _is_ the integration,
and it deserves as much care as a hook script.

---

## `defer_loading` — the question was slightly mis-framed

The brief asks whether hosts support "server-declared `defer_loading`". They cannot, because
**`defer_loading` is not an MCP protocol field and is not declared by the server** **[DOC]**.

It is an Anthropic **API** tool-definition parameter, driven by the **client**. In Claude Code
it is called _tool search_: enabled by default, it sends MCP tool definitions with
`defer_loading` set and lets Claude fetch full schemas on demand via `tool_reference` blocks.
Controlled by `ENABLE_TOOL_SEARCH` (`true` / `false` / `auto` = load upfront if under 10% of
context, defer the overflow), requires Sonnet/Haiku/Opus 4.5+, and is force-disabled by
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` or a non-first-party `ANTHROPIC_BASE_URL`. There are
open bugs: a `defer_loading` + `cache_control` conflict, and `defer_loading` in
`.claude.json`'s `mcpServers` reportedly having no effect.

**What this means for Mnemosyne, concretely:** with tool search on (the default), our 35 MCP
tools cost almost nothing in context, but Claude only sees **tool names + our server
instructions** until it searches. So the ranking lever is not `defer_loading` — it is writing
`MCP_INSTRUCTIONS` so that Claude knows _when_ to go looking for `memory_recall`. Claude Code
truncates both tool descriptions and server instructions at **2KB each**, so the critical
sentences must be in the first 2KB.

No other host in this survey has an equivalent mechanism; they all load MCP tool schemas
upfront.

---

## Findings about Mnemosyne's own current state

Not asked for, but discovered while verifying the brief's premises. All read from
`packages/cli/src/commands.ts`.

1. **Codex MCP registration is almost certainly a no-op** (`:3923-3945`). We write
   `~/.codex/config.json` with an `mcpServers` key. Codex reads `~/.codex/config.toml` with
   `[mcp_servers.<id>]` **[DOC]**, which is what Engram writes
   (`engram/internal/setup/setup.go:1361-1373`).
2. **Gemini install is in the wrong place and registers no MCP server** (`:3896-3921`). We
   write `GEMINI.md` + `gemini-extension.json` into `~/.gemini/` rather than
   `~/.gemini/extensions/mnemosyne/`, and `packages/plugin/gemini-extension.json` has no
   `mcpServers` key.
3. **Windsurf is detected and then ignored** — `detectInstalledAgents()` includes it
   (`:3084-3087`) but the install `switch` has no `case "windsurf"`, so it hits `default:` and
   prints "Manual config required" (`:3960-3961`).
4. **Cursor gets `~/.cursor/AGENTS.md`** (`:3828-3839`), which Cursor does not read as an
   always-applied rule. The working Cursor surfaces are `.cursor/rules/*.mdc`
   (project, `alwaysApply: true`) and, now, `~/.cursor/hooks.json` + `additional_context`.
5. **The install path is a `switch` statement, not a registry.** Engram's refactor into a
   declarative `agentAdapter` table (`internal/setup/registry.go:58-71`,
   `internal/setup/agents.go:15-163`) reduced "add a host" to "append one struct with an MCP
   path, a format enum, and an instruction surface". Six of Engram's twelve hosts are pure
   data. Doing the same to `commands.ts` is the precondition for the cheap wins in tiers 4–9
   above.
6. **`safeWriteFile` exists for a real reason** (`:3455` doc comment): `~/.gemini/GEMINI.md`
   is commonly a symlink into a dotfiles repo. Any new host writer must not blindly
   `writeFileSync`. Engram hit the same class of problem and solved it with marker-block
   upserts (`registry.go:181-219`) that replace only a delimited managed block and preserve
   user content — a better default than whole-file ownership for any shared file.

---

## UNVERIFIED

Claims I could not confirm to the standard used above. Do not build on these without checking.

- **Cline** — hook discovery paths (project vs global), the exact config file name, and
  whether any hook output is injected into the model's context. Only source is a vendor blog
  post listing seven hook names; the `docs.cline.bot` hooks reference was not reachable this
  session. "Message rewriters" in their plugin taxonomy hints at injection, but that is
  inference, not evidence.
- **VS Code Copilot injection field** — the hooks reference confirms hooks can "inject
  context" and shows `hookSpecificOutput.permissionDecision` for `PreToolUse`, but does not
  name the field for `SessionStart`. Given Copilot reads `~/.claude/settings.json`, it is
  _likely_ `hookSpecificOutput.additionalContext`, but I did not see it stated.
- **Aider MCP support** — not confirmed either way. Historically absent; some 2026 sources
  imply it exists. Needs a check against `aider.chat/docs`.
- **Antigravity MCP config path** — two candidates in the wild
  (`~/.gemini/antigravity/mcp_config.json` and `~/.gemini/config/mcp_config.json`). claude-mem
  dual-writes and explicitly says the ambiguity is unresolved
  (`AntigravityCliHooksInstaller.ts:44-51`); Engram picks the second; current docs agree with
  Engram. Dual-write is the safe move until tested on a live install.
- **Antigravity `SessionEnd`** — claude-mem excluded it deliberately, but their reason
  (`'session-complete' has no handler in src/cli/handlers/index.ts`) is a statement about
  _their own_ codebase, not about Antigravity. Since Antigravity shares Gemini's schema and
  Gemini _does_ have `SessionEnd`, it may well work. Untested.
- **OpenCode `session.compacted` / `session.created` reality** — official docs list both;
  claude-mem's code comment says `session.compacted` "never existed"; Engram uses
  `session.created` in production. Version-dependent. Pin to the installed types.
- **Zed** — checked only the Agent Panel doc and the extensibility issue/discussion. I did not
  audit the Zed extension API itself (`extension.toml` / WASM API) for a slash-command or
  context-server hook that might allow indirect injection.
- **Cursor hook payload shapes** — event list and the `additional_context` capability come
  from Cursor's docs page. I did not verify the exact stdin/stdout JSON for `sessionStart` and
  `sessionEnd` against a live Cursor install, and neither local clone implements them yet.
- **JetBrains plugin SDK** — I checked the AI Assistant/Junie _user_ docs, not the IntelliJ
  Platform plugin SDK. There may be an internal extension point a JetBrains plugin could use
  to contribute context to Junie; I found no evidence of a public one.
- **Amp `session.end`** — the manual documents `session.start` and `agent.end` but I saw no
  session-level end event. Possible it exists and was not in the fetched section.
- **Claude Code `claude/channel` allowlist policy** — custom channels require
  `--dangerously-load-development-channels` during the research preview, and the approved
  allowlist is Anthropic-curated. Whether a third-party memory server like Mnemosyne could ever
  be allowlisted is unknown, and Team/Enterprise `allowedChannelPlugins` is the only
  self-service path I saw.

---

## Sources

Source-verified files (local clones):
`engram/internal/setup/registry.go`,
`engram/internal/setup/agents.go`,
`engram/internal/setup/setup.go`,
`engram/plugin/opencode/engram.ts`,
`engram/plugin/claude-code/hooks/hooks.json`,
`engram/plugin/claude-code/scripts/session-start.sh`,
`engram/plugin/claude-code/scripts/session-stop.sh`,
`engram/plugin/codex/hooks/hooks.json`,
`engram/plugin/pi/index.ts`,
`claude-mem/cursor-hooks/hooks.json`,
`claude-mem/cursor-hooks/CONTEXT-INJECTION.md`,
`claude-mem/cursor-hooks/PARITY.md`,
`claude-mem/src/cli/adapters/{cursor,codex,windsurf,antigravity-cli}.ts`,
`claude-mem/src/services/integrations/{WindsurfHooksInstaller,AntigravityCliHooksInstaller,McpIntegrations}.ts`,
`claude-mem/src/integrations/opencode-plugin/index.ts`,
`claude-mem/openclaw/src/index.ts`,
`claude-mem/CHANGELOG.md`,
`packages/cli/src/commands.ts`,
`packages/plugin/hooks/hooks.json`,
`packages/plugin/gemini-extension.json`.

Package-verified: `~/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts` (v1.15.3).

Documentation:
[Cursor Hooks](https://cursor.com/docs/hooks) ·
[Cursor Plugins](https://cursor.com/docs/reference/plugins) ·
[Cascade Hooks (Devin Desktop)](https://docs.devin.ai/desktop/cascade/hooks) ·
[Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference) ·
[Gemini CLI hooks reference](https://geminicli.com/docs/hooks/reference/) ·
[Gemini CLI extensions reference](https://geminicli.com/docs/extensions/reference/) ·
[Qwen Code hooks](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md) ·
[VS Code Copilot agent hooks](https://github.com/microsoft/vscode-copilot-chat/blob/main/assets/prompts/skills/agent-customization/references/hooks.md) ·
[OpenCode plugins](https://opencode.ai/docs/plugins/) ·
[Amp manual](https://ampcode.com/manual) ·
[Cline plugins and hooks](https://cline.bot/blog/extend-cline-with-plugins-and-hooks) ·
[Kiro hooks](https://kiro.dev/docs/hooks/) ·
[Kiro steering](https://kiro.dev/docs/steering/) ·
[Zed Agent Panel](https://zed.dev/docs/ai/agent-panel) ·
[Zed agent extensibility proposal](https://github.com/zed-industries/zed/discussions/57943) ·
[Continue config.yaml reference](https://docs.continue.dev/reference) ·
[JetBrains AI Assistant MCP](https://www.jetbrains.com/help/ai-assistant/mcp.html) ·
[Aider YAML config](https://aider.chat/docs/config/aider_conf.html) ·
[Devin API overview](https://docs.devin.ai/api-reference/overview) ·
[Devin Knowledge](https://docs.devin.ai/product-guides/knowledge) ·
[Roo → Kilo migration](https://kilo.ai/articles/roo-to-kilo-migration-guide) ·
[Claude Code MCP](https://code.claude.com/docs/en/mcp) ·
[Claude Code channels reference](https://code.claude.com/docs/en/channels-reference) ·
[Claude Desktop extensions (3P)](https://claude.com/docs/third-party/claude-desktop/extensions) ·
[Use plugins in Claude](https://support.claude.com/en/articles/13837440-use-plugins-in-claude) ·
[Antigravity MCP docs](https://antigravity.google/docs/mcp) ·
[Claude Code defer_loading issue](https://github.com/anthropics/claude-code/issues/26844)
