# @mnemo-ai/consolidation

**English** · [Español](README.es.md)

> **AI pointer:** Background memory consolidation service — similarity-gates repeated facts and schedules sleep-cycle processing.
>
> **Depends on:** @mnemo-ai/types, @mnemo-ai/core
>
> **Exposes:** runConsolidationGate (real), startConsolidationScheduler (real)
>
> **Status:** BETA — gate logic exists; background scheduler wired at server boot
>
> **See also:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [docs/internals/CONSOLIDATION.md](../../docs/internals/CONSOLIDATION.md)

Sleep-cycle consolidation subsystem for Mnemosyne v3. Promotes episodic memories
to semantic long-term storage by merging candidate fact pairs that pass a
multi-condition gate — analogous to memory consolidation during slow-wave sleep
in cognitive neuroscience.

---

## What It Does

During consolidation, the worker scans recent episodic facts in the workspace,
pairs candidates that are semantically similar, and for each pair that passes the
`ConsolidationGate`, calls an LLM to produce a merged semantic fact. The merged
fact absorbs the worth of both originals and replaces them in storage.

This reduces redundancy (duplicate near-identical memories collapse into one),
improves recall precision (semantic facts surface before episodic noise), and
controls storage growth over time.

---

## Architecture Position

```
@mnemo-ai/consolidation  (ConsolidationGate, worker)
       ↓ reads via
@mnemo-ai/core  (StorageAdapter + VectorAdapter ports)
       ↓ calls for merging
@mnemo-ai/adapter-llm  (LLMAdapter port)
```

The consolidation worker is infrastructure — it runs on a schedule and calls
the same core ports that the main server uses. It does not have its own database
connection; it receives injected adapter instances at startup.

---

## Implementation Status

| Component                    | Status   | Notes                                                                  |
| ---------------------------- | -------- | ---------------------------------------------------------------------- |
| `ConsolidationGate`          | **Done** | All ~10 conditions fully implemented (cluster ≥ 3)                     |
| `runConsolidationGate()`     | **Done** | Exported, unit-tested                                                  |
| `ReplayValidator`            | Done     | Validates merge output before committing                               |
| Consolidation worker runtime | **Done** | `startConsolidationScheduler()` schedules ticks with injected adapters |
| Admin API trigger            | **Done** | `POST /consolidation/trigger` is active                                |
| Wired to live server         | **Done** | Scheduler started at server boot                                       |

---

## ConsolidationGate: Conditions

A cluster of **≥ 3 facts** is eligible for merging only if **all conditions** hold. The gate is conservative by design — pairs are never merged (too aggressive).

| Condition                 | Threshold                                                  |
| ------------------------- | ---------------------------------------------------------- |
| **Cluster size**          | ≥ 3 members                                                |
| **No canonical facts**    | No member has `canonical: true` (§11 governance exemption) |
| **Worth ceiling**         | All members have `worth < 0.5`                             |
| **Not recently recalled** | No member recalled within the last 14 days                 |
| **Confidence ceiling**    | Wilson lower bound ≤ 0.7 for all members                   |
| **Not pinned**            | No member has `pinned: true`                               |
| **Not contested**         | No member is contested                                     |
| **Same sensitivity**      | All members share the same `sensitivity` level             |
| **Embeddings present**    | All members have a non-null `embedding`                    |

The gate returns on the **first** failed condition (`result.failedCondition`).

---

## Usage

```typescript
import { runConsolidationGate } from "@mnemo-ai/consolidation";

const result = runConsolidationGate({
  members: [factA, factB, factC], // cluster of >= 3 facts
});

if (result.passed) {
  // proceed to LLM merge
  console.log("min pairwise cosine:", result.minCosine);
} else {
  console.log("Gate failed:", result.failedCondition); // singular
}
```

---

## Consolidation Schedule

The server starts the worker with `startConsolidationScheduler()` at boot. It uses
a fixed 60-second interval and inspects at most 20 candidate facts per workspace
per tick. There is currently no YAML cron, batch-size, or dry-run configuration.

On-demand consolidation is available via the admin API: `POST /consolidation/trigger`.
Only manual `mode: "fast"` with `dryRun: false` is supported. Manual `mode: "deep"`
returns HTTP 422 `deep_mode_not_supported`; `dryRun: true` returns HTTP 422
`dry_run_not_supported` before the scheduler or storage is called.

---

## Algorithm Overview

1. Fetch up to 20 active facts in each workspace and retain candidates with worth <= 0.4
2. Form clusters of at least three facts using their stored embeddings and cosine similarity >= 0.85
3. Run `ConsolidationGate` on each cluster
4. Keep the highest-hit-count fact as the survivor
5. Mark the other facts as merged and increase the survivor's worth
6. Run replay validation asynchronously when a validator is available
7. Restore absorbed facts if replay validation flags the merge

---

## Notes

- Consolidation is **workspace-scoped** — facts from different workspaces are
  never merged.
- The manual API has no preview mode yet; `dryRun: true` is rejected with HTTP 422.
