# @mnemo-ai/plugins

**English** · [Español](README.es.md)

> **AI pointer:** Full plugin hook surface (§21) — lifecycle, write-path, read-path, async event hooks, sync polling, verification. 10 built-in plugins. Timeout auto-disable (MNEMO_010).
>
> **Depends on:** (no Mnemosyne monorepo deps — standalone)
>
> **Exposes:** `MnemoPlugin`, `PluginContext`, `PluginLoader`, `PluginStateStore`, `createPluginLoaderFromEnv`, `parsePluginConfig`, `InMemoryPluginStateStore`, 10 built-in factory functions
>
> **Status:** STABLE — shipped in Wave U

---

## Security Model

**Plugins run in the same Node.js process as the server with NO sandbox.**

Every `package:` plugin has full access to memory, filesystem, network, env vars, and all imported modules. Treat plugin packages with the same scrutiny as production server code.

The server's opt-in is `MNEMO_PLUGINS` itself: with it unset, no plugin code runs. `plugins.allowUnsandboxedPlugins: true` is the opt-in for hosts that read `mnemo.config.yaml` with `parsePluginConfig`.

---

## Configuration

The server reads two kinds of environment variables (`createPluginLoaderFromEnv`):

- `MNEMO_PLUGINS`: comma-separated list of plugins to load. Each entry is an npm package name or `builtin:<id>` for one of the built-ins below, e.g. `MNEMO_PLUGINS=builtin:webhook-notify,@acme/mnemo-plugin-audit-log`. An entry that does not load (unknown built-in, missing package, bad export) is logged as `plugin.load_failed`, with the list of known built-ins for an unknown one, and the server boots without it.
- `MNEMO_PLUGIN_<ID>__<KEY>`: one config value for the plugin whose `id` is `<ID>`, for built-ins and packages alike. `<ID>` is the plugin id in upper case with every other character as `_` (`webhook-notify` → `WEBHOOK_NOTIFY`), the double underscore ends it, and `<KEY>` in UPPER_SNAKE becomes the camelCase key the plugin reads from `ctx.config` (`OUTLINE_API_URL` → `outlineApiUrl`). Example: `MNEMO_PLUGIN_OUTLINE_SYNC__API_TOKEN=...` arrives as `ctx.config.apiToken`. `MNEMO_PLUGIN_<ID>__WORKSPACE_ID` (`workspaceId`) is the workspace that plugin's `sync()` and `verify()` run in; without it the server skips them and logs a warning.

Every hook, event and sync of a plugin gets its own context: its own config, never another plugin's, and its own `ctx.state`, stored under its id. `MNEMO_PLUGIN_<ID>__MAX_SENSITIVITY` (`maxSensitivity`) sets that plugin's sensitivity ceiling, `ctx.maxSensitivity`, which also caps the facts it writes with `ctx.createFact`; without a valid tier it is `internal`. Values may be secrets (tokens, webhook URLs): the loader logs only the config keys. The server reads environment variables rather than `mnemo.config.yaml` because it reads no config file at all, and the Docker deployment and its secrets already go through the environment.

`parsePluginConfig` reads the file below for a host that calls it; the server does not:

```yaml
plugins:
  allowUnsandboxedPlugins: true # required — explicit opt-in
  load:
    - package: "@my-org/mnemo-plugin-audit-log"
      config:
        webhookUrl: "https://hooks.example.com/..."
    - package: "@my-org/mnemo-plugin-pii-redactor"
```

---

## MnemoPlugin Interface

```typescript
interface MnemoPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;

  // Lifecycle
  onInit?(ctx: PluginContext): Promise<void> | void;
  onShutdown?(ctx?: PluginContext): Promise<void> | void;
  onHealthCheck?(): Promise<PluginHealth> | PluginHealth;

  // Write-path (sync, chain; null = reject the write)
  onBeforeWrite?(unit: PluginKnowledgeUnit, ctx: PluginContext): PluginKnowledgeUnit | null | Promise<...>;
  onAfterWrite?(unit: PluginKnowledgeUnit, ctx: PluginContext): void | Promise<void>;

  // Read-path (sync, chain; can modify query/hits)
  onBeforeRecall?(input: PluginRecallInput, ctx: PluginContext): PluginRecallInput | Promise<...>;
  onAfterRecall?(hits: PluginRecallHit[], ctx: PluginContext): PluginRecallHit[] | Promise<...>;

  // Async event hooks (fire-and-forget via Q bus)
  onFactCreated?(fact: PluginFact, ctx: PluginContext): Promise<void>;
  onTaskCompleted?(task: PluginTask, ctx: PluginContext): Promise<void>;
  onSessionCollapsed?(summary: SessionCollapseSummary, ctx: PluginContext): Promise<void>;
  onConflictDetected?(conflict: FactConflict, ctx: PluginContext): Promise<void>;
  onWorthChanged?(memoryId: string, newWorth: number, ctx: PluginContext): Promise<void>;

  // Sync polling
  syncInterval?: number;                   // ms, at least 60000; default MNEMO_PLUGIN_SYNC_INTERVAL_MS (1h)
  sync?(ctx: PluginContext): Promise<SyncResult>;

  // Verification
  verify?(facts: PluginFact[], ctx: PluginContext): Promise<VerificationResult[]>;
}
```

---

## PluginContext

The constrained surface every plugin receives. No raw DB, no cross-workspace access, no admin ops.

