import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { en } from "../i18n/en.js";
import { es } from "../i18n/es.js";
import { CLI_VERSION } from "../commands.js";
import { runMain } from "./helpers/run-main.js";

const { FAKE_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  return { FAKE_HOME: fs.mkdtempSync(os.tmpdir() + "/mnemo-help-es-home-") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => FAKE_HOME };
});

afterAll(() => rmSync(FAKE_HOME, { recursive: true, force: true }));

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(join(FAKE_HOME, ".mnemo"), { recursive: true });
  writeFileSync(join(FAKE_HOME, ".mnemo", "config.json"), JSON.stringify(config));
}
beforeEach(() => writeConfig({}));

describe("English help is unchanged (snapshot recorded before the i18n refactor)", () => {
  it("mnemo --help", async () => {
    const { out } = await runMain(["--help"]);
    expect(out.replace(CLI_VERSION, "X.Y.Z")).toMatchInlineSnapshot(`
      "
      mnemo — Mnemosyne CLI vX.Y.Z

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
      "
    `);
  });
  it("mnemo help prints the same text", async () => {
    const a = await runMain(["--help"]);
    const b = await runMain(["help"]);
    expect(b.out).toBe(a.out);
  });
});

const SPANISH = /^USO$/m;
const ENGLISH = /^USAGE$/m;

describe("Spanish help is chosen by the locale chain", () => {
  it("--locale es-419", async () => {
    const { out } = await runMain(["--locale", "es-419", "--help"]);
    expect(out).toMatch(SPANISH);
    expect(out).toContain(`CLI de Mnemosyne v${CLI_VERSION}`);
  });
  it("--locale es (any es maps to es-419) and `help`", async () => {
    expect((await runMain(["--locale", "es", "help"])).out).toMatch(SPANISH);
  });
  it("MNEMO_LOCALE=es-419", async () => {
    expect((await runMain(["--help"], { MNEMO_LOCALE: "es-419" })).out).toMatch(SPANISH);
  });
  it("LANG=es_MX.UTF-8", async () => {
    expect((await runMain(["--help"], { LANG: "es_MX.UTF-8" })).out).toMatch(SPANISH);
  });
  it("config locale", async () => {
    writeConfig({ locale: "es-419" });
    expect((await runMain(["--help"])).out).toMatch(SPANISH);
  });
  it("--locale en-US beats MNEMO_LOCALE, which beats config, which beats LANG", async () => {
    writeConfig({ locale: "es-419" });
    expect((await runMain(["--locale", "en-US", "--help"], { MNEMO_LOCALE: "es" })).out).toMatch(
      ENGLISH
    );
    expect((await runMain(["--help"], { MNEMO_LOCALE: "en-US" })).out).toMatch(ENGLISH);
    writeConfig({ locale: "en-US" });
    expect((await runMain(["--help"], { LANG: "es_MX.UTF-8" })).out).toMatch(ENGLISH);
  });
  it("LC_ALL=C decides over LANG=es_MX (POSIX: the first non-empty variable wins)", async () => {
    expect((await runMain(["--help"], { LC_ALL: "C", LANG: "es_MX.UTF-8" })).out).toMatch(ENGLISH);
  });
  it("an unknown locale in the environment or config falls back to English", async () => {
    writeConfig({ locale: "klingon" });
    expect((await runMain(["--help"], { MNEMO_LOCALE: "fr" })).out).toMatch(ENGLISH);
  });
});

describe("the Spanish help keeps the English structure", () => {
  const enLines = en.help.text.split("\n");
  const esLines = es.help.text.split("\n");

  it("has the same number of lines", () => {
    expect(esLines.length).toBe(enLines.length);
  });

  it("never translates commands, flags, env vars or paths", () => {
    const tokens = (text: string) =>
      new Set(text.match(/--[a-z][a-z-]*|MNEMO_[A-Z_]+|~\/\.mnemo\/[\w.]+|\bmnemo [a-z]+/g) ?? []);
    const a = tokens(en.help.text);
    const b = tokens(es.help.text);
    // "mnemo export" appears inside an English sentence ("mnemo export when…")
    // and "mnemo <command>" is the one usage line; every other token must match.
    for (const token of a) expect(b.has(token), token).toBe(true);
    for (const token of b) expect(a.has(token), token).toBe(true);
  });

  it("starts every description at the same column as English", () => {
    enLines.forEach((line, i) => {
      const prefix = line.slice(0, 30);
      // A description column: two leading spaces, the command, padding up to column 30.
      if (/^ {2}\S.* {2}$/.test(prefix) || prefix.trim() === "") {
        expect(esLines[i]!.slice(0, 30), `line ${i + 1}`).toBe(prefix);
      }
    });
    // English has one stray extra space on `events [list]`; Spanish is aligned.
    const events = esLines.find((l) => l.startsWith("  events [list]"))!;
    expect(events.indexOf("Lista")).toBe(30);
  });

  it("has no voseo", () => {
    const vos =
      /(?<!\p{L})(usá|tenés|podés|hacé|elegí|querés|sabés|mirá|fijate|poné|decime|vos|acá|ahorita|vení|andá|pasá|probá|revisá|ejecutá)(?!\p{L})/iu;
    expect(JSON.stringify(es)).not.toMatch(vos);
    // teeth: accented voseo forms are caught (a `\b` boundary missed them)
    expect("Usá la opción").toMatch(vos);
    expect("Elegí uno").toMatch(vos);
  });
});
