/**
 * English strings (the source dictionary). Values are the exact bytes the CLI
 * has always printed: padding stays in code and the 228-line help is ONE value
 * with `{version}`. `es.ts` must have the same keys (typecheck enforces it).
 */
export const en = {
  help: {
    text: `
mnemo — Mnemosyne CLI v{version}

USAGE
  mnemo <command> [args]

GLOBAL OPTIONS
  --locale <tag>              Language for messages: en-US or es-419 (also MNEMO_LOCALE, config locale, LANG)

COMMANDS
  recall [--json] [--limit N] <query>
                              Search memory (default top 10 hits)
  remember [--json] <text>    Store a new memory (--json prints the saved record)
  forget <id>                 Delete a memory by ID
  version                     Print CLI version
  status [--json]             Show server health
  health [--json]             Show 3-tier health probe (/health/ready + /health)
  sessions [list]             List sessions
  sessions show <id>          Show a session (includes lastRecallAt)
  episode start [--label l] [--agent-id a]
                              Begin an episode (buffered session, richer collapse extraction)
  episode collapse <id> [--hint h] [--strategy auto|explicit]
                              Collapse an episode into durable knowledge units
  tasks [list]                List tasks
  tasks create --title <t> --assigned-to <agent> [--description d] [--priority p] [--due-at iso]
                              Create a task
  tasks show <id>             Show a task
  tasks update <id> [--status s] [--outcome o] [--lessons-learned l]
                              Update task status/outcome
  tasks delegate <id> --to <agent>
                              Delegate a task to another agent
  events [list]                List events
  events create --type <t> --name <n> --description <d> --source <s> [--occurred-at iso]
                              Record an immutable event (type: system|external|user|agent|scheduled)
  events show <id>            Show an event
  events archive <id>         Refused: events are immutable, so the server answers 409 and this exits 1
  events sensitivity <id> <public|internal|confidential|restricted>
                              Raise an event's sensitivity tier (raise-only — server 422s a lowering attempt)
  decide create --kind <k> --title <t> --body <b> [--topic-key tk] [--scope-ref sr]
                              Record an architectural/policy decision (kind: decision|architecture|policy|process|bugfix|learning|discovery|config)
  decide list [--status s] [--limit N]
                              List decisions
  decide show <id>            Show a decision
  decide supersede <id> --by <newId>
                              Mark a decision superseded by another
  entity create --name <n> --kind <k> [--aliases a,b] [--description d]
                              Upsert an entity (kind: person|organization|project|concept|place|other)
  entity list [--kind k] [--q text] [--limit N]
                              List entities
  entity show <id>            Show an entity
  entity update <id> [--name n] [--kind k] [--aliases a,b] [--canonical-id id|null]
                              Patch an entity (canonical-id merges it into another entity)
  entity facts <id> [--limit N]
                              List facts linked to an entity
  entity link-user <id> <userId>
                              Link a kind=person entity to a platform account. Self-link always
                              allowed; a different user requires memory:admin + owner/admin role.
  entity unlink-user <id>     Unlink a kind=person entity from its platform account (bitemporal)
  relate <sourceKind> <sourceId> <verb> <targetKind> <targetId> [--reason r] [--confidence c]
                              Create a relation. kind: fact|decision|entity|episode.
                              verb (9 locked): related|compatible|scoped|conflicts_with|supersedes|not_conflict|derived_from|part_of|member_of
  relate list [--judgment-status pending|judged|dismissed] [--limit N]
                              List relations
  relate history <sourceKind> <id> [--max-depth N]
                              Walk the supersedes/derived_from chain from <id> (why is this the current one, what did it replace)
  strategy create --trigger <t> --action <a> [--context c] [--scope-ref sr]
                              Record a "when X, do Y" heuristic
  strategy list [--status s] [--limit N]
                              List strategies
  strategy show <id>          Show a strategy
  strategy update <id> [--trigger t] [--action a] [--context c] [--status s]
                              Patch a strategy
  strategy archive <id>       Archive a strategy
  strategy rate <id> <success|failure>
                              Record a strategy execution outcome
  workflow create --name <n> --steps '<json array>' [--description d] [--scope-ref sr]
                              Save a reusable multi-step process template. --steps: array of
                              plain strings (shorthand for {action}) or {action, expectedDurationMs?,
                              condition?, tools?} objects for full control.
  workflow list [--status s] [--scope-ref sr] [--limit N]
                              List workflows
  workflow show <id>          Show a workflow
  skill create --name <n> --prompt <p> [--variables v1,v2] [--required-context c1,c2] [--sensitivity s]
                              Record a reusable prompt template
  skill list [--limit N]      List skills
  skill show <id>             Show a skill
  reasoning create --question <q> --conclusion <c> --chain '<json array>' [--topic-key tk]
                              Store a chain-of-thought record (chain item: {"step":1,"reasoning":"..."})
  reasoning list [--limit N]  List reasoning chains
  reasoning show <id>         Show a reasoning chain
  reasoning archive <id>      Archive a reasoning chain
  reasoning resolve <query>   Check the CoT cache before re-running inference
  reasoning record --question <q> --conclusion <c> --chain '<json array>' [--outcome success|fail]
                              Record a completed reasoning chain into the CoT cache
  reasoning feedback <id> <success|fail>
                              Submit outcome feedback for a cached reasoning chain
  hyperedge create --members id1,id2,id3 [--label l] [--description d] [--context-query q]
                              Link 3+ facts in a single co-activation cluster
  hyperedge list [--member-id id] [--limit N]
                              List hyperedges
  hyperedge show <id>         Show a hyperedge
  hyperedge update <id> [--label l] [--description d] [--context-query q]
                              Patch a hyperedge
  hyperedge archive <id>      Archive a hyperedge
  pin <factId>                Pin a fact to prevent worth decay
  unpin <factId>               Unpin a fact
  timeline [--limit N] [--since iso]
                              Recent fact-lifecycle events (created/pinned/updated/closed)
  judge [list] [--limit N]    List unresolved conflicting fact pairs
  judge resolve <relationId> <supersede_a|supersede_b|keep_both|merge> [--merged-statement s]
                              Resolve a conflict between two facts
  purge <factId> --confirm    Hard-delete a fact. Irreversible. Requires memory:hard_delete scope.
  purge --all-closed --confirm
                              Hard-delete all closed (forgotten) facts in the workspace. Irreversible.
  erase --user <userId> --confirm <userId>
  erase --actor <actorId> --confirm <actorId>
                              GDPR crypto-erasure: destroy the encryption keys of a user (every key) or an actor,
                              so their confidential memory can never be read again. Irreversible. Requires memory:hard_delete scope.
  consolidate [--mode fast|deep] [--dry-run]
                              Trigger memory consolidation (deep mode and --dry-run currently return 422)
  remind create --content <c> [--condition c] [--trigger-at iso]
                              Set a future trigger (at least one of --condition/--trigger-at required)
  remind list [--status pending|triggered|dismissed|all] [--limit N]
                              List reminders
  remind dismiss <id>         Dismiss a reminder
  list [--limit N]            List recent facts (default 20, sorted by createdAt desc)
  search <query>              Full-text search without Claude (uses recall pipeline FTS fallback)
  show <factId>               Show all fields of a fact as pretty-printed JSON
  export                      Download workspace memory as gzip JSONL to stdout (pipe to gunzip)
  import <file> [--from mem0|zep|claude] [--conflict-resolution skip|overwrite|newest]
                              Upload a JSONL export file (or vendor JSON array) to this workspace
  login                       Interactive login — saves URL + API key to ~/.mnemo/config.json
  install [--local]           Install Mnemosyne into all detected AI coding agents (Claude Code, Cursor, OpenCode, Gemini CLI, Codex)
                              --local: Claude Code only — install the plugin from the local working tree instead of the native marketplace (dev install)
  init [--docker]             Setup wizard — configure URL, API key, and MCP clients; or boot a full Docker stack
  info                        Show full session context: server, workspace, user, tenant, stats, available workspaces
  whoami                      Alias for info
  doctor [--json]             Run server-side diagnostics (connectivity, RLS, grants, embeddings)
  harness <cmd>               Inspect and recover the local capture queue (queue, retry, discard, doctor, probe)
  workspace list              List workspaces the current user belongs to
  workspace members <workspaceId>
                              List members of a workspace
  keys list [--expired]       List all API keys for the workspace (--expired: show only expired keys)
  keys create --label <l> --scopes <s1,s2> [--expires 30d] [--plan free|pro] [--test] [--ip-allowlist <cidr>] [--max-sensitivity public|internal|confidential|restricted]
                              Create a new scoped API key (mk_live_ or mk_test_)
  keys revoke <keyId>         Revoke a key immediately
  keys show <keyId>           Show full metadata for a single key (no secret)
  keys rotate <keyId> [reason]
                              Rotate a key — prints new key once with 7-day grace window
  keys scoped create --scopes <s1,s2> [--type live|sess|admin] [--expires 8h] [--ip-allowlist <cidr>] [--max-sensitivity <tier>]
                              Issue a scoped-scheme key (verified with MNEMO_SCOPED_AUTH=1); an admin key also prints its TOTP secret once
  keys scoped rotate <id> [reason]
                              Rotate a scoped-scheme key (7-day grace window)
  keys scoped revoke <id>     Revoke a scoped-scheme key immediately
  policy list                 List the RBAC policies of the workspace's agents
  policy get <agentId>        Show the RBAC policy of an agent (its API key id)
  policy set <agentId> --file <policy.json>
                              Create or replace an agent's RBAC policy (requires memory:admin)
  policy delete <agentId>     Delete an agent's RBAC policy
  link [--label <name>] [--force]   Link this repo to the active workspace (writes .mnemo.json)
  config set <key> <value>    Set a config value (keys: url, apiKey, uiMode, recallTimeoutMs, locale)
  config get [key]            Get config value(s)
  completion <shell>          Output shell completion script (bash/zsh/fish/pwsh)
  help                        Show this help

OUTPUT
  stdout carries only the command's result (use --json for machine-readable output);
  banners, progress and errors go to stderr.

EXIT CODES
  0  success
  1  generic failure (fallback)
  2  usage error (unknown command or flag, missing or invalid argument)
     also: mnemo export when the export is waiting for a second approver
  3  authentication or authorization (no server/key configured, HTTP 401, 403)
  4  not found (HTTP 404)
  5  transient failure worth retrying (network, timeout, HTTP 408, 429, 5xx)

CONFIG
  Stored in ~/.mnemo/config.json
  Override with env vars: MNEMO_URL, MNEMO_KEY

EXAMPLES
  mnemo login
  mnemo config set url http://localhost:3939
  mnemo config set apiKey msk_yourkey
  mnemo config set recallTimeoutMs 3000   # budget for the hook's auto-recall
  mnemo info
  mnemo whoami
  mnemo doctor
  mnemo workspace list
  mnemo workspace members 00000000-0000-0000-0000-000000000001
  mnemo keys list
  mnemo keys list --expired
  mnemo keys create --label "CI agent" --scopes memory:read,memory:write --expires 90d
  mnemo keys create --label "test key" --scopes memory:read --test
  mnemo keys create --label "read-only agent" --scopes memory:read --max-sensitivity internal
  mnemo keys revoke mk_abc123def456
  mnemo keys show mk_abc123def456
  mnemo keys rotate mk_abc123def456
  mnemo keys rotate mk_abc123def456 "scheduled rotation"
  mnemo policy set 6f1c2d3e-0000-4000-8000-000000000001 --file acme-agent-policy.json
  mnemo status
  mnemo health
  mnemo sessions
  mnemo sessions show ses_abc123
  mnemo episode start --label "auth refactor"
  mnemo episode collapse ses_abc123 --hint "focus on architecture decisions"
  mnemo tasks
  mnemo tasks create --title "Migrate fact table" --assigned-to agent_db_01 --priority high
  mnemo tasks delegate task_001 --to agent_specialist_02
  mnemo events
  mnemo events create --type system --name deploy.success --description "v3.1.0 deployed" --source ci
  mnemo events sensitivity evt_abc123 confidential
  mnemo decide create --kind architecture --title "Postgres over MongoDB" --body "ACID guarantees"
  mnemo entity create --name PostgreSQL --kind project
  mnemo entity facts ent_pg_001
  mnemo relate fact fact_xyz part_of entity ent_pg_001
  mnemo relate list --judgment-status pending
  mnemo relate history decision dec_pg_over_mongo
  mnemo strategy create --trigger "RLS fails" --action "check withMnemoTx first"
  mnemo workflow create --name "Cut a release" --steps '["bump version","tag","publish"]'
  mnemo skill create --name write-migration --prompt "Write a numbered SQL migration file"
  mnemo reasoning resolve "how to paginate with concurrent writes?"
  mnemo hyperedge create --members fact_1,fact_2,decision_1 --label "auth redesign"
  mnemo pin fact_xyz789
  mnemo unpin fact_xyz789
  mnemo timeline --limit 50
  mnemo judge
  mnemo judge resolve rel_abc keep_both
  mnemo purge fact_xyz789 --confirm
  mnemo purge --all-closed --confirm
  mnemo erase --actor key:mk_0123456789abcdef --confirm key:mk_0123456789abcdef
  mnemo consolidate
  mnemo remind create --content "check migration status" --trigger-at 2026-08-01T00:00:00Z
  mnemo remind list
  mnemo list
  mnemo list --limit 50
  mnemo search "TypeScript generics"
  mnemo show 01j9abc123def456
  mnemo export | gunzip > backup.jsonl
  mnemo remember "TypeScript generics allow type-safe reuse"
  mnemo recall "generics in TypeScript"
  mnemo recall --json "generics" | jq '.hits[].id'
  mnemo recall --limit 25 "machine learning"
  mnemo forget 01j9abc123def456
  mnemo version
`,
  },
  config: {
    noServer:
      "Error: No server configured. Run: mnemo config set url http://... && mnemo config set apiKey msk_...",
    setUsage: "Error: Usage: mnemo config set <key> <value>",
    setUnknownKey:
      "Error: Unknown config key '{key}'. Valid keys: url, apiKey, uiMode, recallTimeoutMs, locale",
    getUnknownKey: "Error: Unknown config key '{key}'. Valid keys: url, apiKey, uiMode, locale",
    invalidUiMode: "Error: Invalid uiMode '{value}'. Valid values: delight, verbose, quiet",
    invalidRecallTimeout:
      "Error: Invalid recallTimeoutMs '{value}'. Expected a positive integer in milliseconds (e.g. 3000).",
    invalidLocale: "Error: Invalid locale '{value}'. Valid values: {valid}",
    unknownSubcommand: "Error: Unknown config subcommand '{sub}'. Use: config set | config get",
    setDone: "Set {key} = {value}",
  },
  main: {
    invalidLocaleFlag: "Error: Invalid --locale '{value}'. Valid values: {valid}",
    unknownCommand: "Error: Unknown command '{cmd}'. Run mnemo help.",
    checkingStatus: "Checking status",
    workspaceMismatch:
      'Warning: this repo expects workspace "{expected}", but the active key resolves to "{actual}".',
  },
  memory: {
    flagMustBeNumber: "Error: {name} must be a number",
    limitInvalid: "Error: {flag} must be a positive integer",
    noResults: "No results found.",
    table: {
      id: "id",
      score: "score",
      statement: "statement",
    },
    empty: {
      sessions: "No sessions found.",
      decisions: "No decisions found.",
      entities: "No entities found.",
      facts: "No facts found.",
      events: "No events found.",
    },
    recall: {
      usage: "Error: Usage: mnemo recall [--json] [--limit N] <query>",
      action: 'Recalling memories for "{query}"',
    },
    remember: {
      sessionIdRequired: "Error: --session-id requires a value",
      unknownFlag: "Error: Unknown flag {arg}",
      usage: "Error: Usage: mnemo remember <text>",
      saved: "Memory saved",
    },
    forget: {
      usage: "Error: Usage: mnemo forget <id>",
      done: "Forgotten",
    },
    facts: {
      listing: "Listing facts",
    },
    search: {
      usage: "Error: Usage: mnemo search <query>",
      action: 'Searching for "{query}"',
    },
    show: {
      usage: "Error: Usage: mnemo show <factId>",
      fetching: "Fetching fact",
    },
    sessions: {
      listing: "Listing sessions",
      showUsage: "Usage: mnemo sessions show <id>",
      fetching: "Fetching session",
    },
    decide: {
      createUsage:
        "Usage: mnemo decide create --kind <k> --title <t> --body <b> [--topic-key <tk>] [--scope-ref <sr>]",
      recorded: "Decision recorded",
      listing: "Listing decisions",
      showUsage: "Usage: mnemo decide show <id>",
      fetching: "Fetching decision",
      supersedeUsage: "Usage: mnemo decide supersede <id> --by <newDecisionId>",
      superseded: "Decision superseded by {id}",
      unknownSub:
        "Unknown decide subcommand '{sub}'. Use: create, list, show <id>, supersede <id> --by <id>",
    },
    entity: {
      createUsage:
        "Usage: mnemo entity create --name <n> --kind <k> [--aliases a,b] [--description d]",
      created: "Entity created",
      listing: "Listing entities",
      showUsage: "Usage: mnemo entity show <id>",
      fetching: "Fetching entity",
      updateUsage:
        "Usage: mnemo entity update <id> [--name n] [--kind k] [--aliases a,b] [--canonical-id id|null]",
      updated: "Entity updated",
      factsUsage: "Usage: mnemo entity facts <id> [--limit N]",
      linkUserUsage: "Usage: mnemo entity link-user <entityId> <userId>",
      linkUserNote:
        "  Self-link (your own userId) is always allowed. Linking a different user — or\n  reassigning an entity already linked to someone else — requires memory:admin\n  scope and an owner/admin role in the workspace.",
      linked: "Entity linked to user",
      unlinkUsage: "Usage: mnemo entity unlink-user <entityId>",
      unlinked: "Entity unlinked from user",
      unknownSub:
        "Unknown entity subcommand '{sub}'. Use: create, list, show <id>, update <id>, facts <id>, link-user <id> <userId>, unlink-user <id>",
    },
    episode: {
      started: "Episode started",
      collapseUsage: "Usage: mnemo episode collapse <id> [--hint h] [--strategy auto|explicit]",
      skipped: "Episode skipped",
      skippedWithReason: "Episode skipped: {reason}",
      collapseFailed: "Episode collapse failed",
      collapsePending: "Episode collapse pending",
      collapsed: "Episode collapsed",
      unknownSub: "Unknown episode subcommand '{sub}'. Use: start, collapse <id>",
    },
    pin: {
      usage: "Usage: mnemo pin <factId>",
      done: "Fact pinned",
      unpinUsage: "Usage: mnemo unpin <factId>",
      unpinDone: "Fact unpinned",
    },
    timeline: {
      loading: "Loading timeline",
    },
  },
  health: {
    readiness: "Readiness:",
    detail: "Detail:",
    checkingHealth: "Checking health",
  },
  export: {
    error: "Error: {status} {statusText}\n{text}",
    approvalRequired:
      'Export requires approval (dual control — you cannot approve your own request).\nApproval request id: {id}\n{expires}Ask another admin to approve it: POST {url}/approvals/{rawId}/resolve {"status":"approved"}\nThen re-run: mnemo export --approval-request-id {rawId}',
    expires: "Expires: {expiresAt}\n",
  },
  import: {
    usageMnemoImportFile:
      "Usage: mnemo import <file.jsonl.gz> [--from mem0|zep|claude] [--conflict-resolution skip|overwrite|newest]",
    error: "Error: {status}",
    readError: "Error reading file: {message}",
  },
  reset: {
    errorWorkspaceResetIs:
      "Error: Workspace reset is blocked in production environment (NODE_ENV=production).",
    errorResetRequiresExplicit:
      "Error: Reset requires explicit confirmation. Pass --confirm to proceed.",
    exampleMnemoResetWorkspace: "Example: mnemo reset --workspace <workspace-id> --confirm",
    usageMnemoResetWorkspace: "Usage: mnemo reset --workspace <workspace-id> --confirm",
    safeResetCheckCompleted: "Safe reset check completed for workspace {workspaceId}",
  },
  login: {
    serverUrlHttpLocalhost: "Server URL [http://localhost:3939]: ",
    apiKeyMskOr: "API key (msk_... or mk_live_...): ",
    errorApiKeyIs: "Error: API key is required. Pass --key <API_KEY> or enter it interactively.",
    loggedInConfigSaved: "Logged in. Config saved to ~/.mnemo/config.json",
  },
  printManualMcpSnippet: {
    addThisToYour: "  Add this to your Claude Desktop mcpServers config:",
  },
  initDocker: {
    mnemosyneDockerBootstrap: "\nMnemosyne — Docker bootstrap\n",
    dockerDaemonIsNot: "Docker daemon is not running. Start Docker Desktop and try again.",
    installHttpsDocsDocker: "Install: https://docs.docker.com/get-docker/",
    dockerComposeNotFound:
      "Docker Compose not found. Install Docker Desktop: https://docs.docker.com/get-docker/",
    dockerDockerComposeYml: "docker/docker-compose.yml not found.",
    mnemoInitDockerRequires: "mnemo init --docker requires a Mnemosyne monorepo clone.",
    forCloudSetupMnemo: "For cloud setup: mnemo init (without --docker)",
    foundComposeFile: "Found compose file: {composePath}",
    portRedisIsIn: "Port 6379 (Redis) is in use. Use 6380, or enter a custom port: ",
    portPostgresIsIn: "Port 5432 (Postgres) is in use. Use 5433, or enter a custom port: ",
    portServerIsIn: "Port 3939 (Server) is in use. Use 3940, or enter a custom port: ",
    mnemoLlmApiKey: "MNEMO_LLM_API_KEY (press Enter to skip — semantic recall will be disabled): ",
    warningNoLlmKey: "  Warning: No LLM key set. memory_recall and memory_search will return 501.",
    writtenDockerEnv: "Written docker/.env",
    startingPostgresAndRedis: "\nStarting Postgres and Redis...",
    failedToStartInfra: "Failed to start infra",
    waitingForPostgresAnd: "Waiting for Postgres and Redis to be healthy... ",
    x: "x",
    postgresDidNotBecome: "Postgres did not become healthy in 90s.",
    checkPostgresLogs: "Check logs: docker compose -f {composePath} logs postgres",
    ready: "ready",
    runningMigrations: "\nRunning migrations...",
    migrationsFailed: "Migrations failed",
    startingServer: "\nStarting server...",
    failedToStartServer: "Failed to start server",
    waitingForServerTo: "Waiting for server to be healthy (up to 90s)... ",
    serverDidNotBecome: "Server did not become healthy in 90s.",
    checkServerLogs: "Check logs: docker compose -f {composePath} logs server",
    healthy: "healthy",
    keyGenerationFailedOutput: "Key generation failed. Output:",
    stderr: "Stderr:",
    apiKeyGenerated: "API key generated",
    configWrittenToMnemo: "Config written to ~/.mnemo/config.json",
    mcpServerRegisteredIn: "MCP server registered in Claude Code",
    warningContainsInvalidJson: "  Warning: {desktopPath} contains invalid JSON — skipping.",
    fixTheFileManually: "  Fix the file manually, then re-run mnemo init.",
    claudeDesktopConfigUpdated: "Claude Desktop config updated at {desktopPath}",
    windowsNotSupportedYet: "  Windows not supported yet. Add manually:",
    pullingNomicEmbedText: "Pulling nomic-embed-text (Ollama, ~274MB, local embeddings)... ",
    ollamaNotHealthySkipping: "  Ollama not healthy — skipping nomic-embed-text pull",
    toPullManuallyDocker:
      "  To pull manually: docker compose exec ollama ollama pull nomic-embed-text",
    mnemosyneInitializedSuccessfully: "\nMnemosyne initialized successfully!",
    server: "  Server:    {serverUrl}",
    apiKey: "  API key:   {key}",
    copyTheKeyNow: "  (Copy the key now — it will not be shown again)",
    restartClaudeCodeTo: "\n  Restart Claude Code to activate the MCP server.",
    mnemoWorkspacesJsonUpdated: "  -> ~/.mnemo/workspaces.json updated",
    workspaceMappingSavedFor: "Workspace mapping saved for project",
    pullDone: "done",
    pullSkipped: "skipped (run: docker compose exec ollama ollama pull nomic-embed-text)",
  },
  init: {
    serverUrlHttpLocalhost: "Server URL [http://localhost:3939]: ",
    apiKeyMnsLive: "API key (mns_live_..., mk_live_..., or uk_live_...): ",
    invalidFormatExpectedMns:
      "  Invalid format. Expected: mns_live_<20+>, mk_live_<20+>, or uk_live_<20+>",
    checkingServerConnectivity: "Checking server connectivity... ",
    ok: "ok",
    failed: "failed",
    startTheServerFirst: "Start the server first, then run mnemo init again.",
    registerAUserProfile: "Register a user profile on this server? {yn}: ",
    email: "Email: ",
    creatingUser: "Creating user... ",
    userId: "  User ID:   {userId}",
    tenantId: "  Tenant ID: {tenantId}",
    userAlreadyExists: "user already exists",
    configWrittenToMnemo: "Config written to ~/.mnemo/config.json",
    configureClaudeCodeCli: "Configure Claude Code CLI? {yn}: ",
    mcpServerRegisteredIn: "MCP server registered in Claude Code",
    addTheMcpServer: "  Add the MCP server manually in Claude Code settings.",
    configureClaudeDesktopY: "Configure Claude Desktop? {yn}: ",
    windowsNotSupportedYet: "  Windows not supported yet. Add manually:",
    warningContainsInvalidJson:
      "  Warning: {desktopPath} contains invalid JSON — skipping to avoid data loss.",
    fixTheFileManually: "  Fix the file manually, then re-run mnemo init.",
    claudeDesktopConfigUpdated: "Claude Desktop config updated at {desktopPath}",
    mnemosyneInitializedSuccessfully: "\nMnemosyne initialized successfully!",
    configMnemoConfigJson: "  Config:         ~/.mnemo/config.json",
    server: "  Server:         {url}",
    userId2: "  User ID:        {userId}",
    tenantId2: "  Tenant ID:      {tenantId}",
    restartClaudeCodeClaude: "  Restart Claude Code / Claude Desktop to activate the MCP server.",
    saveWorkspaceMappingY: "Save workspace mapping? {yn}: ",
    runMemoryDoctorAfter: "  Run memory_doctor after setup to verify the workspace ID is correct.",
    workspaceMappingSavedFor: "Workspace mapping saved for project",
    personalWorkspaceIdSaved: "Personal workspace ID saved",
    cannotReach: "Cannot reach {url}/health/live: {message}",
    okEmail: "ok ({email})",
    skippedStatus: "skipped ({status}: {body})",
    skippedError: "skipped ({message})",
    couldNotWrite: "  Warning: could not write {desktopPath}: {message}",
    summaryClaudeCode: "  Claude Code:    {state}",
    summaryClaudeDesktop: "  Claude Desktop: {state}",
  },
  link: {
    error: "Error: {status} {message}",
    errorMessage: "Error: {message}",
    errorCouldNotResolve: "Error: could not resolve a workspaceId for the active API key.",
    written: "  -> {configPath} written",
    linkedToWorkspace: "Linked {cwd} to workspace {workspaceId}",
    alreadyExists:
      "Error: {configPath} already exists (workspaceId: {workspaceId}{label}). Pass --force to overwrite.",
    labelSuffix: ", label: {label}",
  },
  workspaceList: {
    noWorkspacesFound: "No workspaces found.",
    listingWorkspaces: "Listing workspaces",
  },
  workspaceShow: {
    usageMnemoWorkspaceShow: "Usage: mnemo workspace show <workspaceId>",
    id: "ID:         {id}",
    name: "Name:       {name}",
    tenant: "Tenant:     {tenantId}",
    visibility: "Visibility: {visibility}",
    fetchingWorkspace: "Fetching workspace",
    slug: "Slug:       {slug}",
    created: "Created:    {createdAt}",
  },
  workspaceMembers: {
    usageMnemoWorkspaceMembers: "Usage: mnemo workspace members <workspaceId>",
    noMembersFound: "No members found.",
    listingWorkspaceMembers: "Listing workspace members",
  },
  workspaceCreate: {
    usageMnemoWorkspaceCreate:
      "Usage: mnemo workspace create --name <name> [--tenant <tenantId>] [--slug <slug>] [--visibility private|public]",
    errorTenantWasNot:
      "Error: --tenant was not provided and the current key/token has no tenant binding.",
    workspaceCreated: "Workspace created",
    tenant: "{id} ({name}, tenant {tenantId})",
  },
  workspaceInvite: {
    usageMnemoWorkspaceInvite:
      "Usage: mnemo workspace invite <workspaceId> <userId> [--role owner|admin|write|read]",
    added: "{userId} added to workspace {workspaceId}{asRole}",
    asRole: " as {role}",
  },
  workspaceSetRole: {
    usageMnemoWorkspaceSet:
      "Usage: mnemo workspace set-role <workspaceId> <userId> <owner|admin|write|read>",
    sRoleInWorkspace: "{userId}'s role in workspace {workspaceId} set to {role}",
  },
  workspaceRemove: {
    usageMnemoWorkspaceRemove: "Usage: mnemo workspace remove <workspaceId> <userId>",
    removedFromWorkspace: "{userId} removed from workspace {workspaceId}",
  },
  decide: {
    kindDecisionArchitecturePolicy:
      "  kind: decision|architecture|policy|process|bugfix|learning|discovery|config",
  },
  entity: {
    kindPersonOrganizationProject: "  kind: person|organization|project|concept|place|other",
  },
  relate: {
    usageMnemoRelateHistory: "Usage: mnemo relate history <sourceKind> <id> [--max-depth N]",
    sourcekindFactDecisionEntity: "  sourceKind: fact|decision|entity|episode",
    walksTheSupersedesDerived:
      "  Walks the supersedes/derived_from chain from <id> — use this to see what a fact/decision replaced, not for general graph exploration.",
    usageMnemoRelateSourcekind:
      "Usage: mnemo relate <sourceKind> <sourceId> <verb> <targetKind> <targetId> [--reason r] [--confidence c] [--marked-by-kind user|agent|system|llm_judge]",
    sourcekindTargetkindFactDecision: "  sourceKind/targetKind: fact|decision|entity|episode",
    mnemoRelateListJudgment:
      "  mnemo relate list [--judgment-status pending|judged|dismissed] [--limit N]",
    mnemoRelateHistorySourcekind: "  mnemo relate history <sourceKind> <id> [--max-depth N]",
    listingRelations: "Listing relations",
    walkingRelationHistory: "Walking relation history",
    relationCreated: "Relation created",
    verbHint: "  verb: {verbs}",
    unknownVerb: "Error: unknown relation verb '{verb}'. Valid verbs: {verbs}",
  },
  strategy: {
    usageMnemoStrategyCreate:
      "Usage: mnemo strategy create --trigger <t> --action <a> [--context c] [--scope-ref sr]",
    usageMnemoStrategyShow: "Usage: mnemo strategy show <id>",
    usageMnemoStrategyUpdate:
      "Usage: mnemo strategy update <id> [--trigger t] [--action a] [--context c] [--status active|superseded|archived]",
    usageMnemoStrategyArchive: "Usage: mnemo strategy archive <id>",
    usageMnemoStrategyRate: "Usage: mnemo strategy rate <id> <success|failure>",
    unknownStrategySubcommandUse:
      "Unknown strategy subcommand '{subCmd}'. Use: create, list, show <id>, update <id>, archive <id>, rate <id> <success|failure>",
    strategyCreated: "Strategy created",
    listingStrategies: "Listing strategies",
    fetchingStrategy: "Fetching strategy",
    strategyUpdated: "Strategy updated",
    archived: "Archived",
    strategyRated: "Strategy rated {outcome}",
  },
  workflow: {
    usageMnemoWorkflowCreate:
      "Usage: mnemo workflow create --name <n> --steps '<json array>' [--description d] [--scope-ref sr]",
    stepsAJsonArray:
      '  --steps: a JSON array of either plain strings (e.g. \'["step 1","step 2"]\') or',
    actionExpecteddurationmsConditionTools:
      "  {action, expectedDurationMs?, condition?, tools?} objects for full control.",
    errorStepsMustBe:
      'Error: --steps must be a JSON array — plain strings (\'["step 1","step 2"]\') or {action, ...} objects',
    errorStepMustHave: 'Error: step {i} must have a non-empty "action" string',
    errorStepMustBe: "Error: step {i} must be a string or an {action, ...} object",
    usageMnemoWorkflowShow: "Usage: mnemo workflow show <id>",
    unknownWorkflowSubcommandUse:
      "Unknown workflow subcommand '{subCmd}'. Use: create, list, show <id>",
    workflowCreated: "Workflow created",
    listingWorkflows: "Listing workflows",
    fetchingWorkflow: "Fetching workflow",
  },
  skill: {
    usageMnemoSkillCreate:
      "Usage: mnemo skill create --name <n> --prompt <p> [--variables v1,v2] [--required-context c1,c2] [--sensitivity public|internal|confidential|restricted]",
    usageMnemoSkillShow: "Usage: mnemo skill show <id>",
    unknownSkillSubcommandUse: "Unknown skill subcommand '{subCmd}'. Use: create, list, show <id>",
    skillCreated: "Skill created",
    listingSkills: "Listing skills",
    fetchingSkill: "Fetching skill",
  },
  reasoning: {
    errorChainIsRequired:
      'Error: --chain is required, e.g. --chain \'[{"step":1,"reasoning":"..."}]\'',
    errorChainMustBe:
      "Error: --chain must be a JSON array of {step, reasoning, conclusion?} objects",
    usageMnemoReasoningCreate:
      "Usage: mnemo reasoning create --question <q> --conclusion <c> --chain '<json array>' [--topic-key tk]",
    chainItemShapeStep: '  chain item shape: {"step":1,"reasoning":"...","conclusion":"..."}',
    usageMnemoReasoningShow: "Usage: mnemo reasoning show <id>",
    usageMnemoReasoningArchive: "Usage: mnemo reasoning archive <id>",
    usageMnemoReasoningResolve: "Usage: mnemo reasoning resolve <query>",
    usageMnemoReasoningRecord:
      "Usage: mnemo reasoning record --question <q> --conclusion <c> --chain '<json array>' [--outcome success|fail]",
    usageMnemoReasoningFeedback: "Usage: mnemo reasoning feedback <id> <success|fail>",
    unknownReasoningSubcommandUse:
      "Unknown reasoning subcommand '{subCmd}'. Use: create, list, show <id>, archive <id>, resolve <query>, record, feedback <id> <success|fail>",
    reasoningRecorded: "Reasoning recorded",
    listingReasoning: "Listing reasoning",
    fetchingReasoning: "Fetching reasoning",
    archived: "Archived",
    resolvingReasoning: "Resolving reasoning",
    reasoningLogged: "Reasoning logged",
    reasoningFeedbackRecorded: "Reasoning feedback recorded: {outcome}",
  },
  hyperedge: {
    usageMnemoHyperedgeCreate:
      "Usage: mnemo hyperedge create --members id1,id2,id3 [--label l] [--description d] [--context-query q]",
    requiresAtLeastMember: "  Requires at least 3 member ids.",
    usageMnemoHyperedgeShow: "Usage: mnemo hyperedge show <id>",
    usageMnemoHyperedgeUpdate:
      "Usage: mnemo hyperedge update <id> [--label l] [--description d] [--context-query q]",
    usageMnemoHyperedgeArchive: "Usage: mnemo hyperedge archive <id>",
    unknownHyperedgeSubcommandUse:
      "Unknown hyperedge subcommand '{subCmd}'. Use: create, list, show <id>, update <id>, archive <id>",
    hyperedgeCreated: "Hyperedge created",
    listingHyperedges: "Listing hyperedges",
    fetchingHyperedge: "Fetching hyperedge",
    hyperedgeUpdated: "Hyperedge updated",
    archived: "Archived",
  },
  eventsExtended: {
    usageMnemoEventsCreate:
      "Usage: mnemo events create --type <t> --name <n> --description <d> --source <s> [--occurred-at iso]",
    typeSystemExternalUser: "  type: system|external|user|agent|scheduled",
    usageMnemoEventsShow: "Usage: mnemo events show <id>",
    usageMnemoEventsArchive: "Usage: mnemo events archive <id>",
    raiseOnlyTheServer: "  Raise-only: the server 422s an attempt to lower the tier.",
    eventRecorded: "Event recorded",
    fetchingEvent: "Fetching event",
    archived: "Archived",
    sensitivityUsage: "Usage: mnemo events sensitivity <id> <{tiers}>",
  },
  tasksExtended: {
    usageMnemoTasksCreate:
      "Usage: mnemo tasks create --title <t> --assigned-to <agent> [--description d] [--priority critical|high|medium|low] [--due-at iso]",
    usageMnemoTasksShow: "Usage: mnemo tasks show <id>",
    usageMnemoTasksUpdate:
      "Usage: mnemo tasks update <id> [--status s] [--outcome o] [--lessons-learned l]",
    usageMnemoTasksDelegate: "Usage: mnemo tasks delegate <id> --to <agent>",
    taskCreated: "Task created",
    fetchingTask: "Fetching task",
    taskUpdated: "Task updated",
    taskDelegatedTo: "Task delegated to {assignedTo}",
  },
  judge: {
    mergedStatementIsRequired: "  --merged-statement is required when action is 'merge'.",
    usageMnemoJudgeResolve: "Usage: mnemo judge resolve <relationId> merge --merged-statement <s>",
    mergeRequiresMergedStatement:
      "  merge requires --merged-statement — the corrected unified statement.",
    conflictResolved: "Conflict resolved: {action}",
    listingConflicts: "Listing conflicts",
    resolveUsage: "Usage: mnemo judge resolve <relationId> <{actions}> [--merged-statement s]",
  },
  purge: {
    errorPurgeIsA: "Error: purge is a hard, irreversible delete. Pass --confirm to proceed.",
    usageMnemoPurgeFactid: "Usage: mnemo purge <factId> --confirm",
    mnemoPurgeAllClosed: "       mnemo purge --all-closed --confirm",
    purgedClosedFactS: "Purged {deleted} closed fact(s).",
    purged: "Purged",
  },
  erase: {
    usage: "Usage: mnemo erase --user <userId> --confirm <userId>",
    usageActor: "       mnemo erase --actor <actorId> --confirm <actorId>",
    erased: "Erased: {keys} encryption key(s) destroyed",
  },
  remind: {
    usageMnemoRemindCreate:
      "Usage: mnemo remind create --content <c> [--condition c] [--trigger-at iso]",
    atLeastOneOf: "  At least one of --condition or --trigger-at is required.",
    errorAtLeastOne: "Error: at least one of --condition or --trigger-at is required.",
    usageMnemoRemindDismiss: "Usage: mnemo remind dismiss <id>",
    unknownRemindSubcommandUse:
      "Unknown remind subcommand '{subCmd}'. Use: create, list, dismiss <id>",
    reminderCreated: "Reminder created",
    listingReminders: "Listing reminders",
    dismissed: "Dismissed",
  },
  install: {
    noApiKeyFound: "❌ No API key found. Run: mnemo init  OR  set MNEMO_KEY env var.",
    error: "Error: {error}",
    noAiCodingAgents: "No AI coding agents detected on this machine.",
    supportedClaudeCodeCursor:
      "Supported: Claude Code, Cursor, OpenCode, Codex, Gemini CLI, Windsurf",
    installingFor: "Installing for {agentName}...",
    mcpRegisteredViaClaude: "  ✅ MCP registered via claude mcp add",
    claudeMcpAddFailed: "  ❌ Could not register the MCP server with `claude mcp add`: {reason}",
    claudeMcpStagedKept:
      "{reason} (the new entry stays registered as `{name}`, so Claude Code still has a working Mnemosyne server)",
    mcpHandshakeVerifiedInitialize:
      "  ✅ MCP handshake verified (initialize returned instructions)",
    theServerWasRegistered:
      "    The server was registered but could not be independently verified.",
    pluginHooksInstalledLocal:
      "  ✅ Plugin hooks installed (local dev mode), enabled, and verified",
    pluginHooksWereInstalled: "  ❌ Plugin hooks were installed but failed verification:",
    pluginInstallFailed: "  ❌ Plugin install failed:",
    pluginRegisteredViaClaude: "  ✅ Plugin registered via claude plugin marketplace/install",
    pluginHooksInstalledEnabled:
      "  ✅ Plugin hooks installed, enabled, and verified (session-start, user-prompt-submit, etc.)",
    hooksWereCopiedAnd:
      "    Hooks were copied and registered, but the check above failed — fix the above before relying on automatic memory capture.",
    mcpConfiguredInCursor: "  ✅ MCP configured in ~/.cursor/mcp.json",
    hooksInstalledInCursor:
      "  ✅ hooks installed in ~/.cursor/hooks.json (sessionStart → context injection, sessionEnd → episodic collapse)",
    agentsMdInstalled: "  ✅ AGENTS.md installed",
    mcpConfiguredInConfig: "  ✅ MCP configured in ~/.config/opencode/opencode.json",
    geminiMdGeminiExtension: "  ✅ GEMINI.md + gemini-extension.json installed",
    pluginDirNotFound: "  ⚠ Plugin dir not found — copy packages/plugin/GEMINI.md manually",
    mcpConfiguredInCodex: "  ✅ MCP configured in ~/.codex/config.toml",
    codexConfigRepaired:
      "  ✅ Removed the stray line an earlier 'mnemo install' had left in ~/.codex/config.toml",
    codexConfigNotUpdated: "  ❌ Codex: {path} was left unchanged — {reason}",
    codexInvalidToml:
      "it is not valid TOML (line {line}, column {column}: {message}). Fix the file and re-run 'mnemo install'.",
    codexEntryNotEditable:
      "its mnemosyne MCP entry is written in a form that cannot be replaced without rewriting the rest of the file (an inline table, a dotted key, or a multi-line value). Remove that entry and re-run 'mnemo install'.",
    mcpConfiguredInCodeium: "  ✅ MCP configured in ~/.codeium/windsurf/mcp_config.json",
    manualConfigRequiredSee: "  ℹ Manual config required — see packages/plugin/README.md",
    workspaceMappingSavedFor:
      "\n✅ Workspace mapping saved for project: {projectName} ({resolvedWorkspaceId})",
    mnemosyneInstallCompletedWith:
      "\n⚠ Mnemosyne install completed with failures — see per-agent messages above.",
    mnemosyneInstalledForAll: "\n✅ Mnemosyne installed for all detected agents.",
    restartYourAiAgents: "   Restart your AI agents to activate the MCP server and hooks.",
    captureWasNotFully: "\n⚠ Capture was NOT fully configured — see the Capture section above.",
    hintAuth:
      "This may be because the '{repo}' repository is private or otherwise inaccessible to your current GitHub account. Authenticate with 'gh auth login' or SSH, or use 'mnemo install --local' instead.",
    hintNetwork: "This may be because the network or GitHub is currently unreachable.",
    hintGitMissing: "This may be because 'git' does not appear to be installed on this machine.",
    hintUnknown: "Unrecognised failure — raw output is included below.",
    preflightNoClaude:
      "⚠ claude-code detected but the 'claude' CLI is not on PATH — skipping.\n    Install it (https://docs.claude.com/en/docs/claude-code/setup), reopen your shell, and re-run 'mnemo install'.\n    Config-only install is not available: plugin registration requires the CLI.",
    fatalFooter:
      "    Manual fallback:\n      claude plugin marketplace add {repo}\n      claude plugin install {pluginId}\n    Or run 'mnemo install --local' to install from your local working tree instead.",
    failureDetails: "    Details:\n{output}",
    noPluginEntry:
      "    'claude plugin install' exited 0 but no valid mnemosyne@mnemosyne entry (with a gitCommitSha) was found in installed_plugins.json.",
    localInstalling:
      "  ⚠ --local: installing from the working tree ({pluginDir}). This is a development install — not git-tracked, no gitCommitSha, and Claude Code will never update it. A later 'mnemo install' (no flag) replaces it with the published plugin.",
    localDone:
      "  ⚠ --local: development install complete — not git-tracked, no gitCommitSha; a later 'mnemo install' (no flag) will replace it with the published plugin.",
    existingFileKept:
      "  ⚠ {path} already exists and is not Mnemosyne's — kept as is. Merge the Mnemosyne instructions into it manually if needed.",
    symlinkSkipped:
      "  ⚠ {path} is a symlink — skipped to avoid overwriting its target. Merge the Mnemosyne config into it manually if needed.",
    verify: {
      noScriptsDir: "scripts directory not found at {scriptsDir}",
      notExecutable: "{file}: not executable (mode {mode})",
      cannotStat: "{file}: cannot stat ({message})",
      failedToExecute: "{file}: failed to execute ({message})",
      exitedDetail: " — {stderr}",
      syntaxError: "{file}: syntax error{detail}",
      toolMissing:
        "{tool}: not found on PATH. Every Mnemosyne hook calls it; without it the hooks run and capture nothing. Install {tool} and re-run 'mnemo install'.",
    },
    handshake: {
      spawnFailed: "Failed to spawn MCP process: {message}",
      timeout: "MCP server did not respond to initialize within timeout",
      noInstructions: "initialize response has no non-empty instructions field",
      processError: "MCP process error: {message}",
    },
    detectedAgents: "\nDetected agents: {agents}\n",
    handshakeFailed: "  ⚠ MCP handshake check failed: {message}",
    localDirMissing:
      "  ⚠ --local requested but the plugin directory was not found — plugin hooks and skills were skipped.",
    agentFailed: "  ⚠ {agentName}: {message}",
    workspaceUnresolved:
      "\n⚠ Could not resolve the workspace id from {url}/me — workspaces.json left unchanged.\n  Re-run 'mnemo install' once the server is reachable, or set it by hand.",
  },
  tasks: {
    listingTasks: "Listing tasks",
  },
  events: {
    listingEvents: "Listing events",
  },
  consolidate: {
    consolidationTriggered: "Consolidation triggered",
  },
  setup: {
    banner: {
      title: "MNEMOSYNE SETUP WIZARD",
      open: "Open in your browser to create your workspace:",
      expires: "Token expires in 15 minutes.",
    },
  },
  common: {
    missingFromResponse: "(missing from response)",
    none: "(none)",
    unknown: "(unknown)",
    unknownWord: "unknown",
    never: "never",
    revokedUpper: "REVOKED",
    activeUpper: "ACTIVE",
    configured: "configured",
    skipped: "skipped",
    unknownError: "unknown error",
    noneWord: "none",
  },
  workspaceTable: {
    id: "ID",
    name: "Name",
    role: "Role",
    visibility: "Visibility",
    userId: "User ID",
    joinedAt: "Joined At",
  },
  completion: {
    usage: "Usage: mnemo completion <shell>\nSupported shells: {shells}",
    unknownShell: "Unknown shell '{shell}'. Supported shells: {shells}",
  },
  info: {
    server: "{BOLD}Server{RESET}      {url}  {statusColor}{status}{RESET}",
    workspace: "{BOLD}Workspace{RESET}   {CYAN}{workspaceId}{RESET}",
    key: "{BOLD}Key{RESET}         {keyId}",
    actorType: "{BOLD}Actor type{RESET}  {actorType}",
    user: "{BOLD}User{RESET}        {userId}",
    tenant: "{BOLD}Tenant{RESET}      {tenantId}",
    plan: "{BOLD}Plan{RESET}        {plan}",
    scopes: "{BOLD}Scopes{RESET}      {scopes}",
    expires: "{BOLD}Expires{RESET}     {expiresAt}",
    hitRate: "{BOLD}Hit rate 30d{RESET}{rate}%",
    active: " {GREEN}← active{RESET}",
    fetchingSessionInfo: "Fetching session info",
    mnemosyneSessionInfo: "\n{BOLD}Mnemosyne — Session Info{RESET}",
    factsLivePinnedClosed:
      "{BOLD}Facts{RESET}       {live} live  /  {pinned} pinned  /  {closed} closed",
    lastRecall: "{BOLD}Last recall{RESET} {lastRecallAt}",
    availableWorkspaces: "{BOLD}Available workspaces{RESET} ({length})",
  },
  doctor: {
    overall: "\nMnemosyne Doctor — overall: {status}\n",
    runningDiagnostics: "Running diagnostics",
  },
  tenant: {
    created: "Created: {createdAt}",
    usageMnemoTenantCreate:
      "Usage: mnemo tenant create --name <name> [--kind personal|organization] [--plan <plan>] [--owner-token [--workspace-name <name>]]",
    tenantCreated: "Tenant created",
    ownerToken: "Owner token (shown once, save it now): {key}",
    ownerTokenWhere:
      "It acts in tenant {tenantId}, workspace {workspaceId}: use it as the API key for that tenant.",
    noOwnerToken:
      "Your current key keeps acting in its own tenant and cannot manage this one. Create a tenant with --owner-token to also get a token that can.",
    usageMnemoTenantShow: "Usage: mnemo tenant show <tenantId>",
    fetchingTenant: "Fetching tenant",
    usageMnemoTenantMembers: "Usage: mnemo tenant members <tenantId>",
    listingTenantMembers: "Listing tenant members",
    noMembersFound: "No members found.",
    usageMnemoTenantInvite:
      "Usage: mnemo tenant invite <tenantId> <email> [--role owner|admin|member] [--create-if-missing]",
    usageMnemoTenantRemove: "Usage: mnemo tenant remove <tenantId> <userId>",
    removedFromTenant: "{userId} removed from tenant {tenantId}",
    usageMnemoTenantWorkspaces: "Usage: mnemo tenant workspaces <tenantId>",
    listingTenantWorkspaces: "Listing tenant workspaces",
    noWorkspacesFound: "No workspaces found.",
    members: "{id}  {name}  ({visibility}, {memberCount} members)",
    unknownTenantSubcommandUse:
      "Unknown tenant subcommand '{subCmd}'. Use: create, show <id>, members <id>, invite <id> <email>, remove <id> <userId>, workspaces <id>",
    idLine: "ID:      {id}",
    nameLine: "Name:    {name}",
    kindLine: "Kind:    {kind}",
    planLine: "Plan:    {plan}",
    invited: "{email} invited to tenant {tenantId}{asRole}",
    asRole: " as {role}",
  },
  token: {
    scopes: "  Scopes:    {scopes}",
    expires: "  Expires:   {expires}\n",
    row: "{id}  {status}  {label}  [{scopes}]  workspace: {workspaceId}  expires: {expires}",
    usageMnemoTokenIssue:
      "Usage: mnemo token issue <tenantId> <userId> --label <label> --workspace <homeWorkspaceId> [--scopes <a,b,c>] [--expires <90d>] [--test]",
    errorLabelAndWorkspace: "Error: --label and --workspace are required.",
    mTokenMintedCopy:
      "\n\u001b[32m✓ Token minted — copy it now, it won't be shown again:\u001b[0m\n",
    usageMnemoTokenList: "Usage: mnemo token list <tenantId> <userId>",
    listingTokens: "Listing tokens",
    noTokensFound: "No tokens found.",
    usageMnemoTokenRevoke: "Usage: mnemo token revoke <tenantId> <userId> <keyId>",
    tokenRevokedAt: "Token {keyId} revoked at {revokedAt}",
    unknownTokenSubcommandUse: "Unknown token subcommand '{subCmd}'. Use: issue, list, revoke",
    idLine: "  ID:        {id}",
    userLine: "  User:      {userId}",
    workspaceLine: "  Workspace: {workspaceId}",
    tokenLine: "  Token:     {key}",
  },
  policy: {
    listing: "Listing agent policies",
    noPolicies: "No agent policies in this workspace.",
    fetching: "Fetching agent policy",
    saved: "Policy saved for agent {agentId}",
    deleted: "Policy deleted for agent {agentId}",
    usageGet: "Usage: mnemo policy get <agentId>",
    usageSet: "Usage: mnemo policy set <agentId> --file <policy.json>",
    usageDelete: "Usage: mnemo policy delete <agentId>",
    badFile: "Error: could not read a JSON object from {file}: {message}",
    unknownSubcommand: "Unknown policy subcommand '{subCmd}'. Use: list, get, set, delete",
  },
  keys: {
    row: "{id}  {status}  {label}  [{scopes}]  created: {created}  expires: {expiry}{ceiling}",
    ceiling: "  ceiling: {value}",
    invalidSensitivity: 'Error: --max-sensitivity must be one of: {valid}. Got: "{got}"',
    createScopes: "  Scopes:         {scopes}",
    createExpires: "  Expires:        {expires}",
    createMaxSensitivity: "  Max sensitivity: {value}\n",
    showLabel: "Label:           {label}",
    showScopes: "Scopes:          {scopes}",
    showIpAllowlist: "IP Allowlist:    {value}",
    unrestricted: "(unrestricted)",
    showExpires: "Expires:         {expires}",
    showLastUsed: "Last used:       {lastUsed}",
    showMaxSensitivity: "Max sensitivity: {value}",
    rotateWarning: "WARNING: Save this key now — it will NOT be shown again",
    listingKeys: "Listing keys",
    noKeysFound: "No keys found.",
    mKeyCreatedCopy: "\n\u001b[32m✓ Key created — copy it now, it won't be shown again:\u001b[0m\n",
    usageMnemoKeysRevoke: "Usage: mnemo keys revoke <keyId>",
    keyRevokedAt: "Key {keyId} revoked at {revokedAt}",
    usageMnemoKeysShow: "Usage: mnemo keys show <keyId>",
    fetchingKey: "Fetching key",
    usageMnemoKeysRotate: "Usage: mnemo keys rotate <keyId>",
    newKey: "New key:               {newKey}",
    newKeyId: "New key ID:            {newKeyId}",
    oldKeyValidUntil: "Old key valid until:   {oldKeySunsetAt}",
    theOldKeyWill: "\nThe old key will continue to work until the sunset date above.",
    updateYourConfigurationWith: "Update your configuration with the new key immediately.\n",
    unknownKeysSubcommandUse:
      "Unknown keys subcommand '{subCmd}'. Use: list, create, revoke, show, rotate, scoped",
    usageScoped:
      "Usage: mnemo keys scoped create --scopes <s1,s2> [--type live|sess|admin] [--expires 8h] [--ip-allowlist <cidr>] [--max-sensitivity <tier>]\n       mnemo keys scoped rotate <id> [reason]\n       mnemo keys scoped revoke <id>",
    scopedMfaSecret:
      "  TOTP secret:    {secret}\n  Add it to an authenticator app now: it won't be shown again. Send each code in x-mnemo-mfa.",
    scopedOtpauth: "  otpauth URI:    {uri}\n",
    createId: "  ID:             {id}",
    showId: "ID:              {id}",
    createKey: "  Key:            {key}",
    createLabel: "  Label:          {label}",
    createPlan: "  Plan:           {plan}",
    showRevoked: "Revoked:         {revokedAt}",
    showDeprecated: "Deprecated:      {deprecatedAt}",
    showRotatedFrom: "Rotated from:    {rotatedFromId}",
    showCreated: "Created:         {createdAt}",
  },
  workspace: {
    unknownWorkspaceSubcommandUse:
      "Unknown workspace subcommand '{subCmd}'. Use: list, show <id>, members <id>, create, invite, set-role, remove",
  },
  user: {
    usageMnemoUserCreate: "Usage: mnemo user create --email <email> [--display-name <name>]",
    userCreated: "User created",
    unknownUserSubcommandUse: "Unknown user subcommand '{subCmd}'. Use: create",
    personalTenantLine: "  Personal tenant:    {id}",
    personalWorkspaceLine: "  Personal workspace: {id}",
  },
  harness: {
    queuePendingBytes: "queue:       {count} pending, {bytes} bytes",
    deadLetters: "dead letters:{deadLetters}",
    filesystem: "filesystem:  {mode}",
    queueIsEmptyPending: "queue is empty (0 pending, 0 quarantined)",
    pendingSeqB: "  pending  {eventId}  seq={enqueueSequence}  {type}  {bytes}B  {occurredAt}",
    deadB: "  dead     {id}  {bytes}B",
    refusingToRetryThe:
      "refusing to retry: the queue's binding no longer matches this configuration",
    releasedQueuedRecordS: "released {released} queued record(s) for delivery",
    discardRequiresReasonWhy: "discard requires --reason <why>",
    permanentlyDiscardTheQueued: "Permanently discard the queued capture?",
    discardCancelled: "discard cancelled",
    discardedRecordS: "discarded {discarded} record(s)",
    harnessOk: "harness: ok",
    problem: "problem: {problem}",
    probePersistedStateThis:
      "probe persisted state; this is a bug and the result cannot be trusted",
    serverIsNotAccepting: "server is not accepting harness capture for workspace {workspaceId}",
    serverAvailableForWorkspace: "server available for workspace {workspaceId}",
    captured: "captured",
    unknownHarnessCommand: "unknown harness command: {subcommand}",
    oldest: "oldest:      {age}s",
    delivery: "delivery:    attempt {attempt}{next}{blocked}",
    deliveryNext: ", next {nextAttemptAt}",
    deliveryBlocked: ", BLOCKED ({status})",
    binding: "binding:     {serverUrl} workspace {workspaceId}",
    bindingNone: "binding:     none",
    capture: "capture:     {state}",
    fullFidelity: "full fidelity",
    incomplete: "INCOMPLETE",
    hostCapture: "  {host}: {mode} — {reason}",
    unknownQueueSubcommand: "unknown queue subcommand: {sub}",
    queueCounts: "{pending} pending, {quarantined} quarantined",
    help: "mnemo harness <command>\n\n  queue list              Show queued and quarantined records (metadata only)\n  retry                   Release a blocked or backed-off queue for delivery\n  discard --reason <why>  Permanently drop the queue (asks unless --yes)\n  doctor                  Diagnose the local capture queue\n  probe                   Check the bound server, without persisting anything\n  hook                    Host capture entry point (always exits 0)\n\nRolling capture back out, in this order:\n  disable <host>          Stop this host capturing; the queue keeps its destination\n  drain                   Deliver the queued events, to zero\n  quiesce                 Fence the server; wait for zero leases and in-flight writes\n  uninstall <host>        Remove Mnemosyne's own artifacts (requires the steps above)\n",
    disableRequiresAHost: "disable requires a host name",
    couldNotDisableCapture: "could not disable capture for {host}",
    captureDisabledFor: "capture disabled for {host}",
    serverIngestionIsStill:
      "server ingestion is still available, so the queue can still be drained",
    deliveredQueuedRecordS: "delivered {delivered} queued record(s)",
    drainIncompleteRecordS: "drain incomplete: {remaining} record(s) remain",
    queueDrainedRemaining: "queue drained: 0 remaining",
    notQuiescedLiveLease: "not quiesced: {liveLeases} live lease(s), {inFlight} write(s) in flight",
    workspaceQuiescedLeasesWrites: "workspace quiesced: 0 leases, 0 writes in flight",
    uninstallRequiresAHost: "uninstall requires a host name",
    isStillCapturingRun: '{host} is still capturing; run "mnemo harness disable {host}" first',
    permanentlyDiscardQueuedRecord: "Permanently discard {queued} queued record(s) for {host}?",
    uninstallCancelled: "uninstall cancelled",
    discardingQueuedRecordS: "discarding {queued} queued record(s)",
    removed: "removed: {artifact}",
    pluginPathIsEmpty: "plugin path is empty or padded",
    configUnreadable: "config could not be read",
    configNotObject: "config is not an object",
    pluginKeyNotList: "config's plugin key is not a list",
    mergedConfigUnparsable: "merged config would not reparse",
    mergedConfigLacksPlugin: "merged config does not contain the plugin",
    mergedConfigWouldChange: "merged config would change unrelated key: {key}",
    configReplaceFailed: "config could not be replaced atomically{detail}",
    stillQueued:
      '{queued} record(s) are still queued; run "mnemo harness drain", or pass --discard-queued to throw them away',
    preserved: "preserved (not ours): {artifacts}",
    quiescenceNeeded:
      'server quiescence still needs operator action: run "mnemo harness quiesce" before rolling the server back',
    lifecycleHelp:
      "mnemo harness <command>\n\n  disable <host>     Stop this host capturing. Queued events keep their destination.\n  drain              Deliver the queued events, to zero.\n  quiesce            Fence the server and wait for zero leases and in-flight writes.\n  uninstall <host>   Remove Mnemosyne's own artifacts. Requires the steps above.\n",
    configMalformed: "config is malformed: {code}",
    configIsASymlink: "config is a symbolic link",
    configNotRegularFile: "config is not a regular file",
  },
  capture: {
    codexHooksDoNot: "Codex hooks do not exist on Windows; MCP remains available",
    featuresHooksIsNot: "features.hooks is not enabled in config.toml (it defaults off)",
    pluginPayloadMissing: "this build's plugin payload could not be located",
    noOpencodeJsonTo: "no opencode.json to add the plugin to",
    noClaudeHookManifest: "this build ships no Claude Code hook manifest",
    theClaudeCodePlugin:
      "the Claude Code plugin is not installed; run 'mnemo install' for that host first",
    captureWouldBeLimited: "{host}: capture would be limited to {mode} — {reason}. Install anyway?",
    enableItNow: "{host}: {gateReason} Enable it now?",
    couldNotDetect: "could not detect {host}: {error}",
    runMnemoInstallCapture: "run 'mnemo install --capture {host}' to reconsider",
    noWayToAsk: "{host}: no way to ask for consent; pass --accept-degraded to answer in advance",
    gateEnableFailed: "{host}: could not enable the host gate: {reason}",
    restartForCaptureTo: "restart {host} for capture to begin",
    configUnreadable: "config could not be read",
    configIsMalformed: "config is malformed: {reason}",
    mergedConfigUnparsable: "merged config would not reparse",
    mergedConfigLacksHooks: "merged config does not enable features.hooks",
    mergedConfigWouldChange: "merged config would change something other than features.hooks",
    configReplaceFailed: "config could not be replaced atomically{detail}",
    noFeatureGate: "this host has no feature gate",
    configTomlUnparsable: "config.toml could not be parsed: {reason}",
    featuresHooksIsEnabled: "features.hooks is enabled",
    noCodexPluginPayload: "this build ships no Codex plugin payload",
    noHookScripts: "this build ships no hook scripts",
    noFeatureGateToEnable: "this host has no feature gate to enable",
    configTomlNotTable: "config.toml is not a TOML table",
    configDeclaresFeaturesMore:
      "config declares [features] more than once; set hooks = true by hand",
    configAssignsFeaturesHooks:
      "config assigns features.hooks more than once; set hooks = true by hand",
    configTomlCouldNotRead: "config.toml could not be read: {message}",
    codexMarketplaceAddFailed: "codex plugin marketplace add failed: {output}",
    codexPluginAddFailed: "codex plugin add failed: {output}",
    noOutput: "no output",
    couldNotResolve: "could not resolve {host}: {message}",
    noWorkspaceToBind:
      "could not resolve the workspace from the server, so capture has no destination to bind to",
    couldNotBind: "could not bind capture to a destination: {message}",
    destinationChanged:
      "the capture destination changed; run 'mnemo harness drain' for events queued under the previous one",
    summaryHeading: "Capture:",
    stateFailed: "could not configure",
    stateSkipped: "not configured",
    stateAlready: "already configured",
    stateConfigured: "configured",
    hostLine: "  {host}: {state} ({mode})",
    why: "    why: {reason}",
    youDeclinedThis: "    you declined this one",
    youDeclinedGate: "    you declined enabling the host gate",
    gateNotOffered: "    the host gate was not offered: nothing to ask on",
    failed: "    failed: {failure}",
    next: "    next: {nextStep}",
    inlineTable: "an inline table",
    dottedKey: "a dotted key",
    featuresDeclaredAs: "features is declared as {form}; add [features] with hooks = true by hand",
    ambiguousConfig: "more than one candidate config: {candidates}",
  },
  installArgs: {
    captureHasAnEmpty: "--capture has an empty host name in '{raw}'.",
    doesNotTakeA: "{name} does not take a value.",
    captureMayOnlyBe: "--capture may only be given once.",
    acceptDegradedOnlyMeans:
      "--accept-degraded only means something with --capture; nothing would be installed.",
    unknownOption:
      "Unknown option for 'install': {tokens}.\nValid options: {valid}. Run 'mnemo --help' for usage.",
    unknownOptions:
      "Unknown options for 'install': {tokens}.\nValid options: {valid}. Run 'mnemo --help' for usage.",
    unknownHost: "--capture: unknown host '{name}'. Valid hosts: {hosts}.",
    requiresHostList: "--capture requires a comma-separated host list ({hosts}).",
  },
  atomic: {
    symlink: "{target} is a symlink; refusing to write through it",
    disappeared: "{target} disappeared after it was resolved",
    changed: "{target} is no longer the file that was resolved",
    notJson: "{target} is not valid JSON; it was left as it was",
  },
  api: {
    error: "Error: {status} {message}",
    errorMessage: "Error: {message}",
  },
  cli: {
    error: "Error: {message}",
    warningCouldNotParse: "Warning: could not parse {configPath}, ignoring.",
    warningIsMissingA: 'Warning: {configPath} is missing a valid "workspaceId" field, ignoring.',
  },
  empty: {
    tasks: "No tasks found.",
    relations: "No relations found.",
    strategies: "No strategies found.",
    workflows: "No workflows found.",
    skills: "No skills found.",
    reasoning: "No reasoning found.",
    hyperedges: "No hyperedges found.",
    pairs: "No pairs found.",
    reminders: "No reminders found.",
  },
  prompt: {
    yesNoDefaultNo: "[y/N]",
    yesNoDefaultYes: "[Y/n]",
  },
} as const;
