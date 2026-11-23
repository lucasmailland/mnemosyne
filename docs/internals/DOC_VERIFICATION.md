# Documentation Verification Question Bank

Questions a cold LLM should answer correctly by reading the repo docs alone
(CLAUDE.md + docs/INDEX.md + package READMEs + docs/STATUS.md).

Verified answers are in `## Answers` at the bottom. Run against any LLM to
measure doc quality: correct ≥ 18/20 = passing.

---

## Questions

**Architecture**
1. What is the cardinal hexagonal rule for `@mnemo-ai/core`? Name three packages it must never import.
2. How do you verify that the hexagonal rule is not violated? (Name the exact test file path.)
3. What is the difference between `validFrom/validTo` and `createdAt` in a cognitive primitive?
4. Why does `forget()` set `validTo` instead of deleting the row?

**Cognitive Primitives**
5. List all 10 cognitive primitive types.
6. Which primitive is IMMUTABLE (never decays, no `updatedAt`)? Why?
7. What is the difference between `MnemoFact` and `MnemoDecision`? Give one example use case for each.
8. What does `worth` represent on a fact, and how is it computed?

**Recall Pipeline**
9. Name the 7 stages of the cold recall pipeline in order.
10. What is stage 4 (Petrov activation) and why is it currently DEGRADED?
11. What is the blended score formula used in stage 5 of cold recall? What are the weights?
12. When does the hot tier return results, and when does it fall through to the cold cascade?

**Security**
13. What is the SENSITIVITY_ORDER and why must you use it instead of string comparison?
14. What HTTP status code does Mnemosyne return when a sensitivity ceiling check fails? Why not 403?
15. What is the difference between `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`?
16. What does `withMnemoTx` do at the database level?

**MCP / API**
17. How many MCP tools are currently live (registered) vs. stubbed (planned)? Name the stub tools.
18. Where is the OpenAPI spec served at runtime?
19. What does a `501` error mean in the Mnemosyne API? What should you do to fix it?
20. What are the 9 locked `RelationVerb` values? Where is the set defined in source?

**Operations**
21. What two environment variables are required to run the MCP server?
22. What migration stream is canonical and ships in the Docker image?
23. Which tool manages releases in this repo and how are versions bumped?

---

## Answers

1. `@mnemo-ai/core` must import ZERO infrastructure packages. Specifically: `drizzle-orm`, `pg`, `redis`, `@neondatabase` (and any other I/O library).
2. `packages/core/src/__tests__/v3-purity.test.ts` runs as a vitest test (not a lint script). Also `packages/types/src/__tests__/purity.test.ts` for the types package.
3. `validFrom/validTo` = when something was true in the **world** (domain truth axis). `createdAt` = when the system **learned** it (system discovery axis). This is the bitemporal model.
4. Because facts are immutable audit records. Setting `validTo = NOW()` closes the validity window while preserving the full history. Hard deletes would break the audit log and bitemporal correctness.
5. fact, decision, episode, entity, strategy, workflow, skill, task, event, reasoning.
6. `MnemoEvent` (no `updatedAt`, no decay). Events represent immutable records of things that happened — audit trail entries, external webhooks, calendar events. Changing them would break the event log.
7. `MnemoFact`: durable behavioral knowledge (e.g., "User prefers TypeScript"). `MnemoDecision`: logged choice with rationale (e.g., "We chose Postgres over MongoDB because of ACID + pgvector").
8. `worth` is a Bayesian confidence measure (Beta-Bernoulli posterior mean = α/(α+β)). It starts at 0.5, rises with successful recalls, falls with failed ones. It's a GENERATED SQL column (read-only in TypeScript).
9. (1) Embed query → (2) HNSW vector search → (3) 1-hop relation expansion → (4) Petrov ACT-R activation → (5) blended score with worth → (6) sensitivity ceiling filter → (7) assemble RecallHit[].
10. Petrov activation A(t) = ln(∑ t_j^{-d}), d=0.5, where t_j = seconds since each prior recall. `mnemo_recall_log` table and `getRecallLog`/`logRecall` port methods added in v3.2 (TASK-4001). Stage 4 now reads real recall history; degrades gracefully to 0 on empty log.
11. score = (tanh(activation) × 0.4 + cosine_similarity × 0.6) × worth. Semantic dominates initially (activation ≈ 0 for new facts); Petrov grows as a fact is recalled more often.
12. Hot tier returns results when Redis is connected AND the query does not filter to non-fact primitive kinds. It returns `null` on miss, and the caller falls through to the cold cascade.
13. `SENSITIVITY_ORDER = { public:0, internal:1, confidential:2, restricted:3 }`. String comparison is wrong because `"confidential" > "internal"` alphabetically, but `internal(1) < confidential(2)` semantically. Bug MED-23 caused access decisions to be inverted when using string comparison.
14. `404 Not Found` (anti-probing pattern). Returning 403 would confirm the resource exists, letting attackers probe for sensitive fact IDs. 404 reveals nothing.
15. `ENABLE ROW LEVEL SECURITY` activates RLS but exempts the table owner (superuser) from policies. `FORCE ROW LEVEL SECURITY` applies policies to the table owner too. Mnemosyne uses FORCE on all workspace-scoped tables so even privileged DB users go through policies.
16. `withMnemoTx` runs `SET LOCAL mnemosyne.workspace_id = $workspaceId` and `SET LOCAL ROLE app_user` inside the Postgres transaction. Every query that follows uses this GUC to filter rows via the RLS policy `workspace_id = current_setting('mnemosyne.workspace_id')::uuid`.
17. **26 live**, **0 stubs** (as of v3.2): `memory_consolidate`, `memory_remind_when`, `memory_episode_start`, `memory_episode_end` were activated in v3.2. All 26 tools are registered and wired.
18. `GET /v1/openapi.json` (machine-readable), `GET /v1/docs` (Scalar interactive browser). Auto-generated from route definitions — no static file in the repo.
19. `501 not_implemented` means the operation requires an LLM provider (for embedding or extraction) but none is configured. Fix: set `MNEMO_LLM_PROVIDER=openai` and `MNEMO_LLM_API_KEY=sk-...` in the server environment.
20. `related | compatible | scoped | conflicts_with | supersedes | not_conflict | derived_from | part_of | member_of`. Defined in `packages/types/src/relations.ts` as the `RelationVerb` type. The set is locked and mirrors a SQL CHECK constraint in `packages/adapter-postgres/migrations/v3/0001_baseline.sql`.
21. `MNEMO_URL` (base URL of the Mnemosyne server) and `MNEMO_KEY` (workspace API key). Both required; the server exits code 1 with a help message if either is missing.
22. There are two migration streams and the deployed server (a dual-core hybrid) needs BOTH. The legacy stream at `packages/core/migrations/` provisions the `public` schema used by the v1 routes + auth; the v3 stream at `packages/adapter-postgres/migrations/v3/` provisions the `mnemosyne` schema used by the v3 core / `DrizzleStorageAdapter` (background tasks). The Docker `migrate` image (`docker/Dockerfile.migrate`) applies both in order — core's `mnemo-migrate` CLI first, then adapter-postgres's migrate CLI — so a single `docker compose up` provisions every table the runtime touches.
23. `release-please`. Releases are triggered by Conventional Commits on `main` — `feat:` bumps minor, `fix:` bumps patch, `BREAKING CHANGE:` bumps major. Changesets was removed.