```typescript
interface PluginContext {
  readonly workspaceId: string;
  readonly config: Record<string, string | undefined>; // this plugin's config (MNEMO_PLUGIN_<ID>__<KEY>)

  // Read (RBAC-scoped to workspaceId)
  recall(query: string): Promise<PluginRecallHit[]>;
  getFact(id: string): Promise<PluginFact | null>;

  // Write (rate-limited 10/min, audited; actorId = "plugin:<id>")
  createFact(input: PluginCreateFactInput): Promise<PluginFact>;
  createEvent(input: PluginCreateEventInput): Promise<PluginEvent>;

  // Private per-plugin state (persisted in mnemo_plugin_state.state JSONB)
  readonly state: PluginStateStore;

  // Structured logging (prefixed with plugin id)
  readonly log: PluginLogger;
}
```

---

## PluginLoader

```typescript
const loader = await createPluginLoaderFromEnv(logger);

await loader.runBoot(ctx); // call onInit on all plugins
await loader.runShutdown(ctx); // call onShutdown on all plugins
await loader.runBeforeWrite(unit, ctx); // → PluginKnowledgeUnit | null
await loader.runAfterWrite(unit, ctx); // fire-and-forget
await loader.runBeforeRecall(input, ctx); // → PluginRecallInput
await loader.runAfterRecall(hits, ctx); // → PluginRecallHit[]
await loader.runEventHook(hookName, payload, ctx); // async, fire-and-forget
await loader.runHealthChecks(); // → Array<{ id, health }>
await loader.runSync(ctx, pluginId?); // run sync() on all syncing plugins, or only pluginId
await loader.runVerify(facts, ctx, pluginId?); // → VerificationResult[]
loader.syncPlugins(); // → Array<{ id, syncInterval?, workspaceId? }>
loader.verifyPlugins(); // → Array<{ id, workspaceId?, maxSensitivity }>
loader.list(); // → Array<{ id, name, version, disabled? }>
```

### Timeout auto-disable (MNEMO_010)

Any hook that times out (2 s) OR fails 3 consecutive times is **permanently disabled** for the process lifetime. The error code `MNEMO_010` is logged. The plugin stays in `list()` with `disabled: true`.

---

## Built-in Plugins

All built-ins are exported as factory functions from `@mnemo-ai/plugins` and listed in `BUILTIN_FACTORIES`. The server loads one when `MNEMO_PLUGINS` names it as `builtin:<id>` and passes it the config keys below from `MNEMO_PLUGIN_<ID>__<KEY>`. The server runs `onInit`, the event hooks off the bus, and from its cron registry: each plugin's `sync` as its own job (`mnemo.plugin.sync:<id>`) every `syncInterval` (at least 60 s, or `MNEMO_PLUGIN_SYNC_INTERVAL_MS`, 1 h, without one) in the workspace from `MNEMO_PLUGIN_<ID>__WORKSPACE_ID`; and `verify` daily (`mnemo.plugin.verify`) over the code, config and infrastructure facts (`metadata.source_type`) of that same workspace, only those at or below the plugin's `maxSensitivity`, in batches of 50 as `{ id, content, metadata }`, sending every fact returned with `valid: false` to that workspace's review queue (reason `plugin_verification_failed`) rather than closing it. `onHealthCheck` is reported in the `plugins` block of `GET /health/deep` and never changes its status. `obsidian-export` writes the facts its `verify` is given to its vault. The handler and utility built-ins only expose functions (`handleSlackEvent`, `handleGithubWebhook`, `exportVault`, `importClaudeMemory`) for a host to call.

| Factory                        | Hook used                                            | Purpose                                                    | Entry                     | Config keys                 |
| ------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------- | ------------------------- | --------------------------- |
| `createWebhookNotifyPlugin()`  | `onFactCreated`, `onTaskCompleted`, `onWorthChanged` | POST to a webhook URL                                      | `builtin:webhook-notify`  | `url`                       |
| `createFeedbackLoopPlugin()`   | `onWorthChanged`                                     | Records worth history in state (max 20)                    | `builtin:feedback-loop`   | none                        |
| `createGitVerifierPlugin()`    | `verify`                                             | Checks `metadata.commitSha` via `git cat-file`             | `builtin:git-verifier`    | `repoPath`                  |
| `createCalendarSyncPlugin()`   | `sync`                                               | Parses ICS VEVENTs → createEvent per event                 | `builtin:calendar-sync`   | `icsUrl`                    |
| `createSlackEventsPlugin()`    | event handler                                        | Maps Slack `message` events → createEvent                  | `builtin:slack-events`    | `webhookUrl`                |
| `createGithubEventsPlugin()`   | webhook handler                                      | PR → createEvent; issue.opened → createEvent + createFact  | `builtin:github-events`   | none                        |
| `createOutlineSyncPlugin()`    | `sync`                                               | Syncs Outline docs → facts (namespace=kb)                  | `builtin:outline-sync`    | `outlineApiUrl`, `apiToken` |
| `createObsidianExportPlugin()` | utility                                              | Recalls all facts → writes `.md` files to a vault dir      | `builtin:obsidian-export` | `vaultDir`                  |
| `createClaudeImportPlugin()`   | utility                                              | Imports a Claude memory JSON array → facts                 | `builtin:claude-import`   | none                        |
| `createEventReactionsPlugin()` | `onEventRecorded`                                    | Fires reactive rules when events match configured triggers | `builtin:event-reactions` | none                        |

---

## Example Plugin

```typescript
import type { MnemoPlugin, PluginContext } from "@mnemo-ai/plugins";

export default {
  id: "my-pii-redactor",
  name: "PII Redactor",
  version: "1.0.0",

  async onBeforeWrite(unit, ctx) {
    const redacted = unit.content.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]");
    return { ...unit, content: redacted };
  },
} satisfies MnemoPlugin;
```

---

## Testing

```bash
pnpm --filter @mnemo-ai/plugins test
```

Covers hooks, timeout-disable, state, config parsing, and all 10 built-ins.
