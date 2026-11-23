# Arquitectura de InMemoryStorageAdapter

[English](INMEMORY_ADAPTER_ARCHITECTURE.md) · **Español**

## Resumen

`InMemoryStorageAdapter`, en `packages/types/src/testing/`, es el doble de pruebas principal de la interfaz `StorageAdapter` en todo el monorepo. Implementa el contrato completo de `StorageAdapter` en memoria, lo que permite que las pruebas unitarias eviten depender de una base de datos.

Desde el cambio `decompose-inmemory-storage-adapter` (2026-08-11), el adaptador sigue un patrón de **descomposición organizativa**: los 199 métodos del puerto `StorageAdapter` se implementan como delegaciones de una línea a funciones de 32 módulos por dominio, todos con un único objeto `InMemoryStorageState` plano compartido.

## Arquitectura: objeto de estado plano, clase delegadora

### Justificación de este diseño

- **22 métodos entre dominios confirmados** leen 2 o más colecciones en un mismo cuerpo (por ejemplo, `getGraphSnapshot` lee 6; `getKnowledgeDistribution` lee 11), lo que hace imposible un verdadero encapsulamiento por dominio sin dependencias circulares.
- **Un único objeto de estado compartido** deja claro que el acceso al estado entre dominios es **intencional y está permitido**: una característica, no un defecto.
- **No se aplica ninguna semántica de aislamiento**: quienes revisen y diseñen NO DEBEN introducir código artificial de imposición de fronteras (closures privados, objetos proxy) para simular un aislamiento que esta clase no tiene.
- **Organizativo, no de aislamiento**: el diseño cambia parte del beneficio de la modularidad por simplicidad y transparencia sobre el acoplamiento entre dominios.

## Estructura de archivos

```
packages/types/src/testing/
├── InMemoryStorageAdapter.ts       (thin delegating class, ~1419 lines)
├── in-memory/
│   ├── index.ts                    (namespace barrel export)
│   ├── state.ts                    (InMemoryStorageState interface + factory)
│   ├── support.ts                  (12 shared pure helpers/consts/types)
│   ├── decisions.ts                (6 methods)
│   ├── entities.ts                 (6 methods)
│   ├── strategies.ts               (5 methods)
│   ├── workflows.ts                (5 methods)
│   ├── skills.ts                   (5 methods)
│   ├── sessions.ts                 (11 methods)
│   ├── tasks.ts                    (7 methods)
│   ├── events.ts                   (6 methods)
│   ├── reasoning.ts                (8 methods)
│   ├── episodes.ts                 (9 methods)
│   ├── anticipation.ts             (5 stubs)
│   ├── neuro-dynamics.ts           (5 stubs)
│   ├── embedding-maintenance.ts    (5 stubs/lifecycle)
│   ├── lifecycle.ts                (3 methods)
│   ├── audit.ts                    (2 methods)
│   ├── metrics.ts                  (6 methods)
│   ├── hyperedges.ts               (6 methods)
│   ├── agent.ts                    (5 methods)
│   ├── metacognition.ts            (4 methods)
│   ├── query-cache.ts              (4 methods)
│   ├── active-learning.ts          (4 methods)
│   ├── outbox.ts                   (7 methods)
│   ├── webhooks.ts                 (10 methods)
│   ├── reminders.ts                (5 methods)
│   ├── composition.ts              (9 methods)
│   ├── fact-index.ts               (5 methods + 2 private helpers + 2 test-only helpers)
│   ├── recall.ts                   (10 methods)
│   ├── relations.ts                (7 methods)
│   ├── graph.ts                    (3 methods + 1 private helper)
│   ├── workspace.ts                (7 methods)
│   └── consolidation.ts            (6 methods + 3 private helpers)
└── StorageAdapterContract.ts       (contract test suite, unchanged)
```

## Objeto de estado: `InMemoryStorageState`

Definido en `in-memory/state.ts`:

```typescript
export interface InMemoryStorageState {
  sessions: Map<string, MnemoSession>;
  turns: SessionTurn[];
  facts: Map<string, MnemoFact>;
  decisions: Map<string, MnemoDecision>;
  episodes: Map<string, MnemoEpisode>;
  entities: Map<string, MnemoEntity>;
  strategies: Map<string, MnemoStrategy>;
  workflows: Map<string, MnemoWorkflow>;
  skills: Map<string, MnemoSkill>;
  tasks: Map<string, MnemoTask>;
  events: Map<string, MnemoEvent>;
  reasonings: Map<string, MnemoReasoning>;
  relations: Map<string, RelationRow>;
  citations: AggregatedCitation[];
  workspaceModes: Map<string, WorkspaceModeRow>;
  outbox: OutboxEntry[];
  auditLog: AuditLogEntry[];
  recallLog: RecallLogEntry[];
  mnemoRecallLog: RecallLogEntry[];
  // ... plus 16 more collections (hyperedges, compositionRules, inferences, etc.)
}
```

**Propiedades clave:**

