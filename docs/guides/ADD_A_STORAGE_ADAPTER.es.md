# Cómo añadir un nuevo StorageAdapter

[English](ADD_A_STORAGE_ADAPTER.md) · **Español**

## 1. Cuándo escribir un adaptador nuevo

Escribe un adaptador nuevo cuando necesites un **backend de almacenamiento fundamentalmente distinto**, por ejemplo:

- **SQLite** para despliegues en el borde o embebidos (sin Postgres disponible)
- **En memoria** para pruebas unitarias que deben ejecutarse sin base de datos

NO escribas un adaptador nuevo solo para apuntar a otra instancia de Postgres. Pasa otro `DATABASE_URL` a `createDrizzleClient` en `DrizzleStorageAdapter`: para eso exactamente está diseñado.

---

## 2. La interfaz StorageAdapter

Está definida en `packages/types/src/ports.ts`, en `export type StorageAdapter`. A partir del cambio
`segregate-storage-ports`, `StorageAdapter` se declara como una intersección de 43 subpuertos de dominio con nombre
(`SessionPort`, `FactPort`, `RelationPort`, `WebhookPort`, `LifecyclePort`, …); el conjunto plano de miembros no
cambia, así que implementar `StorageAdapter` sigue significando implementar todos los métodos que se listan abajo
exactamente igual que antes. Cada subpuerto se exporta por separado desde `@mnemo-ai/types` y es el **tipo de
dependencia recomendado para los consumidores nuevos** que solo necesiten una parte de la superficie de
almacenamiento; por ejemplo, una ruta que solo lee hechos puede depender de `FactPort` en lugar de todo
`StorageAdapter`, lo que reduce lo que hay que simular en las pruebas y lo que puede romper por accidente.
Los consumidores existentes (adaptadores, despachadores del núcleo, rutas ya tipadas contra `StorageAdapter`)
requieren **cero cambios**: la intersección se resuelve en el mismo tipo estructural, de modo que
`implements StorageAdapter` y `storage: StorageAdapter` siguen compilando sin modificaciones.

**Capacidades** (declara qué admite tu backend):

| Campo            | Significado                                    |
| ---------------- | -------------------------------------------- |
| `vectorSearch`   | Puede buscar por vectores de embeddings |
| `ftsSearch`      | Admite búsqueda de texto completo |
| `bitemporal`     | Registra intervalos `valid_from` / `valid_to` |
| `graphExpansion` | Puede recorrer relaciones |
| `transactions`   | Admite transacciones atómicas de varias escrituras |
| `rls`            | Aplica aislamiento de espacios de trabajo en la capa de la base de datos |

**Métodos obligatorios** (agrupados):

- **Sesión**: `createSession`, `appendTurn`, `listTurns`, `closeSession`, `getSession`
- **Hechos**: `createFact`, `getFact`, `updateFact`, `archiveFact`, `queryFacts`
- **Decisiones / Episodios / Entidades / Estrategias / Flujos de trabajo / Habilidades / Tareas / Eventos / Razonamiento**: cada uno sigue el mismo patrón de cuatro métodos: `create`, `get`, `update/archive`, `query`
- **Relaciones**: `createRelation`, `getRelations`, `updateRelationStrength`, `deleteRelation`
- **Gobernanza del valor (worth)**: `updateWorth`, `recordRecall` — contabilidad TD(λ)
- **Auditoría** (solo añadir): `appendAuditEntry`
- **Outbox** (efectos secundarios transaccionales): `appendOutbox`, `claimOutbox`, `markOutboxProcessed`, `markOutboxFailed`, `reapDeadLetters`, `purgeOutbox`
- **Ciclo de vida**: `healthCheck`, `close`

**Invariantes del contrato** que todo adaptador debe cumplir:

- `getFact(id, workspaceA)` devuelve `null` cuando el hecho pertenece a `workspaceB`
- La sensibilidad es `"internal"` por defecto cuando no se establece
- El `confidence` decimal no debe truncarse (guárdalo como REAL/NUMERIC, no como INTEGER)
- Las entradas del outbox deben ser observables inmediatamente después de `createFact` (en la misma transacción)
- `healthCheck()` nunca debe lanzar una excepción

---

## 3. Paso a paso: implementar el adaptador

### 3a. Crea el paquete (o un solo archivo)

Para un adaptador autocontenido, basta con un solo archivo:

```
packages/adapter-sqlite/src/SqliteStorageAdapter.ts
```

### 3b. Esqueleto

