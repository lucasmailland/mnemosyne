# InMemoryStorageAdapter Architecture

**English** · [Español](INMEMORY_ADAPTER_ARCHITECTURE.es.md)

## Overview

`InMemoryStorageAdapter` in `packages/types/src/testing/` is the primary test double for the `StorageAdapter` interface across the monorepo. It implements the complete `StorageAdapter` contract in-memory, allowing unit tests to avoid database dependencies.

As of the `decompose-inmemory-storage-adapter` change (2026-08-11), the adapter follows an **organizational decomposition** pattern: 199 `StorageAdapter` port methods are implemented as one-line delegations to functions in 32 domain-scoped modules, all sharing a single flat `InMemoryStorageState` object.

## Architecture: Flat State Object, Delegating Class

### Rationale for This Design

- **22 confirmed cross-domain methods** read 2+ collections in a single body (e.g., `getGraphSnapshot` reads 6; `getKnowledgeDistribution` reads 11), making true per-domain encapsulation impossible without circular dependencies.
- **One shared state object** makes explicit that cross-domain state access is **intentional and permitted** — a feature, not a smell.
- **No isolation semantics enforced** — reviewers and designers MUST NOT introduce artificial boundary-enforcement code (private closures, proxy objects) to simulate isolation this class does not have.
- **Organizational, not isolation** — the design trades some modularity benefit for simplicity and transparency about cross-domain coupling.

## File Layout

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

## State Object: `InMemoryStorageState`

Defined in `in-memory/state.ts`:

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

**Key properties:**

- **Flat, behaviour-free object** — no methods, only data fields
- **35 collections total** — all Map or array types matching their declarations in the original class
- **One instance per adapter** — shared by reference across all delegated method calls
- **Created by factory** — `createInMemoryStorageState()` returns a fresh instance
- **Reset verbatim** — `resetInMemoryStorageState(state)` reproduces the original `reset()` logic exactly (clears 19 of 35 collections by design)

## Delegating Class: `InMemoryStorageAdapter`

In `InMemoryStorageAdapter.ts`:

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

**Class invariants:**

- **Thin delegation only** — no business logic in the class body
- **No method body edits** — every one-liner is a verbatim transplant of the original method's form (parameter list, return type, signature)
- **`async` preserved** — delegations do NOT re-declare `async` on the class side; the called function's `async` status is what matters
- **In-place mutations preserved** — methods that mutate Map/array values in-place (e.g., `persistCompression`, `recordRecall`) are moved verbatim with no re-set-a-copy conversion
- **Public interface unchanged** — same constructor signature, same exported name, same `implements StorageAdapter`

## Cross-Domain Methods

22 method bodies read 2+ collections. These are assigned to modules based on **state coupling** (which collections they touch) or **port identity** (which port "owns" them) per design.md D4:

| Method                               | Collections                                                        | Module               | Why                                                   |
| ------------------------------------ | ------------------------------------------------------------------ | -------------------- | ----------------------------------------------------- |
| `getGraphSnapshot`                   | entities, episodes, decisions, facts, relations, semanticNeighbors | `graph.ts`           | 6-collection cross-domain read                        |
| `getKnowledgeDistribution`           | 11 collections                                                     | `workspace.ts`       | Port identity (WorkspacePort) — no single state owner |
| `updateWorth`                        | facts, hyperedges, reasonings                                      | `recall.ts`          | 3-way switch on method type                           |
| `materialiseInference`               | facts, outbox, inferences, compositionRules                        | `composition.ts`     | 4-collection cross-domain write                       |
| `resolveConflict`                    | facts, relations                                                   | `relations.ts`       | Both sources read in one body                         |
| `mergeFactByTopicKey`                | facts, embeddings, factLsh                                         | `facts.ts`           | 3-collection duplicate detection                      |
| `replaceFact`                        | facts, factLsh, queryCache, outbox, relations, factHashes          | `facts.ts`           | 6-collection fact replacement                         |
| `pointerCandidates`, `ftsCandidates` | factLsh, facts, embeddings                                         | `fact-index.ts`      | Shared state-coupling to same helpers                 |
| `getConfidenceMap`                   | entities, facts                                                    | `metacognition.ts`   | Entity+fact cross-domain query                        |
| `resolveActiveLearningReview`        | activeLearningReviewQueue, facts                                   | `active-learning.ts` | Queue+fact mutation                                   |
| `persistCompression`                 | episodes                                                           | `episodes.ts`        | Mutates stored episode object in-place                |
| `recordRecall`                       | recallLog, facts                                                   | `recall.ts`          | Hit-count side effect on facts                        |
| (and 10 others)                      | —                                                                  | —                    | —                                                     |

