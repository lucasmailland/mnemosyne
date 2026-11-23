# Mnemosyne — LLM Coding Guide

> **For coding assistants (Claude Code, Cursor, Copilot, Codex):** This file is your primary reference. Read it before touching any code. Every fact below is verified against source files — do not override with training-data memory.

---

## Build, test, and dev commands

All commands run from the **repo root** via Turborepo. Turborepo caches results, so repeated runs are fast.

```bash
pnpm install          # install all workspace deps
pnpm build            # build all 18 workspace packages
pnpm dev              # build all packages in watch mode (parallel)
pnpm test             # run all unit tests
pnpm test:integration # run integration tests (requires Docker — see docker:up)
pnpm lint             # typecheck-based and custom checks (client-ts tsc, dashboard class check); there is no ESLint
pnpm typecheck        # TypeScript type-check across all packages
pnpm format           # Prettier write
pnpm clean            # wipe all dist/ + root node_modules

# Docker (required for integration tests and local server)
pnpm docker:up        # start Postgres + pgvector on configured ports
pnpm docker:down      # stop and remove containers
pnpm docker:build     # rebuild images from Dockerfiles
```

### Node version: 22 to develop and build, published packages still run on 20

Develop, build and test on **Node 22 (≥22.18)**: tsup 9 refuses older runtimes. CI's jobs,
the three Dockerfiles (`docker/Dockerfile.{server,migrate,dashboard}`, `node:22-alpine`),
`.nvmrc`, `.mise.toml` and root `package.json`'s `engines.node` (`>=22.18.0`) all say 22.
`pnpm test:integration` also needs it: `testcontainers` depends on `undici@8`, which calls a
webidl primitive Node 20 lacks (`TypeError: webidl.util.markAsUncloneable is not a function`
on every test file).

What the published packages need at runtime did not move: every `tsup.config.ts` still
targets `"node20"` and their `engines.node` stays `>=20.0.0`. The build tool is a
devDependency, so consumers are unaffected.

### Single-package commands

```bash
pnpm --filter @mnemo-ai/core test
pnpm --filter @mnemo-ai/core build
pnpm --filter @mnemo-ai/adapter-postgres test:integration
```

### ⚠️ typecheck requires a prior build

`pnpm typecheck` and `pnpm --filter <pkg> typecheck` resolve types from the compiled
`dist/` of each workspace package. If any dependency hasn't been built yet, tsc will
report "Cannot find module" errors for `@mnemo-ai/*` packages — **these are not real
errors in your code**.

```bash
# WRONG — will show false "Cannot find module" errors if deps aren't built
pnpm --filter @mnemo-ai/server typecheck

# CORRECT — Turborepo builds deps first via dependsOn: ["^build"]
pnpm typecheck

# CORRECT — build first, then check a single package
pnpm build && pnpm --filter @mnemo-ai/server typecheck
```

**Root cause:** the monorepo uses `moduleResolution: Bundler` with symlinked workspace
packages. TypeScript resolves types from `dist/index.d.ts`, not from source. Turborepo's
`dependsOn: ["^build"]` handles this automatically in CI and when using `pnpm typecheck`
from the root. Direct `--filter` calls skip that dependency chain.

The IDE language server shows the same stale-build errors — a full `pnpm build` from
the root clears them.

### Hexagonal-purity guard (vitest, NOT a lint script)

```bash
# Guard 1 — @mnemo-ai/types must have zero infrastructure imports
pnpm --filter @mnemo-ai/types test
# Test file: packages/types/src/__tests__/purity.test.ts

# Guard 2 — packages/core/src/ must have zero infrastructure imports
pnpm --filter @mnemo-ai/core test
# Test file: packages/core/src/__tests__/v3-purity.test.ts
# NOTE: scans all of packages/core/src except tests and four allowlisted files
# (tx.ts, api-key-lookup.ts, cli/migrate.ts, db/types.ts); an allowlist entry
# that stops importing infrastructure fails too
```

### Migration sequence guard (vitest)

```bash
pnpm --filter @mnemo-ai/adapter-postgres test
# Test file: packages/adapter-postgres/src/__tests__/migrations.test.ts
# Enforces: unique gap-free numeric prefixes in migrations/baseline/
```

⚠️ There is **no** `pnpm lint:hexagonal` script, and the migration **sequence** guard is not a lint script either — both are vitest tests. `pnpm lint:migrations` does exist, but it is the SQL linter (`scripts/lint-migrations.mjs`), not the sequence guard.

---

## The cardinal hexagonal rule

`packages/core/src/cognitive/` **MUST have zero imports** from:

- `drizzle-orm`
- `postgres` / `pg`
- `ioredis` / `redis`
- `@neondatabase`
- Any other infrastructure package

All I/O goes through port interfaces defined in `@mnemo-ai/types`. This is what makes adapters swappable and core testable in isolation. The purity guard test (above) enforces this in CI.

**How to call core correctly:**

