# Mnemosyne — GitHub Copilot Instructions

**Primary reference: `CLAUDE.md` in the repo root.** Read it before suggesting any code. It contains verified facts about primitives, relation verbs, security invariants, CI commands, and common LLM traps. Do not override it with training-data memory.

**Implementation status: `docs/STATUS.md`** — what is working, partial or missing.

---

## CI gate — suggest code that passes all three

```bash
pnpm typecheck   # TypeScript across all 18 workspace packages
pnpm build       # all packages build cleanly
pnpm test        # unit tests + hexagonal purity guards + migration sequence guard
```

Note: there is NO `pnpm lint:hexagonal` script. The purity and migration-sequence guards are vitest tests that run as part of `pnpm test`; `pnpm lint:migrations` is the separate SQL linter. `pnpm lint` is typecheck-based and custom checks only (no ESLint).

---

## 5 non-negotiable rules

### 1 — `packages/core/src/` has zero infrastructure imports

Never suggest importing `drizzle-orm`, `postgres`, `pg`, `ioredis`, `redis`, or `@neondatabase` anywhere in `packages/core/src/` (the engine lives in `packages/core/src/cognitive/`). The guard scans all of `packages/core/src` except tests and four allowlisted files (`tx.ts`, `api-key-lookup.ts`, `cli/migrate.ts`, `db/types.ts`). All I/O goes through port interfaces in `@mnemo-ai/types` injected via `CoreContext`.

Purity guard tests:

- `packages/types/src/__tests__/purity.test.ts`
- `packages/core/src/__tests__/v3-purity.test.ts`

### 2 — All `mnemo_*` queries MUST go through `withMnemoTx(workspaceId, fn)`

Every `mnemo_*` table has `ENABLE ROW LEVEL SECURITY` AND `FORCE ROW LEVEL SECURITY`. Without `withMnemoTx`, queries run under the superuser role, bypassing RLS silently and leaking data across workspaces.

```typescript
import { withMnemoTx } from "@mnemo-ai/core";
await withMnemoTx(workspaceId, async (tx) => {
  return await storage.queryFacts({ workspaceId }, tx);
});
```

### 3 — Sensitivity ceiling uses `SENSITIVITY_ORDER` numeric map — NEVER string equality (MED-23)

```typescript
// ✅ Correct
import { SENSITIVITY_ORDER } from "@mnemo-ai/types";
SENSITIVITY_ORDER[a] >= SENSITIVITY_ORDER[b];

// ❌ Wrong — alphabetic order ≠ sensitivity order
"confidential" > "internal";
```

### 4 — Sensitivity ceiling violations return 404, not 403

Do not confirm that the resource exists. Return 404 on ceiling violations (anti-probing).

### 5 — The 9 relation verbs are locked — do not suggest new ones

```
related | compatible | scoped | conflicts_with | supersedes
not_conflict | derived_from | part_of | member_of
```

Defined in `packages/types/src/relations.ts`. Enforced by SQL CHECK in `packages/adapter-postgres/migrations/baseline/0001_v3_complete_baseline.sql`. Adding a new verb requires a migration to update the constraint.

---

## Verified enums — do not invent values

**Fact kind** (13): `"preference" | "trait" | "event" | "relationship" | "skill" | "concern" | "architecture" | "bugfix" | "config" | "discovery" | "policy" | "process" | "other"`

**Decision kind** (8): `"decision" | "architecture" | "policy" | "process" | "bugfix" | "learning" | "discovery" | "config"`

**Entity kind** (6): `"person" | "organization" | "project" | "concept" | "place" | "other"`

**Primitives** (10): `fact | decision | episode | entity | strategy | workflow | skill | task | event | reasoning`

Source: `packages/types/src/primitives.ts`
