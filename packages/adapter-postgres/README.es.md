# @mnemo-ai/adapter-postgres

[English](README.md) · **Español**

> **Puntero para IA:** implementa el puerto StorageAdapter mediante DrizzleORM + Postgres. También es dueño del flujo de migraciones v3 (migrations/baseline/).
>
> **Depende de:** @mnemo-ai/types, drizzle-orm, postgres
>
> **Expone:** DrizzleStorageAdapter, OutboxWorker, withWorkspace, requireWorkspace, DrizzleApiKeyStore
>
> **Estado:** STABLE
>
> **Ver también:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [docs/architecture/DATA_MODEL.md](../../docs/architecture/DATA_MODEL.md)

Adaptador de almacenamiento sobre PostgreSQL + Drizzle ORM que implementa el puerto `StorageAdapter`
de `@mnemo-ai/types`. Es la capa principal de persistencia relacional de
Mnemosyne v3: las sesiones, los turnos, los hechos, las entidades, las decisiones, los episodios y todas las
tablas relacionadas viven aquí.

---

## Posición en la arquitectura

```
@mnemo-ai/core  (StorageAdapter port)
       ↑
@mnemo-ai/adapter-postgres  (DrizzleStorageAdapter)
       ↓
PostgreSQL  (with pgvector extension, RLS enabled)
```

Este adaptador es la frontera hexagonal entre el dominio central de Mnemosyne y la
base de datos Postgres. El núcleo nunca importa Drizzle ni `postgres-js` directamente:
llama a la interfaz `StorageAdapter`, y este paquete aporta la conexión.

---

## Estado de la implementación

| Componente                    | Estado    | Notas                                                                 |
| ----------------------------- | --------- | --------------------------------------------------------------------- |
| Clase `DrizzleStorageAdapter` | Listo     | Los 6 métodos centrales están implementados                           |
| `createSession`               | Listo     | Crea una fila en mnemo_session con aislamiento por espacio de trabajo |
| `appendTurn`                  | Listo     | Inserta en mnemo_session_turn                                         |
| `listTurns`                   | Listo     | Consulta paginada sobre mnemo_session_turn                            |
| `closeSession`                | Listo     | Establece closed_at en mnemo_session                                  |
| `getSession`                  | Listo     | Obtiene una sesión por ID                                             |
| `updateFact`                  | Listo     | Upsert en mnemo_fact con los campos worth/sensitivity                 |
| Esquema de Drizzle            | Listo     | Todas las tablas mnemo_* con los tipos de columna correctos           |
| Migraciones v3                | Listo     | 70 archivos de migración en `migrations/baseline/`                    |
| Conectado al servidor en vivo | **Listo** | Se instancia al arrancar el servidor (`packages/server/src/index.ts`) |

---

## Instalación

```bash
pnpm add @mnemo-ai/adapter-postgres
```

Dependencias peer: `postgres`, `drizzle-orm`

---

## Inicio rápido

```typescript
import { DrizzleStorageAdapter } from "@mnemo-ai/adapter-postgres";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql);

const storage = new DrizzleStorageAdapter(db);

// Use via the StorageAdapter interface
const session = await storage.createSession({
  workspaceId: "ws_abc123",
  agentId: "agent_xyz",
  metadata: {},
});
```

---

## Ejecutar las migraciones

```bash
DATABASE_URL=postgres://user:pass@host:5432/dbname pnpm migrate
```

La CLI y la API programática `migrate({ databaseUrl })` requieren una conexión
directa a PostgreSQL, o una conexión de pooler en modo sesión, indicada de forma explícita. Los
poolers en modo transacción no pueden conservar la titularidad del bloqueo
consultivo (advisory lock) de sesión que usan las migraciones.

O de forma programática:

```typescript
import { migrate } from "@mnemo-ai/adapter-postgres/migrate";
await migrate({ databaseUrl: process.env.DATABASE_URL! });
```

Los archivos de migración viven en `migrations/baseline/` (0001–0062, en orden). Las migraciones aplicadas se registran en `mnemosyne.schema_migrations`, con un checksum de cada archivo. El ejecutor es idempotente: volver a ejecutarlo es seguro.

**Nunca edites una migración ya publicada.** El ejecutor se niega a arrancar cuando el checksum de un archivo ya aplicado no coincide ("modified after being applied"). Para cambiar lo que hizo una migración publicada, agrega el número siguiente con la corrección. `0060_instance_metrics.sql` se editó en el lugar una vez (ver el CHANGELOG); esa excepción es la que dio origen a esta regla.

---

## Tablas de la base de datos

Todas las tablas tienen el prefijo `mnemo_` y están limitadas por `workspace_id`.

| Tabla                | Propósito                                                           |
| -------------------- | ------------------------------------------------------------------- |
| `mnemo_fact`         | Primitivas centrales de memoria (los 10 valores de PrimitiveKind)   |
| `mnemo_entity`       | Entidades con nombre extraídas del contenido de los hechos          |
| `mnemo_session`      | Registros de conversación / ventana de contexto                     |
| `mnemo_session_turn` | Turnos individuales dentro de una sesión                            |
| `mnemo_decision`     | Registros de decisiones con justificación y resultado               |
| `mnemo_relation`     | Aristas tipadas entre entidades y hechos                            |
| `mnemo_citation`     | Atribución de la fuente de los hechos                               |
| `mnemo_episode`      | Contenedores de recuerdos episódicos                                |
| `mnemo_api_keys`     | Claves de API con hash para la autenticación del espacio de trabajo |
| `mnemo_review_queue` | Hechos marcados para revisión humana o automática                   |

---

## Seguridad a nivel de fila

Todas las tablas limitadas por tenant tienen aplicados `ENABLE ROW LEVEL SECURITY` y
`FORCE ROW LEVEL SECURITY`. Las consultas deben establecer la variable de sesión
`app.workspace_id` antes de ejecutarse, o devolverán cero filas. El adaptador
lo gestiona automáticamente mediante un middleware de Drizzle que establece la variable a partir
del `AuthContext` resuelto.

Esto significa que ni siquiera una consulta comprometida puede filtrar datos entre tenants mientras el
rol de Postgres no tenga `BYPASSRLS`.

---

## Exportaciones principales

```typescript
export { DrizzleStorageAdapter } from "./DrizzleStorageAdapter.js";
export { OutboxWorker } from "./OutboxWorker.js";
export { withWorkspace, requireWorkspace } from "./RlsMiddleware.js";
export { DrizzleApiKeyStore } from "./DrizzleApiKeyStore.js";
export * from "./schema/index.js";
```

---
