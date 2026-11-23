# @mnemo-ai/core

[English](README.md) · **Español**

> **Puntero para IA:** motor cognitivo puro: sin E/S y sin importaciones de infraestructura en src/v3/. Toda la E/S pasa por interfaces de puertos inyectadas mediante CoreContext.
>
> **Depende de:** solo @mnemo-ai/types (en src/v3/). El código heredado de v2 fuera de v3/ tiene deuda documentada con drizzle.
>
> **Expone:** recallCold, recallHot, remember, forget, withMnemoTx, collapseSession, CLI mnemo-migrate
>
> **Estado:** STABLE (zona v3); ALPHA (extracción de sesiones, consolidación sin conectar)
>
> **Ver también:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [docs/internals/ALGORITHMS.md](../../docs/internals/ALGORITHMS.md)

La piedra angular de la pila de Mnemosyne. Todo lo demás (`@mnemo-ai/server`, `@mnemo-ai/mcp`, `@mnemo-ai/client-ts`) se construye sobre él.

## Qué contiene este paquete

- **`createCore(deps, config?)`** (`@mnemo-ai/core/cognitive`) — la fábrica principal. Recibe puertos inyectados (`storage`, `vector`, `embed`, `outbox`, `logger`, `telemetry`, …) y devuelve un objeto `MnemoCore` con `remember`/`recall`/`forget`/`collapseSession`/etc.
- **Primitivas cognitivas** — `mnemo_fact`, `mnemo_decision`, `mnemo_entity`, `mnemo_episode`, `mnemo_relation`, `mnemo_citation`, `mnemo_strategy`, cada una con su propia clase de decaimiento y su papel en el grafo.
- **Recuperación híbrida de 7 etapas** — léxica de texto completo (`ts_rank_cd`) + coseno denso `halfvec(1536)` + BFS del Memory Graph + reordenación opcional basada en LLM. Expansión de consultas con HyDE. Nivel caliente mediante un conjunto ordenado ACT-R.
- **Pipeline de sesiones** — `startSession`, `appendTurn`, `collapseSession`: las conversaciones se convierten en recuerdos estructurados.
- **Hechos bitemporales** — cada hecho lleva `valid_time` (un rango: cuándo es verdadero en el mundo) y `transaction_time` (cuándo lo supo el sistema). `forget()` cierra los rangos de validez; el historial nunca se destruye.
- **Aislamiento RLS** — `withMnemoTx(workspaceId, fn)` abre una transacción que establece `app.workspace_id` y rebaja el rol a `app_user`. `FORCE ROW LEVEL SECURITY` de Postgres garantiza el aislamiento en la capa de la base de datos.
- **Detección y redacción de PII** — compuerta basada en expresiones regulares antes de que cualquier dato llegue al pipeline de embeddings.
- **Detección de envenenamiento** — compuerta de ingesta previa al embedding.
- **Memory Graph** — `buildGraphData()` / `buildGraphQuery()` para materializar el grafo tipado de entidades, episodios y decisiones de un espacio de trabajo.
- **CLI `mnemo-migrate`** — aplica las migraciones SQL incluidas en cualquier base de datos Postgres.

## Exportaciones principales

```typescript
// Cognitive engine (primary entry point — @mnemo-ai/core/cognitive)
export { createCore } from "@mnemo-ai/core/cognitive";
export type { MnemoCore, CoreDeps, CoreConfig } from "@mnemo-ai/core/cognitive";

// Auth bootstrap (@mnemo-ai/core)
export { createApiKeyLookup, assertSafeDbRole } from "@mnemo-ai/core";

// RLS transaction helper
export { withMnemoTx } from "@mnemo-ai/core";

// Legacy v1/v2 modules (entity/episode/citation/graph/review/consolidation/
// primitives/…) remain exported from the package root for backward
// compatibility but have no in-repo caller as of flatten-legacy-dual-core
// Phase 7 — @mnemo-ai/server's HTTP routes are 100% on the cognitive engine
// + @mnemo-ai/adapter-postgres's StorageAdapter.
```

## Instalación

```bash
pnpm add @mnemo-ai/core
```

Dependencias entre pares (solo si usas directamente la superficie de Drizzle/postgres.js):

```bash
pnpm add drizzle-orm postgres
```

## Inicio rápido

`createCore` recibe puertos inyectados en lugar de un simple `databaseUrl`: consulta
`@mnemo-ai/adapter-postgres`, `@mnemo-ai/adapter-vector` y
`@mnemo-ai/server/src/index.ts` para ver la conexión real. Forma mínima:

```ts
import { createCore } from "@mnemo-ai/core/cognitive";
import { DrizzleStorageAdapter, createDrizzleClient } from "@mnemo-ai/adapter-postgres";
import { PgVectorAdapter } from "@mnemo-ai/adapter-vector";

const { db, pgClient } = createDrizzleClient(process.env.DATABASE_URL!);
const storage = new DrizzleStorageAdapter(db, pgClient);
const vector = new PgVectorAdapter({ connectionString: process.env.DATABASE_URL! });

const cognitive = createCore({
  storage,
  vector,
  embed: myEmbedAdapter,
  outbox: myOutboxAdapter,
  logger: myLogger,
  telemetry: myTelemetry,
});

const auth = {
  workspaceId: "ws_acme",
  actorId: "agent:support",
  actorType: "agent",
  scopes: ["memory:write", "memory:read"],
};

// Remember something
const result = await cognitive.remember(
  {
    statement: "Acme Corp prefers communication in Spanish.",
    subject: "client:acme",
    kind: "preference",
    confidence: 0.9,
    sensitivity: "internal",
  },
  auth
);

// Recall with the 7-stage hybrid pipeline
const { hits } = await cognitive.recall(
  { text: "what language should we use with Acme?", limit: 10 },
  auth
);

// Session pipeline — collapse a session's turns into durable knowledge
const outcome = await cognitive.collapseSession({ sessionId, workspaceId: "ws_acme" }, auth);
```