```typescript
// ✅ Correct — inject adapters via CoreContext
import { recallCold } from "@mnemo-ai/core";
import type { CoreContext } from "@mnemo-ai/core";

// ❌ Wrong — core MUST NOT import these
import { db } from "drizzle-orm"; // violation
import postgres from "postgres"; // violation
```

---

## The 10 cognitive primitives

Verified against `packages/types/src/primitives.ts` and `DATA_MODEL.md §2`.

| #   | Primitive     | TypeScript type  | What it is                                                               |
| --- | ------------- | ---------------- | ------------------------------------------------------------------------ |
| 1   | **fact**      | `MnemoFact`      | A piece of behavioral knowledge: user preference, belief, observed trait |
| 2   | **decision**  | `MnemoDecision`  | An architectural or policy decision with full rationale                  |
| 3   | **episode**   | `MnemoEpisode`   | An episodic memory of a session or real-world event                      |
| 4   | **entity**    | `MnemoEntity`    | A person, organization, project, concept, or place                       |
| 5   | **strategy**  | `MnemoStrategy`  | A trigger→action heuristic ("when X, do Y")                              |
| 6   | **workflow**  | `MnemoWorkflow`  | A reusable multi-step process template                                   |
| 7   | **skill**     | `MnemoSkill`     | A prompt template for a repeatable task                                  |
| 8   | **task**      | `MnemoTask`      | A tracked action item with lifecycle (pending → completed)               |
| 9   | **event**     | `MnemoEvent`     | An immutable system or external event (no `updatedAt` by design)         |
| 10  | **reasoning** | `MnemoReasoning` | A stored chain-of-thought record with worth decay                        |

### Recallability — which primitives `memory_recall` can actually return

Being written and being retrievable are **not** the same thing by default — a primitive kind must be
explicitly wired into the shared recallable-kind registry before `recall()` can ever return it.

Verified against `packages/types/src/indexing.ts` (the single source of truth) and measured
end to end by the 2026-10-17 evaluation:

```typescript
// 9 of 10 — every primitive but entity is indexed on write
export const RECALLABLE_KINDS = [
  "fact",
  "decision",
  "strategy",
  "workflow",
  "skill",
  "episode",
  "task",
  "event",
  "reasoning",
];
// searched when RecallQuery.kinds is omitted
export const DEFAULT_RECALL_KINDS = [
  "fact",
  "decision",
  "strategy",
  "workflow",
  "skill",
  "episode",
];
```

- **Default recall reaches 7 of 10 kinds**: the six `DEFAULT_RECALL_KINDS` plus **entities**, which
  have their own cosine arm (`findSimilarEntities`) outside `RECALLABLE_KINDS` and are weighted ×0.85.
- **`kinds` reaches 10 of 10**: `task`, `event` and `reasoning` are indexed but returned only when
  asked for (operational records and stored chains of thought are noise on an unrelated question).
- Facts come from `ctx.vector.search` (HNSW over `mnemo_fact`); every other recallable kind from
  `storage.recallableCandidates?.()` (cosine over the kind's table, plus `ts_rank` in hybrid/lexical,
  with the same strict-then-relaxed matching as facts). All kinds rank on the same cosine — the old
  ×0.85 decision damping is gone (WP-3, RECALL-4).
- `RecallQuery.kinds` DRIVES the non-fact arm (no query for a kind not requested); it is not a post-filter.
- Adding a kind: one `PRIMITIVE_TEXT_PROJECTION` entry, its embedding + `text_lemmatized` columns, a
  `NON_FACT_RECALL_SOURCES` entry in `RecallRepository.ts`, and a `DEFAULT_RECALL_KINDS` decision.

### kind enums — verified, do not invent values

**Fact `kind`** (13 values) — from `primitives.ts:54`:

```typescript
"preference" |
  "trait" |
  "event" |
  "relationship" |
  "skill" |
  "concern" |
  "architecture" |
  "bugfix" |
  "config" |
  "discovery" |
  "policy" |
  "process" |
  "other";
```

The six from `architecture` to `process` arrived with migration 0048: they are the categories agents
file facts under. `POST /remember` stores any other `subtype` as the kind's fallback (`other` for a
fact) and says so in a `warnings` entry instead of refusing the write.

**Decision `kind`** (8 values) — from `primitives.ts:167`:

```typescript
"decision" | "architecture" | "policy" | "process" | "bugfix" | "learning" | "discovery" | "config";
```

**Entity `kind`** (6 values) — from `primitives.ts:283`:

```typescript
"person" | "organization" | "project" | "concept" | "place" | "other";
```

---

## The 9 relation verbs — locked set

Verified against `packages/types/src/relations.ts` (matches the SQL CHECK constraint in `packages/adapter-postgres/migrations/baseline/0001_v3_complete_baseline.sql`):

