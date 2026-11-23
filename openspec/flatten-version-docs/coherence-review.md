# Versioning-Coherence Review (A3)

Evidence for the Tier 1 sweep + versioning-coherence pass (Req 7). Oracle:
`docs/architecture/API.md`, which already carries a 2026-07-31 correction note
stating the API is versioned solely via the `Mnemosyne-Version` date header and
has no `/v1` URL-path segment.

## Reviewed docs (A3.1 explicit Tier 1 list)

| Doc                                          | Discusses API versioning?                                                                      | `Mnemosyne-Version` described afterward? | Action                                                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/architecture/API.md`                   | yes                                                                                            | yes                                      | reference — unchanged                                                                                                                                             |
| `docs/api/STABILITY.md`                      | yes (already correct: "No `/v1` path prefix on the wire")                                      | yes                                      | none — was already accurate                                                                                                                                       |
| `docs/architecture/ARCHITECTURE_OVERVIEW.md` | no (uses `/v1/recall` only as an illustrative route label)                                     | n/a                                      | `/v1` stripped from route labels                                                                                                                                  |
| `docs/architecture/FEDERATION.md`            | no                                                                                             | n/a                                      | `/v1` stripped from route labels                                                                                                                                  |
| `docs/architecture/IDEMPOTENCY_STRATEGY.md`  | no                                                                                             | n/a                                      | `/v1` stripped from route labels                                                                                                                                  |
| `docs/architecture/MCP_SESSION_TOOL.md`      | no                                                                                             | n/a                                      | `/v1` stripped from route labels                                                                                                                                  |
| `docs/integration/SDK_INTEGRATION.md`        | discusses `MEMORY_PROTOCOL_VERSION` (a different, frozen axis — untouched) not HTTP versioning | n/a                                      | `/v1` stripped from route labels only                                                                                                                             |
| `docs/internals/ALGORITHMS.md`               | no                                                                                             | n/a                                      | `/v1` stripped from route labels                                                                                                                                  |
| `docs/internals/OBSERVABILITY.md`            | no                                                                                             | n/a                                      | `/v1` stripped from route labels; `http://prometheus:9090/api/v1/write` and `http://loki:3100/loki/api/v1/push` (Tier 4, third-party) deliberately left untouched |
| `load/README.md`                             | no                                                                                             | n/a                                      | `/v1` stripped                                                                                                                                                    |
| `packages/server/loadtest/README.md`         | no                                                                                             | n/a                                      | `/v1` stripped                                                                                                                                                    |
| `packages/cli/README.md`                     | no                                                                                             | n/a                                      | `/v1` stripped                                                                                                                                                    |
| `packages/consolidation/README.md`           | no                                                                                             | n/a                                      | `/v1` stripped                                                                                                                                                    |

No doc in this list needed more than a one-line-per-occurrence mechanical fix.
None left a coherence gap: none of them made the `Mnemosyne-Version` header
claim that then needed the `/v1` text to compensate — they only used `/v1` as
a label prefix inside example route paths, so removing the prefix is a
complete fix with no residual gap (Req 7, Scenario 2).

## Gap 1 — `docs/STATUS.md` (scope correction, folded into A2, not A3)

