# @mnemo-ai/plugins

[English](README.md) · **Español**

> **Puntero para IA:** superficie completa de hooks de plugins (§21): ciclo de vida, ruta de escritura, ruta de lectura, hooks de eventos asíncronos, sondeo síncrono y verificación. 10 plugins integrados. Desactivación automática por tiempo de espera agotado (MNEMO_010).
>
> **Depende de:** (sin dependencias del monorepo de Mnemosyne: autónomo)
>
> **Expone:** `MnemoPlugin`, `PluginContext`, `PluginLoader`, `PluginStateStore`, `createPluginLoaderFromEnv`, `parsePluginConfig`, `InMemoryPluginStateStore`, 10 funciones fábrica integradas
>
> **Estado:** STABLE — publicado en la Wave U

---

## Modelo de seguridad

**Los plugins se ejecutan en el mismo proceso de Node.js que el servidor, SIN sandbox.**

Todo plugin `package:` tiene acceso completo a la memoria, al sistema de archivos, a la red, a las variables de entorno y a todos los módulos importados. Trata los paquetes de plugins con el mismo rigor que el código del servidor de producción.

En el servidor, la aceptación explícita es `MNEMO_PLUGINS` mismo: sin esa variable no corre código de ningún plugin. `plugins.allowUnsandboxedPlugins: true` es la aceptación para los hosts que leen `mnemo.config.yaml` con `parsePluginConfig`.

---

## Configuración

El servidor lee dos tipos de variables de entorno (`createPluginLoaderFromEnv`):

- `MNEMO_PLUGINS`: lista separada por comas de los plugins que se cargan. Cada entrada es el nombre de un paquete npm o `builtin:<id>` para uno de los plugins integrados de abajo, por ejemplo `MNEMO_PLUGINS=builtin:webhook-notify,@acme/mnemo-plugin-audit-log`. Una entrada que no carga (integrado desconocido, paquete ausente, export inválido) se registra como `plugin.load_failed`, con la lista de integrados conocidos cuando el nombre no existe, y el servidor arranca sin ella.
- `MNEMO_PLUGIN_<ID>__<KEY>`: un valor de configuración para el plugin cuyo `id` es `<ID>`, tanto integrados como paquetes. `<ID>` es el id del plugin en mayúsculas con cualquier otro carácter como `_` (`webhook-notify` → `WEBHOOK_NOTIFY`), el doble guion bajo lo termina, y `<KEY>` en UPPER_SNAKE se convierte en la clave camelCase que el plugin lee de `ctx.config` (`OUTLINE_API_URL` → `outlineApiUrl`). Ejemplo: `MNEMO_PLUGIN_OUTLINE_SYNC__API_TOKEN=...` llega como `ctx.config.apiToken`. `MNEMO_PLUGIN_<ID>__WORKSPACE_ID` (`workspaceId`) es el workspace en el que corren el `sync()` y el `verify()` de ese plugin; sin él, el servidor los omite y registra una advertencia.

Cada hook, evento y sincronización de un plugin recibe su propio contexto: su configuración, nunca la de otro, y su propio `ctx.state`, guardado bajo su id. `MNEMO_PLUGIN_<ID>__MAX_SENSITIVITY` (`maxSensitivity`) fija el techo de sensibilidad de ese plugin, `ctx.maxSensitivity`, que también limita los hechos que escribe con `ctx.createFact`; sin un nivel válido es `internal`. Los valores pueden ser secretos (tokens, URLs de webhooks): el cargador registra solo los nombres de las claves. El servidor usa variables de entorno y no `mnemo.config.yaml` porque no lee ningún archivo de configuración, y el despliegue con Docker y sus secretos ya pasan por el entorno.

`parsePluginConfig` lee el archivo siguiente para el host que lo invoque; el servidor no lo hace:

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

## Interfaz MnemoPlugin

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

La superficie restringida que recibe todo plugin. Sin acceso directo a la base de datos, sin acceso entre espacios de trabajo, sin operaciones de administración.

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

### Desactivación automática por tiempo de espera (MNEMO_010)