```typescript
export type RelationVerb =
  | "related" // generic symmetric link
  | "compatible" // known-compatible pair
  | "scoped" // A applies within scope of B
  | "conflicts_with" // A contradicts B
  | "supersedes" // A replaces B
  | "not_conflict" // explicitly not conflicting (disambiguation)
  | "derived_from" // A was extracted/inferred from B
  | "part_of" // A is a component of B
  | "member_of"; // A belongs to group B
```

**This set is locked.** These 9 verbs and only these 9 verbs are valid. The SQL CHECK constraint enforces them at the database level. Adding a new verb requires a migration that updates the constraint.

---

## Origin context — which of the four links is authoritative

The schema can express "this came from that session" in **four** places. Only one is
authoritative. Reading the wrong one is the default mistake, because all four look equally official:

| Link                                   | Integrity                | Status                     |
| -------------------------------------- | ------------------------ | -------------------------- |
| `mnemo_fact.episode_id`                | **FK** → `mnemo_episode` | **CANONICAL**              |
| `mnemo_fact.session_id`                | none                     | correlation only           |
| `mnemo_episode.source_conversation_id` | none                     | correlation only           |
| `mnemo_recall_log.session_id`          | **FK** → `mnemo_session` | valid within its own table |

**To answer "what context produced this fact", read `episode_id`.** It is the only fact→context
link with referential integrity, and the only one `preferSourceEpisode` (spec §17) consults on
every cold recall. It is written by the collapse via `linkSessionFactsToEpisode`.

The two correlation columns are un-FK'd **deliberately**, and both reasons are load-bearing:
`fact.session_id` arrives unvalidated from `POST /remember`'s body (an FK would turn a stale id
into a lost write), and `episode.source_conversation_id` receives v2 session ids from
`@mnemo-ai/cup` that have no `mnemo_session` row (an FK would break the v2→v3 migration).

This is a declared hierarchy, not an enforced constraint. Full reasoning: `DATA_MODEL.md` §4.9.

## Bitemporal model

Every fact has two independent time axes:

| Axis                 | Column                  | Meaning                                      |
| -------------------- | ----------------------- | -------------------------------------------- |
| **valid_time**       | `validFrom` / `validTo` | When the fact is true in the world           |
| **transaction_time** | `createdAt`             | When the system learned the fact (immutable) |

`validTo = NULL` means the fact is currently valid (open interval).

**`forget()` closes validity — it does NOT delete rows.**

```typescript
// Correct way to forget a fact
await forget(factId, workspaceId, ctx);
// Sets validTo = NOW() on the fact row. The row is preserved for audit purposes.
// The fact is excluded from future recall queries (validTo IS NOT NULL filter).
```

Source: `packages/core/src/cognitive/forget.ts`

---

## RLS mechanics

Every workspace-scoped `mnemo_*` table has both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.

**All workspace-scoped database operations MUST go through `withMnemoTx`:**

```typescript
import { withMnemoTx } from "@mnemo-ai/core";

const result = await withMnemoTx(workspaceId, async (tx) => {
  return await storage.queryFacts({ workspaceId }, tx);
});
```

What `withMnemoTx` does:

1. Opens a transaction
2. `SET LOCAL ROLE app_user` — downgrades from the superuser connection role, activating FORCE RLS
3. `SET LOCAL mnemosyne.workspace_id = <id>` — sets the GUC that RLS policies check
4. All queries inside `fn` are now RLS-scoped to the workspace

Without `withMnemoTx`, queries run as the connection's superuser role, which bypasses RLS. This is the most common security mistake.

Tenant-scoped tables without a single `workspace_id` are the deliberate
exception: `mnemo_tenant`, `mnemo_user`, `mnemo_tenant_member`,
`mnemo_workspace`, and `mnemo_workspace_member`. These must still run inside a
transaction and set tenant/user GUCs with `SET LOCAL` / `set_config(..., true)`
before any query. Use `withMnemoTenantTx` where the core Drizzle tx is
available, or the server tenant-route transaction helper for raw `postgres.js`.
Never run these queries with a bare pooled client.

**Auth bootstrap exception — `mnemo_api_keys`:**
`mnemo_api_keys` intentionally has NO `ENABLE ROW LEVEL SECURITY` and MUST NOT
go through `withMnemoTx`. The reason is a chicken-and-egg: `withMnemoTx` needs
a `workspaceId` to set the session GUC, but the API key lookup IS what establishes
the `workspaceId`. Isolation is enforced by the lookup_hash/bcrypt match ensuring
only the key holder can match, plus `isWorkspaceId()` validation on the returned
workspace_id. All subsequent calls after auth do go through `withMnemoTx`.
See `packages/core/src/api-key-lookup.ts` for the canonical implementation.

Source: `packages/core/src/tx.ts`

---

## Provenance identity