**All cross-domain accesses go through the shared `state` object** — no cross-module imports needed to read another module's "primary" collections. This is by design.

## Test Reach-In Properties

Some test files reach into private state via TypeScript's runtime-erased `private` modifier:

```typescript
// consolidation-merge.test.ts
(storage as unknown as { facts: Map<string, unknown> }).facts(
  // entities-link-user.test.ts
  storage as unknown as { entities: Map<string, T> }
).entities;
```

These work because:

1. **TypeScript's `private` is erased at runtime** — the cast can still access the property
2. **D5 permanent accessor** — a private getter per field (`private get facts()`, `private get entities()`) delegates to `this.state.<field>`, preserving the cast-resolvable property path

No test files were modified. All reach-in sites continue to work unmodified.

## Usage: Construction and Reset

```typescript
// Construction
const adapter = new InMemoryStorageAdapter();
await adapter.createFact({ statement: "...", sensitivity: "internal" }, workspaceId);
const fact = await adapter.getFact(factId, workspaceId);

// Reset to empty state
adapter.reset();
const empty = await adapter.getFact(factId, workspaceId); // null
```

**Note:** `reset()` clears exactly 19 of 35 collections (by design, reproducing the original `reset()` logic verbatim):

- Cleared: `sessions`, `turns`, `facts`, `decisions`, `episodes`, `entities`, `strategies`, `workflows`, `skills`, `tasks`, `events`, `reasonings`, `relations`, `citations`, `workspaceModes`, `outbox`, `auditLog`, `recallLog`, `mnemoRecallLog`
- **Not** cleared: `hyperedges`, `compositionRules`, `inferences`, `factHashes`, `factLsh`, `embeddings`, `healthSnapshots`, `semanticNeighbors`, `agentProfiles`, `queryCache`, `embeddingCache`, `consolidationReviews`, `activeLearningReviewQueue`, `webhookEndpoints`, `webhookDeliveries`, `reminders`

This asymmetry is preserved to maintain spec.md Requirement 8 (no behavior changes).

## Contract Test Suite

`packages/types/src/testing/__tests__/contract.test.ts` runs `runStorageAdapterContractTests` against `new InMemoryStorageAdapter()` with **zero assertions modified**. All 18 contract tests pass identically to the pre-decomposition version.

## Verification Scope

This design was fully verified across 26 code batches + Final Phase:

- ✅ Build (18/18 tasks, all packages)
- ✅ TypeScript type-check (28/28 tasks)
- ✅ Lint (typecheck-based and custom checks; the repo has no ESLint)
- ✅ Unit tests (30/30 test suites, 1747/1747 individual tests)
- ✅ Integration tests (no new failures — pre-existing failures confirmed unrelated via bisection)
- ✅ Hexagonal purity guards (no infrastructure imports in the new module set)
- ✅ Contract test suite (zero modifications, all green)
- ✅ Diff scope (36 files under `packages/types/src/testing/`: 35 new + 1 modified; zero changes outside)

## Adding a New Method

When adding a new port method to `StorageAdapter`:

1. **Implement the function** in the appropriate `in-memory/<domain>.ts` module:

   ```typescript
   export async function newMethod(state: InMemoryStorageState, ...args): Promise<T> {
     // Implementation
     return result;
   }
   ```

2. **Add a delegation** in `InMemoryStorageAdapter.ts`:

   ```typescript
   newMethod(...args): Promise<T> {
     return domainModule.newMethod(this.state, ...args);
   }
   ```

3. **If it touches multiple collections**, document it as a cross-domain method in this file's cross-domain table.

4. **Test against the contract** — run `pnpm --filter @mnemo-ai/types test` to verify contract-test coverage.

## References

- **Design**: `docs/archive/openspec/2026-08-11-decompose-inmemory-storage-adapter/design.md` — architecture decisions (D1-D5)
- **Specification**: `docs/archive/openspec/2026-08-11-decompose-inmemory-storage-adapter/spec.md` — requirements and acceptance scenarios
- **Implementation record**: `docs/archive/openspec/2026-08-11-decompose-inmemory-storage-adapter/apply-progress.md` — batch-by-batch execution across 26 code-shipping + Final Phase

## See Also

- [`ADD_A_STORAGE_ADAPTER.md`](./ADD_A_STORAGE_ADAPTER.md) — how to implement a different storage backend (e.g., SQLite, Redis)
- [`StorageAdapterContract.ts`](../../packages/types/src/testing/StorageAdapterContract.ts) — the contract test suite
- [`segregate-storage-ports`](../architecture/API.md) — the 39 domain sub-ports that compose `StorageAdapter`
