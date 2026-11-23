# @mnemo-ai/cup

**English** · [Español](README.es.md)

> **AI pointer:** Cognitive Upgrade Protocol — deterministic v2→v3 data migration. Run once during system upgrades.
>
> **Depends on:** @mnemo-ai/types (`@mnemo-ai/core` is a peer, not a hard dep)
>
> **Exposes:** `mapV2Memory`, `mapV2MemoryBatch` (library) · `mnemo-migrate` (CLI)
>
> **Status:** BETA — deterministic mapper + keyset CLI ingestion runner implemented; not yet battle-tested at scale
>
> **See also:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md)

Cognitive Upgrade Protocol (CUP) — a **deterministic** ETL that migrates legacy
(v2) Mnemosyne data to the v3 schema. CUP reads flat `memories` rows from a
source database, maps each row to the matching v3 cognitive primitive via a
pure rule-based `TypeMapper` (no LLM), and inserts the results into the target
v3 database using raw SQL with `ON CONFLICT DO NOTHING` for idempotency.

> **Note:** CUP is a rule-based mapper, **not** an LLM-powered classifier (LLM
> re-classification is opt-in via `--llm`). By default it is fast, free, and reproducible. The trade-off is that mapping is driven by the
> v2 `memory_type` field rather than semantic re-classification.

---

## Why CUP exists

Earlier Mnemosyne deployments stored everything as flat `memories` rows keyed by
a `memory_type` string. The v3 schema uses 10 typed cognitive primitives. CUP
maps each v2 `memory_type` onto its v3 primitive and applies the correct
import-time confidence policy (`Beta(1,2) ≈ 0.33`) so imported facts start
appropriately uncertain.

| Aspect | v2 schema | v3 schema |
|---|---|---|
| Fact model | Flat `memories` rows | 10 typed `PrimitiveKind` values |
| Sensitivity | Not tracked | Required on every fact |
| Worth | Basic counters | ACT-R worth model (Beta-Bernoulli) |

---

## Implementation status

| Component | Status | Notes |
|---|---|---|
| `TypeMapper` (all 8 v2 types) | ✅ Done | `mapV2Memory` / `mapV2MemoryBatch` in `src/TypeMapper.ts` |
| CLI runner (`mnemo-migrate`) | ✅ Done | `src/migrate.ts`; batched, dry-run, idempotent |
| Idempotency | ✅ Done | `ON CONFLICT DO NOTHING` on every insert (no separate tracking table) |
| Resumable runs | ✅ Done | `(created_at, id)` keyset cursor persisted in `mnemo_migration_cursor`; resume with `--run-id` |
| LLM re-classification | 🔸 Opt-in | Off by default (CUP is deterministic); enabled with `--llm`, needs `MNEMO_LLM_API_KEY` |

---

## How it works

```
Source DB (v2)            CUP migrate.ts            Target DB (v3)
─────────────             ─────────────             ─────────────
public.memories  ──read──► mapV2MemoryBatch  ──write─► mnemosyne.mnemo_fact
  (keyset cursor           (rule-based, by                mnemosyne.mnemo_episode
   pagination)             memory_type)                  mnemosyne.mnemo_skill
                                                       (ON CONFLICT DO NOTHING)
```

### Step-by-step

1. **Read** — fetch a batch from the source `public.memories` table using a
   `(created_at, id)` keyset cursor.
2. **Map** — `mapV2MemoryBatch()` deterministically maps each row to a v3
   primitive (`fact`, `episode`, or `skill`) based on its `memory_type`.
3. **Write** — insert into `mnemosyne.mnemo_fact` / `mnemo_episode` /
   `mnemo_skill` via raw SQL with `ON CONFLICT DO NOTHING`.
4. **Report** — print a summary of records processed per primitive.

---

## CLI usage

```bash
# Required env
export DATABASE_URL=postgres://user:pass@host:5432/mnemosyne_v2      # source
export DATABASE_URL_V3=postgres://user:pass@host:5432/mnemosyne      # target

# Full migration for a workspace
mnemo-migrate --workspace <uuid>

# Tune batch size (default 100)
mnemo-migrate --workspace <uuid> --batch-size 50

# Dry run — map and count, do not write
mnemo-migrate --workspace <uuid> --dry-run
```

---

## Library usage

```ts
import { mapV2MemoryBatch } from "@mnemo-ai/cup";

const mapped = mapV2MemoryBatch(v2Rows, workspaceId);
// mapped.facts / mapped.episodes / mapped.skills — write these yourself
```

---

## Safety: idempotency

CUP can be re-run safely. Every insert uses `ON CONFLICT DO NOTHING` keyed on the
primitive ID, so:

- Interrupted migrations resume without creating duplicates.
- Running CUP twice produces the same result.
- The source database is only ever read, never modified.