## API — interfaz `MnemoCore`

| Método                                                  | Devuelve                          | Descripción                                                        |
| ------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| `remember(req, auth)`                                   | `Promise<RememberResponse>`       | Almacena un hecho, decisión o estrategia con la compuerta de conflicto y sorpresa del §33 |
| `recall(query, auth)`                                   | `Promise<RecallResponse>`         | Cascada de búsqueda híbrida de 7 etapas                            |
| `recallHot(workspaceId, auth, limit?)`                  | `Promise<RecallHit[]>`            | Solo consulta del nivel caliente (ACT-R)                           |
| `forget(id, kind, mode, auth, reason?)`                 | `Promise<void>`                   | Borrado bitemporal lógico o físico                                 |
| `updateWorth(id, kind, delta, auth)`                    | `Promise<void>`                   | Actualización de la señal de valor Beta-Bernoulli                  |
| `updateRelationStrength(relationId, reinforced, auth)`  | `Promise<void>`                   | Actualización hebbiana del peso de co-recuperación                 |
| `collapseSession(args, auth)`                           | `Promise<CollapseSessionOutcome>` | Colapsa la sesión → extrae hechos (pipeline de 8 pasos)           |
| `propagateGovernanceForSession(workspaceId, sessionId)` | `Promise<void>`                   | Propagación de crédito de gobernanza del §11                       |

## Arranque de la autenticación

```ts
import { createApiKeyLookup, assertSafeDbRole } from "@mnemo-ai/core";

// API-key lookup (used by @mnemo-ai/server's auth middleware)
const apiKeys = createApiKeyLookup({ databaseUrl: "postgres://..." });

// Safety check — rejects superuser / bypassrls connections
await assertSafeDbRole({ databaseUrl: "postgres://..." });
```

## Transacciones RLS

Para quienes llaman y acceden a Postgres directamente (consultas personalizadas, migraciones, herramientas de administración):

```ts
import { withMnemoTx } from "@mnemo-ai/core";

const result = await withMnemoTx("workspace_123", async (tx) => {
  // `tx` is a Drizzle transaction with:
  //   SET LOCAL app.workspace_id = 'workspace_123'
  //   SET LOCAL ROLE app_user
  // All RLS policies are now enforced — even for superuser connections.
  return tx.select().from(schema.mnemo_fact);
});
```

## Niveles de sensibilidad

Cada hecho lleva un nivel de `sensitivity`. El orden numérico es:

| Nivel          | Numérico | Significado            |
| -------------- | ------- | ---------------------- |
| `public`       | 0       | Visible para todos los agentes |
| `internal`     | 1       | Solo miembros del espacio de trabajo |
| `confidential` | 2       | Concedido explícitamente |
| `restricted`   | 3       | Lista de permitidos estricta |

Las comprobaciones de techo siempre usan comparación numérica, nunca igualdad de cadenas. Una violación del techo devuelve 404 (no 403) para evitar el sondeo de tenants.

## Detección de PII

```ts
import { detectPII, redactPII } from "@mnemo-ai/core";

const result = detectPII("Call me at 555-0100 or john@example.com");
// { hasPII: true, categories: ["phone", "email"], matches: [...] }

const redacted = redactPII("Call me at 555-0100 or john@example.com");
// "Call me at [PHONE] or [EMAIL]"
```

## Migración

Aplica las migraciones incluidas en cualquier base de datos Postgres:

```bash
DATABASE_URL=postgres://... pnpx mnemo-migrate
```

## Principios de diseño

- **Frontera hexagonal** — `packages/core/src/cognitive/` no tiene ninguna importación de `drizzle-orm`, `pg`, `redis` ni de ningún paquete de infraestructura. Toda la E/S pasa por puertos inyectados. Lo hace cumplir una prueba de CI (`v3-purity.test.ts`); una lista de excepciones pequeña, documentada y permanente (`tx.ts`, `api-key-lookup.ts`) cubre los dos archivos que legítimamente son dueños de la infraestructura de RLS y autenticación.
- **TypeScript estricto + `noUncheckedIndexedAccess`** — sin `any` en los tipos públicos.
- **Sin importaciones profundas desde los consumidores** — todo pasa por `src/index.ts` o por exportaciones de subruta documentadas.
- **RLS es estructural, no consultivo** — `FORCE ROW LEVEL SECURITY` + `withMnemoTx` hacen que el aislamiento se mantenga incluso frente a una conexión de superusuario o a una cláusula `WHERE` omitida.

## Licencia

Apache-2.0 — consulta [LICENSE](../../LICENSE).