- **Objeto plano y sin comportamiento**: sin métodos, solo campos de datos
- **35 colecciones en total**: todas de tipo Map o array, que coinciden con sus declaraciones en la clase original
- **Una instancia por adaptador**: compartida por referencia en todas las llamadas de métodos delegados
- **Creado por una factoría**: `createInMemoryStorageState()` devuelve una instancia nueva
- **Reinicio literal**: `resetInMemoryStorageState(state)` reproduce exactamente la lógica original de `reset()` (borra 19 de las 35 colecciones por diseño)

## Clase delegadora: `InMemoryStorageAdapter`

En `InMemoryStorageAdapter.ts`:

```typescript
export class InMemoryStorageAdapter implements StorageAdapter {
  readonly capabilities: StorageCapabilities = { ... };
  private state = createInMemoryStorageState();

  reset(): void {
    resetInMemoryStorageState(this.state);
  }

  // 199 one-line delegations (D7 move-only rule)
  createFact(input, workspaceId) {
    return facts.createFact(this.state, input, workspaceId);
  }
  // ... 198 more delegations, each shaped identically

  // 6 D5 read-through accessors (for internal test reach-ins):
  //  - 5 public getters (outbox, auditLog, recallLog, consolidationReviews, activeLearningReviewQueue)
  //  - 1 private getter (facts, for consolidation-merge.test.ts reach-in)
  //  - 1 private getter (entities, for entities-link-user.test.ts reach-in)
  get outbox(): OutboxEntry[] { return this.state.outbox; }
  private get facts(): Map<string, MnemoFact> { return this.state.facts; }
  // ... (6 total)
}
```

**Invariantes de la clase:**

- **Solo delegación delgada**: sin lógica de negocio en el cuerpo de la clase
- **Sin ediciones en los cuerpos de los métodos**: cada línea es un trasplante literal de la forma del método original (lista de parámetros, tipo de retorno, firma)
- **`async` se conserva**: las delegaciones NO vuelven a declarar `async` en la clase; lo que importa es el estado `async` de la función a la que se llama
- **Las mutaciones en el lugar se conservan**: los métodos que mutan valores de Map o de arrays en el lugar (por ejemplo, `persistCompression`, `recordRecall`) se mueven tal cual, sin convertirlos a «volver a asignar una copia»
- **Interfaz pública sin cambios**: misma firma del constructor, mismo nombre exportado, mismo `implements StorageAdapter`

## Métodos entre dominios

22 cuerpos de métodos leen 2 o más colecciones. Se asignan a módulos según el **acoplamiento de estado** (qué colecciones tocan) o la **identidad del puerto** (qué puerto «es dueño» de ellos), conforme a design.md D4:

| Método                               | Colecciones                                                        | Módulo               | Por qué                                                             |
| ------------------------------------ | ------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------- |
| `getGraphSnapshot`                   | entities, episodes, decisions, facts, relations, semanticNeighbors | `graph.ts`           | Lectura entre dominios de 6 colecciones                             |
| `getKnowledgeDistribution`           | 11 colecciones                                                     | `workspace.ts`       | Identidad del puerto (WorkspacePort): ningún dueño único del estado |
| `updateWorth`                        | facts, hyperedges, reasonings                                      | `recall.ts`          | Switch de 3 vías según el tipo de método                            |
| `materialiseInference`               | facts, outbox, inferences, compositionRules                        | `composition.ts`     | Escritura entre dominios de 4 colecciones                           |
| `resolveConflict`                    | facts, relations                                                   | `relations.ts`       | Ambas fuentes se leen en un mismo cuerpo                            |
| `mergeFactByTopicKey`                | facts, embeddings, factLsh                                         | `facts.ts`           | Detección de duplicados en 3 colecciones                            |
| `replaceFact`                        | facts, factLsh, queryCache, outbox, relations, factHashes          | `facts.ts`           | Reemplazo de hecho en 6 colecciones                                 |
| `pointerCandidates`, `ftsCandidates` | factLsh, facts, embeddings                                         | `fact-index.ts`      | Acoplamiento de estado compartido con los mismos helpers            |
| `getConfidenceMap`                   | entities, facts                                                    | `metacognition.ts`   | Consulta entre dominios de entidades y hechos                       |
| `resolveActiveLearningReview`        | activeLearningReviewQueue, facts                                   | `active-learning.ts` | Mutación de cola y hechos                                           |
| `persistCompression`                 | episodes                                                           | `episodes.ts`        | Muta en el lugar el objeto de episodio almacenado                   |
| `recordRecall`                       | recallLog, facts                                                   | `recall.ts`          | Efecto secundario de conteo de aciertos sobre los hechos            |
| (and 10 others)                      | —                                                                  | —                    | —                                                                   |

**Todos los accesos entre dominios pasan por el objeto `state` compartido**: no hacen falta importaciones entre módulos para leer las colecciones «principales» de otro módulo. Es intencional.

## Propiedades de acceso para pruebas

Algunos archivos de prueba acceden al estado privado mediante el modificador `private` de TypeScript, que se borra en tiempo de ejecución:

