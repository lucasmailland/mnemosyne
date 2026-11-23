# How to Add a New Cognitive Primitive

**English** · [Español](ADD_A_PRIMITIVE.es.md)

> **Status: Implemented guide — verified 2026-06-13**

---

## 0. Decision: New Primitive vs. Reusing an Existing One

Before writing any code, answer these questions:

| Question | If YES → |
|---|---|
| Is this behavioral knowledge about a user/agent? | Use `MnemoFact` |
| Is this an architectural or policy choice with a rationale? | Use `MnemoDecision` |
| Is this a bounded narrative record of a session or meeting? | Use `MnemoEpisode` |
| Is this a named real-world person, org, project, or concept? | Use `MnemoEntity` |
| Is this a trigger→action heuristic the agent applies recurrently? | Use `MnemoStrategy` |
| Is this a reusable multi-step process template with ordered steps? | Use `MnemoWorkflow` |
| Is this a stored prompt template for a repeatable task? | Use `MnemoSkill` |
| Is this a tracked work item with a lifecycle and delegation chain? | Use `MnemoTask` |
| Is this an immutable audit-trail record of something that happened? | Use `MnemoEvent` |
| Is this a cached chain-of-thought (question + steps + conclusion)? | Use `MnemoReasoning` |

**Add a new primitive only when your concept cannot be expressed as a `kind` variant of any of the 10 above.** For example, adding a `kind: "concern"` to `MnemoFact` (which already exists) is always cheaper than a new table.

Decay class decisions (affect `memory_type` column and hot-tier eligibility):

| Decay class | Suitable for |
|---|---|
| `semantic` (slow) | Durable knowledge: rules, policies, templates |
| `episodic` (medium) | Temporal snapshots: sessions, entity profiles |
| `working` (fast) | Perishable action items that decay without activity |
| `immutable` | Append-only audit records (no `updatedAt`, no decay) |

---

## Checklist Overview

6 files must be modified in order:

- [ ] `packages/types/src/primitives.ts` — TypeScript interface + union update
- [ ] `packages/types/src/ports.ts` — Input/Filter types + `StorageAdapter` method group
- [ ] `packages/types/src/testing/InMemoryStorageAdapter.ts` — in-memory implementation
- [ ] `packages/adapter-postgres/migrations/v3/00<NN>_add_foo.sql` — new numbered SQL migration
- [ ] `packages/core/src/v3/remember.ts` + `forget.ts` + `recall-cold.ts` — dispatch cases
- [ ] `packages/server/src/routes/<primitive>.ts` + register in `index.ts`

Optional:

- [ ] `packages/mcp/src/tools/<primitive>.ts` + register in `packages/mcp/src/index.ts`

---

The guide is written at `docs/guides/ADD_A_PRIMITIVE.md`. Every file path, method name, interface name, SQL pattern, and pitfall was derived from reading the actual source files before writing a single line.