```typescript
import type {
  StorageAdapter,
  StorageCapabilities,
  CreateFactInput,
  // ... all other Input / Filter types
} from "@mnemo-ai/types";

export class SqliteStorageAdapter implements StorageAdapter {
  readonly capabilities: StorageCapabilities = {
    vectorSearch: false,
    ftsSearch: false,
    bitemporal: false,
    graphExpansion: false,
    transactions: true,
    rls: false, // enforce isolation in application code instead
  };

  // ── Facts ────────────────────────────────────────────────────────────────────
  async createFact(input: CreateFactInput) {
    // 1. Generate a cuid2 id (import { createId } from "@paralleldrive/cuid2")
    // 2. Default input.sensitivity to "internal" if not set
    // 3. Insert the row, atomically append an outbox entry in the same tx
    // 4. Return the full MnemoFact object
    throw new Error("not implemented");
  }

  async getFact(id: string, workspaceId: string) {
    // Return null — not throw — when the row is missing OR belongs to a different workspace
    throw new Error("not implemented");
  }

  // ... implement all remaining methods following the same pattern ...

  async healthCheck() {
    try {
      // run a trivial no-op query
      return { status: "ok" as const, latencyMs: 0 };
    } catch {
      return { status: "down" as const, latencyMs: -1 };
    }
  }

  async close() {
    /* close DB connection */
  }
}
```

**Consejo**: copia `InMemoryStorageAdapter` de `packages/types/src/testing/InMemoryStorageAdapter.ts` como esqueleto de partida: implementa todos los métodos y resuelve los casos límite delicados (paginación, aislamiento de espacios de trabajo sin RLS a nivel de base de datos, captura del outbox).

---

## 4. Ejecuta la suite de pruebas de contrato

Las pruebas de contrato están en `packages/types/src/testing/StorageAdapterContract.ts`. Verifican todas las invariantes listadas en el §2 anterior.

En el archivo de pruebas de tu adaptador:

```typescript
// packages/adapter-sqlite/src/__tests__/SqliteStorageAdapter.contract.test.ts
import { runStorageAdapterContractTests } from "@mnemo-ai/types/testing";
import { SqliteStorageAdapter } from "../SqliteStorageAdapter.js";

runStorageAdapterContractTests(() => new SqliteStorageAdapter(":memory:"));
```

Ejecuta:

```bash
pnpm --filter @mnemo-ai/adapter-sqlite test
```

Todas las pruebas deben pasar antes de dar el adaptador por terminado. Los fallos más comunes son:

- Aislamiento entre espacios de trabajo (`RLS: workspace A cannot read workspace B facts`)
- Truncamiento de decimales (`worth is a decimal`)
- Falta de la entrada del outbox en `createFact`

---

## 5. Conecta el adaptador

La raíz de composición es `packages/server/src/deps.ts`, pero compone un `CoreLike`, no `StorageAdapter` directamente. `@mnemo-ai/core` consume el `StorageAdapter` a través de `CoreContext.storage`.

En el arranque de tu servidor (por ejemplo, `server.ts` o `main.ts`):

```typescript
import { SqliteStorageAdapter } from "@mnemo-ai/adapter-sqlite";
import { createCore } from "@mnemo-ai/core";

const storage = new SqliteStorageAdapter("./mnemosyne.db");

const core = createCore({
  storage,
  // ... vector, embed, outbox, logger, telemetry, config
});

const server = createServer({ core, apiKeys, embedModel: "..." });
```

El tipo `CoreContext` (definido en `packages/core/src/v3/context.ts`) acepta cualquier valor que cumpla la interfaz `StorageAdapter`: no hace falta importar ninguna clase concreta.

---

## 6. Qué NO hacer

- **No importes de `drizzle-orm/postgres-js` ni de `redis` dentro de tu adaptador**: son detalles de implementación de los adaptadores de Postgres y Redis. Tu adaptador solo debe depender de `@mnemo-ai/types` más el controlador de la base de datos que elijas.
- **No importes `DrizzleStorageAdapter` para extenderlo**: el esquema de Drizzle es específico de Postgres (pgvector, JSONB, columnas GENERATE ALWAYS). Extenderlo para otra base de datos se romperá.
- **No te saltes las comprobaciones de `workspaceId`**: todos los métodos `get*` y `query*` deben filtrar por `workspaceId`. La prueba de contrato `RLS: workspace A cannot read workspace B facts` detectará una comprobación ausente, pero un predicado omitido en una ruta `query*` filtra datos en silencio en producción.
- **No omitas el outbox**: el outbox transaccional es la forma en que los indexadores posteriores (vectorial, FTS, consolidación) se enteran de los hechos nuevos. Un adaptador que crea hechos sin añadir al outbox romperá la recuperación en silencio.