`docs/STATUS.md` is Req 4's own capability, not part of A3.1's Tier 1 list, but
the same "doc needing more than a one-line fix" surfacing applies. Beyond the
four originally-scoped rows (line 611's false coexistence claim + the CLI
export/import certification rows), STATUS.md carried ~59 additional
`/v1/`-prefixed path mentions in its dated history entries (e.g. "the real
`POST /v1/recall` path", "`DELETE /v1/facts/:id`"). Since STATUS.md is a live,
non-frozen doc, Requirement 11 forbids the upcoming guard (A5) from
bulk-allowlisting it the way Tier 3 frozen history is allowlisted. All ~59
were swept as part of A2 (same commit, same file, mechanical prefix removal,
no historical claim changed in meaning) — with the sole exception of the real
Prometheus `/api/v1/query` reference at `docs/STATUS.md:736`, which is Tier 4
(third-party, `PROMETHEUS_URL` base) and was left untouched.

## Gap 2 — `packages/sdk-python/README.md` (scope correction, swept in A3)

Not named anywhere in A0's re-census or in A3.1's Tier 1 list, despite
`docs/STATUS.md:17` claiming "both non-TS SDKs" were already fixed for `/v1`
drift on 2026-07-31. Empirically this package's README still carried 15
`/v1`-prefixed route references in its method-to-endpoint table (e.g.
`` `recall(...)` | `POST /v1/recall` ``). Same reasoning as Gap 1 applies — a
live, reader-facing method/route reference table, not frozen history — swept
in this same PR as a mechanical prefix removal.

`packages/sdk-go` was checked in the same pass and has zero `/v1/` matches —
consistent with STATUS.md's claim for that SDK.

## Gap 3 — un-triaged doc areas discovered by a full-repo re-census (surfaced, NOT force-fit)

A0's re-census (design.md) found six areas the original proposal's tier lists
missed. Empirically re-running that census during A3 found MORE: a full
`rg -l '/v1/' docs/` turned up ~35 additional files across `docs/archive/remediation/`,
`docs/ops/`, `docs/research/`, `docs/compliance/`, `docs/architecture/{CONSTRAINTS,ARCHITECTURE}.md`,
`docs/internals/{PERFORMANCE,DOC_VERIFICATION}.md`, `docs/deploy/OPERATIONS.md`,
and `docs/archive/superpowers/specs/*.md` — none named by the proposal, design's A0
census, or this tasks breakdown.

Per Requirement 7, Scenario 3 ("a doc needing more than a one-line fix is
surfaced, not force-fit"), this finding is recorded here rather than
auto-resolved, because correctly classifying each file (frozen historical
record vs. live reader-facing doc) requires reading and judging each one
individually — the same kind of review A0 already did for its six areas, not
a mechanical sweep:

- **`docs/archive/remediation/**` (30 files, 148 `/v1/` occurrences)** — classified
  **Tier 3 (frozen)** with high confidence: every filename is dated or
  phase-numbered ("2026-06-17-deep-reaudit.md", "08-final-reaudit.md",
  "RDD-6-COMPLETION-REPORT.md"), matching the exact character of
  `docs/archive/sdd/archive/**` (already Tier 3 per A0.4). Allowlisted at their
  current exact counts, untouched — no banner added (Requirement 9 only
  mandates banners for the 9 files it explicitly names; retroactively
  banner-stamping 30 more is out of this PR's scope and would itself be a
  ~30-line addition better handled as its own reviewed follow-up).
- **`docs/ops/{status-page,gameday}.md`, `docs/ops/runbooks/security_breach.md`,
  `docs/deploy/OPERATIONS.md`, `docs/research/{MEMORY_MODEL,ENGRAM_GAP_ANALYSIS}.md`,
  `docs/compliance/{soc2-controls,data-residency}.md`,
  `docs/architecture/{CONSTRAINTS,ARCHITECTURE}.md`,
  `docs/internals/{PERFORMANCE,DOC_VERIFICATION}.md`,
  `docs/archive/superpowers/specs/*.md`** — **not classified** in this PR. Some read as
  live operational/compliance docs (candidates for a real Tier 1 fix), one
  (`docs/research/MEMORY_MODEL.md`, 62 occurrences) reads as an early Spanish-
  language product-vision document whose status (historical vs. still-current)
  cannot be safely judged from a grep pass. **Recommendation: a dedicated
  follow-up census (an "A0b"), scoped and reviewed the same way A0 was,
  before any of these are sw ept or banner-stamped.**

To keep Requirement 11's guard honest in the meantime, A5 adds a temporary
`unswept` allowlist entry per file in this list, pinned at its exact current
count — consistent with the design's existing "unswept" mechanic (originally
scoped to Tier 2 packages, extended here to cover doc areas whose tier is not
yet triaged). Each entry is independently removable once that file is
reviewed and classified, and a regression (a _new_ `/v1/` appearing in one of
these files beyond its pinned count) still fails CI immediately.