```typescript
// consolidation-merge.test.ts
(storage as unknown as { facts: Map<string, unknown> }).facts(
  // entities-link-user.test.ts
  storage as unknown as { entities: Map<string, T> }
).entities;
```

Esto funciona porque:

1. **`private` de TypeScript se borra en tiempo de ejecución**: el cast todavía puede acceder a la propiedad
2. **Accesor permanente D5**: un getter privado por campo (`private get facts()`, `private get entities()`) delega en `this.state.<field>` y conserva la ruta de propiedad que el cast puede resolver

No se modificó ningún archivo de prueba. Todos los puntos de acceso siguen funcionando sin cambios.

## Uso: construcción y reinicio

```typescript
// Construction
const adapter = new InMemoryStorageAdapter();
await adapter.createFact({ statement: "...", sensitivity: "internal" }, workspaceId);
const fact = await adapter.getFact(factId, workspaceId);

// Reset to empty state
adapter.reset();
const empty = await adapter.getFact(factId, workspaceId); // null
```

**Nota:** `reset()` borra exactamente 19 de las 35 colecciones (por diseño, para reproducir literalmente la lógica original de `reset()`):

- Se borran: `sessions`, `turns`, `facts`, `decisions`, `episodes`, `entities`, `strategies`, `workflows`, `skills`, `tasks`, `events`, `reasonings`, `relations`, `citations`, `workspaceModes`, `outbox`, `auditLog`, `recallLog`, `mnemoRecallLog`
- **No** se borran: `hyperedges`, `compositionRules`, `inferences`, `factHashes`, `factLsh`, `embeddings`, `healthSnapshots`, `semanticNeighbors`, `agentProfiles`, `queryCache`, `embeddingCache`, `consolidationReviews`, `activeLearningReviewQueue`, `webhookEndpoints`, `webhookDeliveries`, `reminders`

Esta asimetría se conserva para mantener el requisito 8 de spec.md (sin cambios de comportamiento).

## Suite de pruebas del contrato

`packages/types/src/testing/__tests__/contract.test.ts` ejecuta `runStorageAdapterContractTests` contra `new InMemoryStorageAdapter()` con **cero aserciones modificadas**. Las 18 pruebas del contrato pasan de forma idéntica a la versión previa a la descomposición.

## Alcance de la verificación

Este diseño se verificó por completo a lo largo de 26 lotes de código + la fase final:

- ✅ Compilación (18/18 tareas, todos los paquetes)
- ✅ Verificación de tipos de TypeScript (28/28 tareas)
- ✅ Lint (chequeos basados en el typecheck y chequeos propios; el repo no usa ESLint)
- ✅ Pruebas unitarias (30/30 suites de pruebas, 1747/1747 pruebas individuales)
- ✅ Pruebas de integración (sin fallos nuevos: se confirmó por bisección que los fallos preexistentes no están relacionados)
- ✅ Guardas de pureza hexagonal (sin importaciones de infraestructura en el nuevo conjunto de módulos)
- ✅ Suite de pruebas del contrato (sin modificaciones, todo en verde)
- ✅ Alcance del diff (36 archivos en `packages/types/src/testing/`: 35 nuevos + 1 modificado; cero cambios fuera de esa ruta)

## Añadir un método nuevo

Cuando añadas un método de puerto nuevo a `StorageAdapter`:

1. **Implementa la función** en el módulo `in-memory/<domain>.ts` que corresponda:

   ```typescript
   export async function newMethod(state: InMemoryStorageState, ...args): Promise<T> {
     // Implementation
     return result;
   }
   ```

2. **Añade una delegación** en `InMemoryStorageAdapter.ts`:

   ```typescript
   newMethod(...args): Promise<T> {
     return domainModule.newMethod(this.state, ...args);
   }
   ```

3. **Si toca varias colecciones**, documéntalo como un método entre dominios en la tabla de métodos entre dominios de este archivo.

4. **Prueba contra el contrato**: ejecuta `pnpm --filter @mnemo-ai/types test` para verificar la cobertura de las pruebas del contrato.

## Referencias

- **Diseño**: `docs/archive/openspec/2026-08-11-decompose-inmemory-storage-adapter/design.md`: decisiones de arquitectura (D1-D5)
- **Especificación**: `docs/archive/openspec/2026-08-11-decompose-inmemory-storage-adapter/spec.md`: requisitos y escenarios de aceptación
- **Registro de implementación**: `docs/archive/openspec/2026-08-11-decompose-inmemory-storage-adapter/apply-progress.md`: ejecución lote por lote a lo largo de 26 lotes de código + fase final

## Véase también

- [`ADD_A_STORAGE_ADAPTER.md`](./ADD_A_STORAGE_ADAPTER.es.md): cómo implementar un backend de almacenamiento distinto (por ejemplo, SQLite, Redis)
- [`StorageAdapterContract.ts`](../../packages/types/src/testing/StorageAdapterContract.ts): la suite de pruebas del contrato
- [`segregate-storage-ports`](../architecture/API.es.md): los 39 subpuertos de dominio que componen `StorageAdapter`