`actorId` was historically ambiguous — sometimes an API key's own row id,
sometimes (rarely, informally) treated as a real user id, with nothing
distinguishing the two at read time. This produced real security bugs: an
ownership-check bypass via the shared `apiKeyPrefix` constant, a dual-control
bypass in approvals/break-glass, and GDPR crypto-erasure that was
per-credential instead of per-person. Every write path now produces a single,
explicit triple instead of an ad-hoc `a ?? b ?? c` fallback chain:

```typescript
export interface ActorProvenance {
  /** WHAT kind of principal acted. Always present. */
  actorType: "agent" | "user" | "system" | "federation";
  /** WHO acted — namespaced, parseable, never a bare id. Always present. */
  actorId: ActorRef; // e.g. "key:<mnemo_api_keys.id>", "user:<mnemo_user.id>", "system:collapse", "peer:<instanceId>"
  /** The platform account behind the action, when one exists. null otherwise. */
  userId: string | null;
}
```

Source: `packages/types/src/provenance.ts` (`ActorType`, `ActorRef`,
`formatActorRef`/`parseActorRef`, `ActorProvenance`).

**Server route authors: never build a fallback chain.** Call
`resolveProvenance(c)` (`packages/server/src/provenance.ts`) and use its
`.actorId`/`.userId`/`.actorType` directly. `apiKeyPrefix` (the constant
`"mns_live_"`/`"mk_admin_"`/etc.) is **never** a valid identity — it names no
one, and `parseActorRef()` rejects it on sight.

**`mnemo_entity.linkedUserId` vs. provenance `userId` — two different
questions.** `userId` on any primitive answers "who wrote this row"
(provenance). `MnemoEntity.linkedUserId` answers a completely different
question: "who is this row **about**" (subject) — it binds a `kind: "person"`
entity to a real platform account. Only ever settable via
`POST/DELETE /entities/:id/link-user` (self-link always allowed; linking a
different user, or reassigning an entity already linked to someone else,
requires `memory:admin` + an owner/admin workspace role); never accepted on
`POST /entities` or `PATCH /entities/:id`, so an LLM can't claim an identity
by supplying the field. Unlinking is bitemporal (close + successor +
`supersedes` relation), never an in-place overwrite.

---

## Sensitivity ceiling

Sensitivity tiers are **numeric**, not string. From `packages/types/src/security.ts`:

```typescript
export const SENSITIVITY_ORDER: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

// ✅ Correct comparison
export function sensitivityAtLeast(a: Sensitivity, b: Sensitivity): boolean {
  return SENSITIVITY_ORDER[a] >= SENSITIVITY_ORDER[b];
}
```

**NEVER compare sensitivity as strings** (MED-23). `"confidential" > "internal"` is alphabetically correct but semantically wrong.

On ceiling violations: return **404, not 403** (anti-probing — do not confirm the resource exists).

---

## Security invariants — non-negotiable

These invariants MUST be maintained. Violations are security bugs, not style issues:

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Source                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| S1  | `MNEMO_MASTER_KEY` MUST NEVER appear in `NEXT_PUBLIC_*` or client-side code                                                                                                                                                                                                                                                                                                                                                                                                                                                             | SECURITY_ARCHITECTURE.md                     |
| S2  | Every workspace-scoped `mnemo_*` table MUST have both `ENABLE ROW LEVEL SECURITY` AND `FORCE ROW LEVEL SECURITY`. The exceptions are listed in SECURITY.md (cross-workspace by design, e.g. `mnemo_api_keys`, the outbox); audit-log partitions get no direct privilege at all (0079). Adding a table to the exceptions needs that list updated | 0001_baseline.sql                            |
| S3  | Audit log (`mnemo_audit_log`) is append-only: BEFORE UPDATE OR DELETE trigger + REVOKE UPDATE, DELETE, TRUNCATE FROM `mnemo_app_role`                                                                                                                                                                                                                                                                                                                                                                                                   | 0003_audit_immutable.sql                     |
| S4  | `mnemo_deletion_log` is append-only (INSERT-only for app role)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 0001_baseline.sql                            |
| S5  | Sensitivity comparison MUST use `SENSITIVITY_ORDER` numeric values — NEVER string equality (MED-23)                                                                                                                                                                                                                                                                                                                                                                                                                                     | security.ts                                  |
| S6  | Sensitivity ceiling violations return **404, not 403** (anti-probing)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | rbac.ts                                      |
| S7  | Federated items are always capped at `attribution: 'federation_received'` (trust score 20)                                                                                                                                                                                                                                                                                                                                                                                                                                              | FEDERATION.md                                |
| S8  | Peer trust weights in federation voting MUST come from LOCAL peer config — never from self-reported vote payloads                                                                                                                                                                                                                                                                                                                                                                                                                       | FEDERATION.md                                |
| S9  | `packages/core/src/cognitive/` MUST have zero imports from drizzle-orm, pg, redis, @neondatabase                                                                                                                                                                                                                                                                                                                                                                                                                                        | v3-purity.test.ts                            |
| S10 | In-process plugins have NO security isolation — every `package:` plugin is fully trusted server code                                                                                                                                                                                                                                                                                                                                                                                                                                    | PLUGIN_SPEC.md                               |
| S11 | Provenance writes MUST go through `resolveProvenance()` — `actorId` is always a namespaced `ActorRef`, never a bare credential id or the `apiKeyPrefix` constant                                                                                                                                                                                                                                                                                                                                                                        | provenance.ts                                |
| S12 | Superadmin (`mnemo_instance_admin`) is checked in the database on every request, never trusted from the JWT; `/instance/*` accepts only a superadmin's password session (no API key) and answers 404 otherwise. Never grant app roles table-level write on `mnemo_instance_admin` or on `mnemo_user.disabled_at` (UPDATE is granted per column, never table-level); change them only through the `SECURITY DEFINER` functions. The break-glass script needs `MNEMO_ADMIN_DATABASE_URL` passed at run time only, never in the server env | MULTI_TENANCY.md §2, docs/guides/ACCOUNTS.md |