Cualquier hook que agote su tiempo de espera (2 s) O falle 3 veces seguidas queda **desactivado de forma permanente** durante la vida del proceso. Se registra el código de error `MNEMO_010`. El plugin permanece en `list()` con `disabled: true`.

---

## Plugins integrados

Todos los plugins integrados se exportan como funciones fábrica desde `@mnemo-ai/plugins` y figuran en `BUILTIN_FACTORIES`. El servidor carga uno cuando `MNEMO_PLUGINS` lo nombra como `builtin:<id>` y le pasa las claves de configuración de la tabla desde `MNEMO_PLUGIN_<ID>__<KEY>`. El servidor ejecuta `onInit`, los hooks de eventos del bus y, desde su registro de crons: el `sync` de cada plugin como un trabajo propio (`mnemo.plugin.sync:<id>`) cada `syncInterval` (al menos 60 s, o `MNEMO_PLUGIN_SYNC_INTERVAL_MS`, 1 h, si no lo declara) en el workspace de `MNEMO_PLUGIN_<ID>__WORKSPACE_ID`; y `verify` una vez al día (`mnemo.plugin.verify`) sobre los hechos de código, configuración e infraestructura (`metadata.source_type`) de ese mismo workspace, solo los que no superan el `maxSensitivity` del plugin, en lotes de 50 como `{ id, content, metadata }`, enviando cada hecho que vuelve con `valid: false` a la cola de revisión de ese workspace (motivo `plugin_verification_failed`) en lugar de cerrarlo. `onHealthCheck` aparece en el bloque `plugins` de `GET /health/deep` y nunca cambia su estado. `obsidian-export` escribe en su bóveda los hechos que recibe su `verify`. Los integrados de tipo manejador o utilidad solo exponen funciones (`handleSlackEvent`, `handleGithubWebhook`, `exportVault`, `importClaudeMemory`) para que un host las llame.

| Fábrica                        | Hook usado                                           | Propósito                                                                               | Entrada                   | Claves de config            |
| ------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------- | --------------------------- |
| `createWebhookNotifyPlugin()`  | `onFactCreated`, `onTaskCompleted`, `onWorthChanged` | Hace POST a la URL de un webhook                                                        | `builtin:webhook-notify`  | `url`                       |
| `createFeedbackLoopPlugin()`   | `onWorthChanged`                                     | Registra el historial de worth en el estado (máx. 20)                                   | `builtin:feedback-loop`   | ninguna                     |
| `createGitVerifierPlugin()`    | `verify`                                             | Comprueba `metadata.commitSha` mediante `git cat-file`                                  | `builtin:git-verifier`    | `repoPath`                  |
| `createCalendarSyncPlugin()`   | `sync`                                               | Analiza los VEVENT de ICS → createEvent por cada evento                                 | `builtin:calendar-sync`   | `icsUrl`                    |
| `createSlackEventsPlugin()`    | manejador de eventos                                 | Convierte los eventos `message` de Slack → createEvent                                  | `builtin:slack-events`    | `webhookUrl`                |
| `createGithubEventsPlugin()`   | manejador de webhooks                                | PR → createEvent; issue.opened → createEvent + createFact                               | `builtin:github-events`   | ninguna                     |
| `createOutlineSyncPlugin()`    | `sync`                                               | Sincroniza documentos de Outline → hechos (namespace=kb)                                | `builtin:outline-sync`    | `outlineApiUrl`, `apiToken` |
| `createObsidianExportPlugin()` | utilidad                                             | Recupera todos los hechos → escribe archivos `.md` en un directorio de bóveda           | `builtin:obsidian-export` | `vaultDir`                  |
| `createClaudeImportPlugin()`   | utilidad                                             | Importa un arreglo JSON de memoria de Claude → hechos                                   | `builtin:claude-import`   | ninguna                     |
| `createEventReactionsPlugin()` | `onEventRecorded`                                    | Dispara reglas reactivas cuando los eventos coinciden con los disparadores configurados | `builtin:event-reactions` | ninguna                     |

---

## Plugin de ejemplo

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

## Pruebas

```bash
pnpm --filter @mnemo-ai/plugins test
```

Cubre los hooks, la desactivación por tiempo de espera, el estado, el análisis de la configuración y los 10 plugins integrados.