---

## 7-stage hybrid recall pipeline

Implemented in `packages/core/src/cognitive/recall-cold.ts` (scoring constants in `recall-relevance.ts`). Runs on every `memory_recall` MCP call and `POST /recall` HTTP request that the hot and pointer tiers do not answer.

| Stage | What                                                                                                                                                                                                                                                                                                                                                                              | Status     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1     | Parse query → semantic embedding + filters                                                                                                                                                                                                                                                                                                                                        | ✅ Working |
| 2     | Candidates from every arm: HNSW over facts (`vector.search`), `recallableCandidates` for the other recallable kinds, entities, plus FTS arms in hybrid. Each candidate keeps its raw cosine (`similarity`) and lexical rank apart. An explicit `minSimilarity` applies to the cosine of every kind before ranking                                                                 | ✅ Working |
| 3     | Relation context + hyperedge **hints** for the served page only — co-members are never injected as hits (WP-3, RECALL-2)                                                                                                                                                                                                                                                          | ✅ Working |
| 4     | Petrov activation `A(t) = ln(∑ t_j^{-d}), d=0.5` from `mnemo_recall_log` — a bounded tie-breaker                                                                                                                                                                                                                                                                                  | ✅ Working |
| 5     | **Relevance first:** `score = relevance × kindWeight × worthPrior × (1 + 0.02·tanh A)`, where relevance is the cosine (RRF in hybrid), `worthPrior = 1 + 0.1·(worth − 0.5)` and entities weigh 0.85. The pre-WP-3 blend `(tanh(A)·0.4 + cos·0.6)·worth` let recently recalled facts win unrelated queries (7/62 top-1 on the BENCH-1 corpus; now 56/62 vs a 57/62 cosine ceiling) | ✅ Working |
| 6     | Sensitivity ceiling + worth gate + filters (incl. `scopeOwner`), exact-content dedup, `nothingRelevant` judged before pagination                                                                                                                                                                                                                                                  | ✅ Working |
| 7     | Assemble `RecallHit[]` with structured security labels, `kind`, `topicKey`, `subject`, `status` (active/superseded/contested)                                                                                                                                                                                                                                                     | ✅ Working |

Hot recall (`recall-hot.ts`) serves warm facts that cover the query's terms, bypassing stages 2–4; it skips queries with fewer than two content terms. Only the hits actually returned are logged to `mnemo_recall_log` (and counted in `hit_count`). Retrieval does not write `related` relations or Hebbian hyperedges unless the host sets `recallGraphLearning`. LLM rerank is opt-in (`rerank: true`).

`nothingRelevant` uses `MNEMO_RECALL_RELEVANCE_FLOOR`, else the calibrated per-model default in `DEFAULT_RELEVANCE_FLOORS` (bge-m3: 0.50), else no floor (only an empty result counts). Cosine scales are model-specific — never reuse one model's floor for another.

Relevance regression gate: `packages/core/src/benchmark/__tests__/recall-relevance.test.ts` replays the evaluation corpora over frozen bge-m3 vectors (no model needed). Regenerate the vectors with `packages/core/src/benchmark/relevance/generate-vectors.mjs` only when `corpus.json` changes.

---

## MCP tools

37 tools in `packages/mcp/src/tools/` — **37 live, 0 stubs** (verified 2026-08-13; `memory_relocate` is tool #37). Served by the standalone MCP stdio server. With `MNEMO_MCP_TOOLS` unset (or `full`) the server serves all 37; `core` serves the 9 tools of `CORE_TOOL_NAMES` in `registry.ts`.

| Tool                       | Status     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `memory_context`           | ✅ Working | Optional identity/orientation call. Returns active workspace, userId, personalWorkspaceId, tenantId, scopes, and live stats in one shot. Workspace scoping is already established by the API key on every call (including `memory_recall`) — this tool does not gate recall correctness, it just lets an agent orient itself (which workspace/tenant it's in, what other workspaces exist). The plugin's injected protocol (`packages/plugin/skills/memory/SKILL.md`) mandates `memory_recall` as the actual first call of a session; call `memory_context` when you need workspace/tenant orientation, not as a session-start gate. |
| `memory_fact`              | ✅ Working | Devuelve UN hecho completo por id — la mitad de escalada del recall compacto (P67). Un hit con `truncated: true` trae 300 chars; el texto entero se pide acá, y sólo para los hits que se van a usar.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `memory_recall`            | ✅ Working | 7-stage cold pipeline, relevance-first; hits carry `similarity`, the response `nothingRelevant`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `memory_remember`          | ✅ Working | Creates facts/decisions/strategies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `memory_forget`            | ✅ Working | Closes validity range (bitemporal)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `memory_relocate`          | ✅ Working | P72 — mueve un hecho al workspace correcto en un paso. NO es un cambio de `workspace_id`: cierra el original y crea un sucesor en el destino, unidos por `supersedes`, en una transacción. Requiere ser miembro con escritura del destino (403 si no); un hecho `confidential`/`restricted` no cruza (409, su cifrado está atado a la clave del workspace de origen). Tool propia y no un campo de `memory_update` a propósito — ver P72.                                                                                                                                                                                            |
| `memory_search`            | ✅ Working | Full-text + semantic search                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `memory_status`            | ✅ Working | Server health + feature flags (operator view)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `memory_relate`            | ✅ Working | Creates relations between primitives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `memory_decide`            | ✅ Working | Records architectural decisions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `memory_entity`            | ✅ Working | Upserts entities (person/org/project/etc.). `link_user`/`unlink_user` actions bind a `kind: "person"` entity to a real platform account (see "Provenance identity" above) — self-link always allowed, a different user requires `memory:admin` + owner/admin role.                                                                                                                                                                                                                                                                                                                                                                   |
| `memory_pin`               | ✅ Working | Pins facts to prevent decay                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `memory_timeline`          | ✅ Working | Time-scoped episodic recall                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `memory_episode_start`     | ✅ Working | POST /session/start — returns sessionId (v3.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `memory_episode_end`       | ✅ Working | POST /session/:id/collapse — triggers full 8-step extraction pipeline (v3.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `memory_consolidate`       | ✅ Working | POST /consolidation/trigger — manual fast mode works with `dryRun: false`; manual deep mode and `dryRun: true` return 422                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `memory_remind_when`       | ✅ Working | POST /reminders — time + semantic trigger; background polling wired (v3.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `memory_self_edit`         | ✅ Working | 6 actions: append/replace/strengthen/weaken/reflect/link — deferred tool                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `memory_update`            | ✅ Working | Ergonomic fact correction: replaces statement via bitemporal replace (closes old valid_to, new id)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `memory_judge`             | ✅ Working | Resolve conflicts interactively — accepts/rejects pending conflict candidates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `memory_doctor`            | ✅ Working | 8 operational diagnostics (grants, schema, embeddings, MCP tools)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `memory_stats`             | ✅ Working | Cross-workspace statistics via admin/stats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `memory_purge`             | ✅ Working | Hard delete — requires memory:hard_delete scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `memory_compare`           | ✅ Working | Diff two facts, suggests relation verb                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `memory_session`           | ✅ Working | Session management                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `memory_task`              | ✅ Working | Task CRUD + state machine                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `memory_event`             | ✅ Working | Immutable event log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `memory_reasoning`         | ✅ Working | Reasoning chains                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `memory_strategy`          | ✅ Working | Trigger→action heuristics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `memory_hyperedge`         | ✅ Working | N-ary relations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `memory_introspect`        | ✅ Working | Meta-cognition / self-model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `memory_anticipate`        | ✅ Working | Anticipation feed (4-way blend)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `memory_compose`           | ✅ Working | Compositionality / inference rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `memory_workflow`          | ✅ Working | Reusable multi-step process templates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `memory_skill`             | ✅ Working | Prompt templates for repeatable tasks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `memory_workspace`         | ✅ Working | Workspace/tenant listing + membership (tool #34)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `memory_suggest_topic_key` | ✅ Working | Pure, deterministic `topicKey` derivation from subject/body — proxies `POST /topic-key/suggest`, no local computation (tool #35)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

See `docs/STATUS.md` for the authoritative feature status matrix.

---

## Package dependency map

| Package                      | Depends on                                   | Exposes                                                                                                                                                                                                                                                               | Status                                   |
| ---------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `@mnemo-ai/types`            | nothing                                      | Domain types, port interfaces, SENSITIVITY_ORDER, RelationVerb                                                                                                                                                                                                        | ✅ Stable                                |
| `@mnemo-ai/core`             | `@mnemo-ai/types` only                       | `recallCold`, `recallHot`, `remember`, `forget`, `withMnemoTx`, session pipeline                                                                                                                                                                                      | ✅ Stable (v3 zone)                      |
| `@mnemo-ai/adapter-postgres` | `@mnemo-ai/types`, drizzle-orm, postgres     | `DrizzleStorageAdapter`, `runMigrations`                                                                                                                                                                                                                              | ✅ Stable                                |
| `@mnemo-ai/adapter-redis`    | `@mnemo-ai/types`, ioredis                   | `RedisCacheAdapter`                                                                                                                                                                                                                                                   | ✅ Stable                                |
| `@mnemo-ai/adapter-vector`   | `@mnemo-ai/types`, postgres/pgvector         | `PgVectorAdapter`                                                                                                                                                                                                                                                     | ✅ Stable                                |
| `@mnemo-ai/adapter-llm`      | `@mnemo-ai/types`, `@mnemo-ai/llm-providers` | `LlmProviderAdapter` (bridges port → providers)                                                                                                                                                                                                                       | ✅ Stable                                |
| `@mnemo-ai/llm-providers`    | provider SDKs (OpenAI, Anthropic, etc.)      | `OpenAIProvider`, `AnthropicProvider`                                                                                                                                                                                                                                 | ✅ Stable                                |
| `@mnemo-ai/server`           | `@mnemo-ai/core`, all adapters               | HTTP API on port 3939                                                                                                                                                                                                                                                 | ✅ Mostly stable; some routes return 501 |
| `@mnemo-ai/mcp`              | `@mnemo-ai/client-ts`                        | MCP stdio server (37 tools, 0 stubs)                                                                                                                                                                                                                                  | ✅ Stable                                |
| `@mnemo-ai/client-ts`        | nothing (HTTP only)                          | `MnemoClient` typed SDK                                                                                                                                                                                                                                               | ✅ Stable                                |
| `@mnemo-ai/cli`              | `@mnemo-ai/client-ts`                        | `mnemo` CLI — full primitive/relation parity with the MCP surface as of CLI-PARITY-1 (2026-07-31): all 10 primitives, all 9 relation verbs, pin/timeline/judge/purge/consolidate/remind, plus `config`/`keys`/`workspace`/`init`/`install`. See `docs/guides/CLI.md`. | 🔶 Alpha                                 |
| `@mnemo-ai/consolidation`    | `@mnemo-ai/types`, `@mnemo-ai/core`          | Memory consolidation: gate + replay validator + background scheduler (60 s)                                                                                                                                                                                           | 🔶 Alpha — wired at boot (v3.2)          |
| `@mnemo-ai/cup`              | `@mnemo-ai/types`                            | v2→v3 LLM-powered migration                                                                                                                                                                                                                                           | 🔶 Alpha                                 |
| `@mnemo-ai/federation`       | `@mnemo-ai/types`, `@mnemo-ai/core`          | Cross-instance federation — 8 HTTP routes, InMemoryPeerStore/JobStore/SyncStorage all wired                                                                                                                                                                           | 🔶 Beta — pull transport pending (v3.3)  |
| `@mnemo-ai/plugins`          | `@mnemo-ai/types`                            | PluginLoader — in-process plugin loading, server boot wiring                                                                                                                                                                                                          | ✅ Stable                                |

---

## CI guards — what must pass before merge

Every PR must pass:

1. `pnpm typecheck` — no TypeScript errors in any package
2. `pnpm lint` — the typecheck-based and custom checks pass (there is no ESLint)
3. `pnpm test` — all unit tests pass (includes purity guards)
4. `pnpm build` — all packages build cleanly

GitHub Actions is turned off for this repository, so today these gates run locally: the pre-push hook runs `FULL=0 COVERAGE=1 bash scripts/full-sweep.sh`, and a release runs `FULL=1` (see `docs/RELEASING.md`).

Integration tests (`pnpm test:integration`, Docker required; part of `FULL=1`) test:

- `DrizzleStorageAdapter` against a real Postgres + pgvector instance
- The migration sequence guard
- RLS isolation

---

## Common LLM traps — do not fall into these

| Trap                                                                                    | Reality                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inventing a relation verb not in the list                                               | Only the 9 verbs are valid. SQL CHECK will reject others.                                                                                                                                                                                                                                                                    |
| Using string comparison for sensitivity                                                 | Always use `sensitivityAtLeast()` / `SENSITIVITY_ORDER[tier]`. String comparison is wrong (MED-23).                                                                                                                                                                                                                          |
| Treating `memory_consolidate`, `memory_episode_start`, or `memory_episode_end` as stubs | All 3 are registered and live as of v3.2. `memory_consolidate` delegates to `POST /consolidation/trigger`. `memory_episode_start` → `POST /session/start`. `memory_episode_end` → `POST /session/:id/collapse`.                                                                                                              |
| Importing `drizzle-orm` or `pg` in `packages/core/src/cognitive/`                       | Purity guard test will fail in CI.                                                                                                                                                                                                                                                                                           |
| Bypassing `withMnemoTx` for `mnemo_*` queries                                           | RLS is silently bypassed, cross-workspace data leaks.                                                                                                                                                                                                                                                                        |
| Coupling `@mnemo-ai/core` to `@mnemo-ai/adapter-postgres`                               | Core takes adapters via injection (CoreContext); it must never import a concrete adapter.                                                                                                                                                                                                                                    |
| Calling `forget()` and expecting the row to be deleted                                  | `forget()` sets `validTo = NOW()` — the row is preserved forever for auditability.                                                                                                                                                                                                                                           |
| Assuming session extraction / consolidation is NOT wired                                | Both are wired as of v3.2. `factory.collapseSession()` calls `runCollapseSession()` from `session/collapse.ts`. Consolidation scheduler starts on boot. Reminder evaluator polls every 30 s.                                                                                                                                 |
| Using `pnpm lint:hexagonal` or `pnpm lint:migrations`                                   | `lint:hexagonal` does not exist and `lint:migrations` is the SQL linter. Run `pnpm test` — the purity and migration-sequence guards are vitest tests.                                                                                                                                                                        |
| Using `apiKeyPrefix` as an identity                                                     | It's a shared constant (`"mns_live_"`, `"mk_admin_"`, etc.) — identical for every key of that type. It identifies nothing. Use `resolveProvenance(c)`'s `.actorId`/`.userId` instead.                                                                                                                                        |
| Assuming `memory_recall` returns only facts                                             | Default recall returns 7 of 10 kinds (the six `DEFAULT_RECALL_KINDS` plus entities), identifiable by `primitive` (`kind` on the wire); `kinds` reaches all 10.                                                                                                                                                               |
| Reading a `?? 0` fallback on a snapshot-derived stat as "genuinely zero"                | `GET /admin/stats`' three snapshot-derived counts (`facts.archived`, `facts.withZeroHits`, `decisions.active`) are `number \| null` — `null` means "no usable snapshot", not zero. Check `snapshot.available`. `relations.conflicts` is a live count under the caller's ceiling, a number (`null` only if that count fails). |

---

## Host harness — capture is opt-in, and the gate is a file

`mnemo install --capture opencode,claude-code,codex` is the only thing that turns
session capture on. Installing the plugin does not, and neither does writing a
hook manifest: every entry point checks a per-host consent marker at
`~/.mnemo/harness/capture/<host>.json`, written by that command and removed by
`mnemo harness disable <host>`. `MNEMO_HARNESS_V1_ENABLED=true` in the host's own
environment is an override, not the mechanism — an installer cannot set a
variable in a process that starts tomorrow, which is why the manifest used to
install cleanly and capture nothing.

**Modes reachable today: `user-only` for OpenCode and Claude Code, `mcp-only` for
Codex until `features.hooks = true` is set in `~/.codex/config.toml`.** `full`
needs transcript and deletion proofs no build has recorded yet — do not describe
it as available.

A mode is earned from a qualification record produced by running against that
exact build (Claude Code's record also covers later releases of its major, since
its qualifier never reads the host: `hostVersionMatch: "same-major"`), and the
effective mode is the LOWER of what the record proved and
what the live host gate allows. Both halves matter and they answer different
questions: the record says "was this build proven", the gate says "can capture
exist on this machine at all". Every unverifiable answer resolves downward.

The digest a record is matched on is computed from the shipped bytes at run time
(`computeCaptureArtifactHash`), so changing the harness package or a host's
plugin files invalidates every record. Re-qualify after either, and build first:

```bash
pnpm build
node scripts/qualify-harness-host.mjs <host>
node scripts/qualify-harness-host.mjs validate-all
```

A stale record does not error. It stops matching, and the host silently drops to
`mcp-only` — which is why `packages/harness`'s test files run one at a time: the
packaging test rebuilds `dist/` while another test hashes it.

Full guide: `docs/guides/HARNESS.md`.

## Where to find things

| I want to…                        | Look here                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------- |
| Understand the full system        | `docs/INDEX.md`                                                              |
| Check what's actually implemented | `docs/STATUS.md`                                                             |
| Read the data model               | `docs/architecture/DATA_MODEL.md`                                            |
| Understand the recall algorithm   | `docs/internals/ALGORITHMS.md`, `packages/core/src/cognitive/recall-cold.ts` |
| Read the HTTP API                 | `docs/architecture/API.md`, `packages/server/src/routes/`                    |
| Use the MCP tools                 | `packages/mcp/README.md`                                                     |
| Deploy                            | `docs/DEPLOYMENT.md`                                                         |
| Add a new storage adapter         | `docs/guides/ADD_A_STORAGE_ADAPTER.md`                                       |
| Add a new cognitive primitive     | `docs/guides/ADD_A_PRIMITIVE.md`                                             |
| Debug RLS isolation               | `docs/guides/DEBUG_RLS_ISOLATION.md`                                         |
| See versioning and release flow   | `docs/RELEASING.md`                                                          |
