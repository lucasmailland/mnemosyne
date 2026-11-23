# Changelog
> Pre-2026-06-25 `/v1` mentions below predate the server's root-mount change (`app.route("/", v1)`); see `docs/architecture/API.md` for the current mount.

## Unreleased

### BREAKING CHANGES

* **server:** PATCH on tasks, strategies, workflows and entities answers 400
  for a field the route does not take (it was silently dropped).
* **server:** `POST /bootstrap` needs the setup token (`MNEMO_SETUP_TOKEN` or
  the one logged at first boot); webhook writes need `memory:admin` and
  refuse private and plain-HTTP targets unless allowed.
* **hosts:** `MNEMO_HARNESS_V1_ENABLED=true` no longer turns capture on;
  only `mnemo install --capture <host>` does. `false`/`0` is a kill switch.

### Security (audit 2026-11-22)

* Audit-log partitions are created ahead (runway of two months) by a
  definer function the app role may call; no write fails at a month change.
* Sensitivity ceiling enforced on WebSocket events, webhooks (text above
  internal is redacted), `forget`, and the stats context figures.
* Approvals are single-use and bound to the request they were granted for.
* Fact dedup respects scope, owner and sensitivity.
* Bcrypt amplification on bad keys closed; client IP taken from the socket
  unless a trusted proxy is configured; body and gunzip size limits.

### Added

* `GET /admin/stats` → `context`: characters served per recall (avg, p95)
  and the size of all live memory, for admins.
* `pnpm bench:tokens`: context per turn with Mnemosyne against a full dump
  (docs/testing/token-benchmark.md).
* `mnemo harness doctor` reports each host's effective capture mode.

### Changed

* **mcp:** `MNEMO_MCP_TOOLS=core` serves only the 9 most used tools for a
  smaller per-request surface; unset or `full` serves all 37, as before.
* MCP instructions 1,812 characters; SessionStart hook output ~0.5 KB; tool
  schemas advertised without boilerplate (core 11 KB, full 45 KB).
* The first prompt sent to recall without capture consent is redacted and
  capped at 500 characters.
* `/health/cognitive` `roiMultiplier` is null (nothing measures it) and the
  flat "tokens saved" estimates on recall are gone.

### Added

* **dashboard:** redesigned dashboard with the Mnemosyne brand, in English
  (en-US) and Spanish (es-419): the rooms restyled, a Cmd+K palette, and Lethe
  pages for missing routes and errors.
* **cli, mcp, server:** bilingual messages (en-US / es-419). The CLI takes
  `--locale` (also `MNEMO_LOCALE`, the config `locale` and `LANG`); the MCP
  server reads `MNEMO_LOCALE` and serves Spanish tool and field descriptions;
  the server localizes its errors from the `mnemo_locale` cookie, then
  `Accept-Language`. JSON error responses (4xx/5xx) carry `Content-Language` and `Vary`.
* **client-ts:** `RememberInput` takes `validFrom` (when a fact became true in the
  world), which `POST /remember` stores; `remember()` sends it.
* **cli, client-ts:** `mnemo tenant create --owner-token [--workspace-name <name>]`
  asks the server for the new tenant's first workspace and an owner token, and
  prints the token (once); `createTenant` accepts `issueOwnerToken` and
  `workspaceName` and types the `workspace` and `ownerToken` it returns. Without
  the flag, the command says the current key cannot manage the new tenant.
* **server:** `GET /timeline/counts?since=` counts the decision events
  `GET /timeline` would list (created, superseded, withdrawn) without paging.
  `GET /conflicts` adds `total`, every unresolved pair the caller can see
  (`limit` aside, within its sensitivity ceiling), from one COUNT; `/admin/stats`
  `relations.conflicts` is that same live count now, not the snapshot's (which
  counted every tier), so it is a number even before the first snapshot. `GET /facts/{id}` adds
  `hitCount`. The dashboard's Home uses all three: it reads eight events instead
  of up to 500, its conflict count no longer includes pairs above the caller's
  ceiling, and a closed fact opened in the catalog shows how often it was cited.

### Changed

* **server:** zod 4 and `@hono/zod-openapi` 1.x. `400 validation_error` bodies change
  their message text and `details.issues[].code` to zod 4's
  (`invalid_enum_value` is now `invalid_value`, `invalid_string` is `invalid_format`,
  "Required" is "Invalid input: expected T, received undefined"; a missing enum field
  reports `invalid_value` with "Invalid option: expected one of …" instead of
  `invalid_type`). Clients that key on
  `code: "validation_error"` and `details.issues[].path` are unaffected. Workspace
  ids in `targetWorkspaceId` keep accepting the same UUID shapes as before.
* **cli:** a yes/no prompt whose default is yes now treats `no` (not only `n`)
  as a decline, in English and Spanish.
* **mcp:** the served `memory_purge` description now says the deletion is
  permanent and cannot be undone (English and Spanish).
* **mcp:** the text the tools write back to the agent (errors, notes,
  summaries) is now English by default, and Spanish with `MNEMO_LOCALE=es-419`.
  Some of it was Spanish before, whatever the locale: the `memory_context`
  `_note` and `_roleNote`, and the `targetWorkspaceId` errors of
  `memory_skill`, `memory_strategy`, `memory_workflow` and
  `memory_remind_when`, and `memory_relocate`'s "targetWorkspaceId must be a
  UUID" validation message. Codes, ids and JSON keys are unchanged.
* **mcp:** richer served tool descriptions (English and Spanish): what the
  `memory_remember` response reports, `memory_status`'s instance-wide
  `dependencyHealth`, the event kinds `memory_timeline` really emits (`created`
  included), `memory_anticipate`'s blend weights, `memory_event` archive
  returning `{archived:false, immutable:true}`, and the limits of `memory_pin`,
  `memory_relocate`, `memory_relate`, `memory_workspace`, `memory_update`,
  `memory_entity`, `memory_compare`, `memory_strategy` and `memory_purge`.
* **mcp:** every input field now has a served description (English and Spanish):
  43 fields of `memory_task`, `memory_event`, `memory_reasoning`,
  `memory_strategy` and `memory_self_edit` had none. `memory_relate`'s `from` and
  `memory_compare`'s fact ids no longer cite the old `ment_`/`mfact_` id prefixes
  (ids are UUIDs; an episode's starts with `mepi_`). The contracts change only in
  those descriptions.
* **build:** tsup 9. Contributors now need Node ≥22.18 to build (`.nvmrc`,
  `.mise.toml` and the root `engines` say 22). CI and the server, migrate and
  dashboard Docker images run on Node 22. Published packages still target
  Node 20 and keep `engines.node` `>=20.0.0`.

### Fixed

* **server:** `GET /graph` respects the caller's sensitivity ceiling: nodes
  above it, and the edges touching them, are omitted, and hidden facts are not
  counted. `POST /recall` reports `debug.lexicalCandidateCount` only to callers
  whose ceiling admits every tier.
* **adapter-postgres:** closing a fact, strategy or decision at a caller-given
  `validTo` (the codebase-drift check, `PATCH /strategies`, an import overwrite)
  no longer fails with a range error when that instant falls before the row's
  own start: it closes at the start. A decision's `updated_at` now comes from
  the same database clock as its `valid_to`.
* **server:** Spanish error messages for zod 4's size and format checks (too
  short or long, invalid GUID, UUID, date, email, URL), and a missing field
  reads "Obligatorio" without zod's English type name.
* **cli:** `mnemo events archive`'s help (and the CLI guide) says what happens:
  the server refuses with 409 because events are immutable, and the command exits 1.
* **cli:** the setup banner's URL line and the `keys rotate` warning box line up
  with their borders (the English output changes by those spaces).
* **server:** `POST /remember` stores a fact's `validFrom` (when it became true in
  the world); it was accepted and dropped. A future instant answers 400, and other
  kinds ignore it. `validUntil` is documented as accepted and ignored.
* **server:** the current lists (`GET /entities`, `/decisions`, `/strategies`,
  `/workflows`, `/skills`, `/tasks`, `/reasoning`) and project `scopeRef`
  resolution no longer miss a row created a moment earlier when the database
  clock runs ahead of the server's: "current" now means an open validity
  interval, not "valid at the server's clock time". `POST /strategies` refuses a
  `validFrom` in the future with 400, as `POST /remember` does, so a strategy is
  never listed as current before it starts.
* **server:** `POST /review/:id/resolve` accepts the `mrev_<uuid>` ids the
  storage adapters have minted since the port off the legacy core; it answered
  400 for every row the server itself had queued, so a manually flagged fact
  or a consolidation review row could never be closed.
* **adapter-postgres:** forgetting, archiving or superseding a row a moment
  after it was created no longer fails with a 500 ("range lower bound must be
  less than or equal to range upper bound") when the server clock runs behind
  the database's, nor leaves a validity interval that ends before it starts:
  `valid_from` and `valid_to` stamps now come from the database clock. The
  same applies to crypto-erasure (`destroyed_at` of a DEK created a moment
  earlier violated its `destroyed_at >= created_at` check) and to a webhook's
  `updated_at`. Stored `valid_to` values now keep Postgres' microseconds.
* **docker:** the production overlay (`docker/docker-compose.prod.yml`) starts and
  serves as `docs/guides/PRODUCTION_DEPLOY.md` documents: every service healthy and
  `/health/ready` reporting `postgres` and `cache` ok. The server's Redis is
  `redis://redis-master:6379/0` (`MNEMO_REDIS_URL_PROD`). `REDIS_SENTINEL_URL` and
  its `redis-sentinel://` default are gone: the client never spoke Sentinel, so the
  hot tier, rate limits and Redis idempotency were silently off. The three Sentinel
  services are removed (one pointed at a config file the image does not ship, and a
  failover would have left the server on a read-only node). pgBouncer moves to
  `edoburu/pgbouncer` (`bitnami/pgbouncer:1.23.1` is no longer published), pools the
  app role with `MNEMO_APP_DB_PASSWORD`, and drops the startup parameters it cannot
  carry; `migrate` now sets the app role's `search_path` and timeouts with
  `ALTER ROLE … IN DATABASE`. The collector no longer restarts in a loop on port
  8888 (its own metrics took the exporter's port; this also fixes
  `docker-compose.observability.yml`).
* **plugin:** keep session-start and post-compaction context within a shared
  6000-byte budget, with recovery and sessionId instructions first. Inject a
  condensed behavioral protocol and link to the full memory skill; retain
  critical rules when auxiliary workspace details are oversized. Guard the CLI's
  bundled plugin against drift from the canonical copy.

### Security

* **server:** the graph and relation surface respects the caller's sensitivity
  ceiling everywhere (and on the `/dashboard/api` mounts). `GET /graph/traverse`,
  `GET /graph/path` and `POST /relations/traverse` stop at nodes above it, so a capped
  caller no longer receives their ids, the relation verbs that reach them or paths
  through them. `GET /relations` no longer lists a relation that touches such a node,
  and `PATCH`/`DELETE /relations/:id` answer 404 for one. `GET /hyperedges` leaves out a
  hyperedge with a hidden member (from `total` too), and `/hyperedges/:id` answers 404.
  An entity's `mentionCount`, in `GET /graph` and in every `/entities` response, is now
  its readable active facts plus readable related episodes; the stored column was never
  maintained. `GET /entities/:id`'s `linkedFactCount` counts readable facts only.
  `PATCH /entities/:id` answers 404 for an entity above the ceiling (it used to rename
  and return it), and a `canonicalId` above it is refused like a missing one.
* **server:** no memory response names a row above the caller's ceiling by id, and
  a route that takes such a row's id answers the 404 a missing id gets, word for
  word. Id pointers drop a hidden target (a list leaves it out, a single field reads
  as a missing target does: `null`, or absent where a missing one is absent): a
  fact's `linkedMemoryIds`, `mergedIntoId` and `episodeId`; an episode's
  `linkedFactIds` and `parentEpisodeId`; an entity's `canonicalId`; a decision's
  `supersededById`; a task's `parentTaskId`, `subtaskIds`, `blockedBy`,
  `relatedFacts` and `relatedEntities`; a strategy's `supersedesId`; a workflow's
  `previousVersionId`; an event's `relatedEntities`; and an inference's
  `inputFactIds` and `derivedId` (`GET /composition/inferences`).
  `GET /episodes/:id` no longer returns linked facts above the ceiling in its
  `linkedFacts`, `GET /review` leaves out a row about a hidden fact or decision, and
  `GET /audit` leaves out a hidden forgotten fact. These answer 404 for a row above
  the ceiling and change nothing (they used to act on it, and most returned it):
  `GET /facts/:id/citations`, `DELETE /facts/:id`, `POST /facts/:id/relocate`,
  `POST /governance/gate`, `PATCH`/`DELETE /tasks/:id`, `POST /tasks/:id/delegate`,
  `PATCH`/`DELETE /strategies/:id`, `POST /strategies/:id/rate`,
  `PATCH`/`DELETE /reasoning/:id`, `POST /reasoning/feedback`,
  `PATCH /events/:id/sensitivity`, `POST /events/:id/annotations`,
  `POST /review/enqueue` (which now also answers 404 for a fact or decision that
  does not exist; it used to queue a review of any id, which `/review/:id/resolve`
  could then forget), `POST /self/edit` for every action, and the gRPC `Forget`,
  `UpdateTask` and `SelfEdit`. `POST /import` never matches a row above the ceiling:
  a line naming one is imported as a new row, as for an id that names nothing, and
  the row is not overwritten; like every create route, it also skips a line whose own
  sensitivity is above the importer's ceiling (reason `above-ceiling`), so restoring
  confidential or restricted rows needs a key whose ceiling admits them. The reasoning cache (`POST /reasoning/resolve`,
  `POST /reasoning/record`, gRPC `ResolveReasoning`) neither serves, bumps nor names
  a chain above the ceiling. `PATCH /events/:id/sensitivity` refuses a tier above the
  caller's own ceiling (404 `sensitivity_above_ceiling`, as on create, and nothing is
  changed): with the default `internal` ceiling, raising an event to `confidential`
  or `restricted` needs a key whose ceiling admits that tier.
  `POST /recall/explain`'s `relationCount` no longer counts relations to hidden rows,
  and a hit is no longer `contested` (in `/recall` and `/recall/explain`) by a
  conflict whose other end is hidden. Operator surfaces keep full ids: webhook and
  event-bus payloads, and `/export` (`memory:export`, behind an approval).
* **docker:** the production overlay publishes Postgres, Redis, pgBouncer and the
  collector on `127.0.0.1` only, and refuses to start without `POSTGRES_PASSWORD`,
  `DATABASE_URL_PROD`, `MNEMO_MASTER_KEY` and `MNEMO_KEY_PEPPER`. pgBouncer was
  published on every interface with the default password `mnemo`.
* **deps:** `pnpm audit` reports no critical or high advisories. Upgraded
  `next` 16.4.6 (dashboard and the graph-viewer example: remote code
  execution, SSRF and denial of service in image optimization, `next/og`,
  `use cache` and Server Actions), `@modelcontextprotocol/sdk` 1.32.2, `zod`
  4.6.7, `hono` 4.13.19, `@hono/node-server` 2.1.8, `testcontainers` 12.2.1,
  `vitest` 4.1.12, `js-yaml` 5.5.0 and `smol-toml` 1.9.1, and moved the
  transitive `sharp`, `postcss`, `fast-uri`, `proxy-addr`, `body-parser`,
  `ip-address`, `qs`, `undici`, `@grpc/grpc-js`, `brace-expansion`,
  `source-map-js`, `systeminformation` and `vite` to patched releases. The pnpm
  overrides moved back to the root `package.json`, the only place pnpm 9 reads
  them, so they now take effect (in `pnpm-workspace.yaml` they were ignored).
* **deps:** only `@bufbuild/buf`, `bcrypt`, `esbuild` and `fs-ext` run install
  scripts (`pnpm.onlyBuiltDependencies`); `cpu-features`, `msw`, `protobufjs`
  and `ssh2` no longer do. The TypeScript aliases are pinned exactly:
  `typescript` → `@typescript/typescript6@6.0.2` and `@typescript/native` →
  `typescript@7.0.2` (the dashboard's `typescript` too).

### BREAKING CHANGES

* **types:** storage adapters must implement three new required `GraphPort`
  methods: `countEntityMentions`, `findHiddenIds` and `countOpenConflicts`. They
  must also honor the new optional inputs, which still compile when ignored but
  then serve closed rows as current or rows above the caller's ceiling: `openOnly`
  on the decision, entity, strategy, workflow, skill, task and reasoning filters;
  `maxSensitivity` on `FactFilter`, `AuditFeedFilter`, `HyperedgeFilter`,
  `RelationFilter`, `ApplyRelationJudgmentInput`, `getHyperedge` and `closeRelation`
  options, `getRecallStructures` and `getUnresolvedConflictIds`.
  `StorageAdapterContract` (`@mnemo-ai/types/testing`) covers them.
* **core:** `CoreLike` (the legacy dual-core client) is deleted.
  `packages/server/src/deps.ts`'s `ServerDeps.core: CoreLike` field and the
  `CoreLike` interface are gone; `packages/core/src/factory.ts`,
  `factory-types.ts`, and `factory-mappers.ts` are physically removed,
  together with `createCore`/`CoreContract` and the ~30 CoreLike-exclusive
  wire types re-exported from `@mnemo-ai/core`'s barrel. Every HTTP route has
  run on the v3 cognitive engine (`@mnemo-ai/core/cognitive`) +
  `@mnemo-ai/adapter-postgres`'s `DrizzleStorageAdapter` since before this
  change; nothing external needs to adapt. Also deleted, confirmed orphaned
  (zero cron/route callers): `packages/core/src/janitor/` (semantic dedup +
  inactive-pruning), `packages/core/src/summary/` (Layer 1 distilled user
  profile), migrations `0068`–`0072*.sql`. See
  `openspec/flatten-legacy-dual-core/design.md` (D4) and
  `apply-progress.md` (PR19) for the full rationale.
* **core:** the legacy v1.x utility-library surface that predates `CoreLike`
  is deleted from `@mnemo-ai/core`'s public export barrel — confirmed
  orphaned (zero callers anywhere in the repo, internal or external):
  `createEntity`/`getEntity`/`updateEntity`/`findOrCreate`/unresolved-mention
  queue (`./entity`); `createEpisode`/`getEpisode`/`listEpisodes`/
  `linkFactToEpisode` (`./episode` — the synthetic-episode-id helpers
  `deriveSyntheticEpisodeId`/etc. survive, now exported directly from
  `./episode/synthetic`); the v1.3 review queue + auto-pin rules (`./review`
  — the v3 `mnemo_review_queue` route already serves the same table via
  `StorageAdapter`, this was a fully redundant duplicate); the v1.4 REM-style
  consolidation clustering (`./consolidation` — unrelated to the separate,
  live `@mnemo-ai/consolidation` package); the v1.4 per-agent memory policy
  (`./policy`); the v1.4 unified KB+Memory recall (`recallUnified`); the
  v1.1/v2 hybrid recall search (`searchMnemo` and its co-location/multi-term/
  episode-coherence boost helpers, `./recall/search`); `saveFactWithCandidates`
  (`./conflict/fact-candidate`) and `saveFactWithAutoResolve`'s `SaveResult`
  (`./conflict/auto-resolve` — the pure `decideAutoResolution` core both
  wrapped survives, `./conflict/decide`); `createDrizzleStorage`
  (`./storage/drizzle`); the legacy server-only graph query layer
  (`buildGraphData`/`buildGraphQuery`, the `@mnemo-ai/core/graph/server`
  public subpath — removed from `package.json#exports` and
  `tsup.config.ts` in the same commit; the client-safe `@mnemo-ai/core/graph`
  canvas entry is unaffected). The v3 replacements: entity/episode/citation
  primitives are served by `@mnemo-ai/adapter-postgres`'s own repositories;
  graph traversal by `@mnemo-ai/core/cognitive`'s pure-core BFS
  (`traverseGraph`/`findGraphPath`) + `adapter-postgres`'s
  `getGraphSnapshot`/`backfillSemanticNeighbors`; recall by the 7-stage
  hybrid pipeline (`@mnemo-ai/core/cognitive`'s `recallCold`/`recallHot`).
  See `openspec/flatten-legacy-dual-core/design.md` (D5) and
  `apply-progress.md` (PR20) for the full investigation trail.

* **api:** `POST /facts` has been removed. `POST /remember` is now the sole
  write path for facts — it already accepted everything `POST /facts` did
  and additionally runs the surprise gate, §33 conflict detection, and
  vector indexing. Migrate request bodies with a lossless field remap:
  `{content, attribution, tags}` → `{statement: content, attribution, tags}`.
  Response readers should switch `content` → `statement`; the new response
  also carries `confidence`/`status`/`sensitivity`/`conflict.judgmentRequired`
  where the old `Fact` shape did not. `GET /facts`, `GET /facts/:id`,
  `PATCH /facts/:id`, and `DELETE /facts/:id*` are unchanged. See
  `docs/architecture/API.md` and
  `openspec/flatten-legacy-dual-core/design.md` (D2) for the full rationale.
  MCP and CLI already targeted `POST /remember` only — no change needed
  there (their own `coverage-guard` integration-test fixtures that seeded
  facts via raw `POST /facts` were remapped too). `client-ts`'s `createFact`
  keeps its name/signature (remap-only shim, response widened with optional
  `conflict`); `sdk-go`'s `CreateFact` and `sdk-python`'s `create_fact`/
  `AsyncMnemosyneClient.create_fact` do the same body remap and mirror
  `statement` back onto `content` in the returned map/dict for existing
  callers. `packages/dashboard` has no fact-creation call site (confirmed by
  inspection, not assumed) — nothing to remap there.
  (flatten-legacy-dual-core PR9.)

* **core:** `packages/core/src/db/schema/*` (17 Drizzle table-model files +
  `_helpers.ts`) is physically deleted — closing the last literal gap in
  Requirement 8 ("Physical Deletion Is the Non-Negotiable Completion
  Criterion") that a prior revision of this change (PR20) had disclosed as
  a permanent, structurally-required exception. Re-investigated from
  scratch: zero consumer anywhere in the repo (internal or external) either
  imports an individual table object by name or uses Drizzle's relational
  `.query.*` API against `@mnemo-ai/core`'s `DbClient` — every real
  consumer (`tx.ts`'s `withMnemoTx`, `api-key-lookup.ts`,
  `packages/server/src/index.ts`'s own raw-SQL queries) exclusively uses
  `.execute(sql\`...\`)`/`.transaction()`, which does not depend on the
  schema's structural shape. `@mnemo-ai/core/db`'s `schema` export is now
  `{}` (was the 17-table barrel); `Schema`/`DbClient`/`Tx` types are
  otherwise unchanged and still importable. The physical `mnemo_*` Postgres
  tables are entirely unaffected (created by `packages/core/migrations/
  *.sql`, a separate artifact). `packages/core/src/health/{index,compute}.ts`
  is also physically deleted — `getHealthSnapshot` is now a
  `StorageAdapter.getHealthSnapshot` port method (`@mnemo-ai/types`,
  implemented by `@mnemo-ai/adapter-postgres`'s new `HealthRepository`),
  matching the `getWorkspaceVitals`/`getAuditFeed` precedent; `routes/
  admin.ts`, `routes/governance.ts`, and the `mnemo.health.snapshot` cron
  now call `deps.storage.getHealthSnapshot(...)` instead of importing
  `@mnemo-ai/core` directly — same computed-metric definitions, response
  shape unchanged. `packages/core/src/primitives/fact.ts`'s dead CRUD
  (`createFact`/`getFact`/`forgetFact`/`listFacts`/`markRecalled`,
  confirmed zero callers) and `packages/core/src/index/pointer.ts` (whole
  file, confirmed zero callers) are deleted; the still-needed
  `MnemoFact`/`FactKind`/`FactScope`/`FactStatus`/`MemoryType`/
  `EmbeddingTier` type definitions (used by the CI-invoked
  `pnpm bench`/`bench:check`/`bench:quality` scripts and
  `recall/render.ts`) move to a new types-only
  `packages/core/src/primitives/fact-types.ts` with zero infrastructure
  imports. `packages/core/src/primitives/fact-async.ts` (`createFactAsync`,
  its only dependency was the now-deleted `createFact`) is also deleted,
  confirmed zero callers. `LEGACY_INFRA_ALLOWLIST`
  (`packages/core/src/__tests__/v3-purity.test.ts`) shrinks from 25 entries
  to 4 (`tx.ts`, `api-key-lookup.ts`, `cli/migrate.ts`, `db/types.ts`).
  See `openspec/flatten-legacy-dual-core/design.md`/`spec.md` (Requirement
  8 amendment) and `apply-progress.md` (Phase 9) for the full investigation
  trail.
  (flatten-legacy-dual-core Phase 9.)

## 3.6.1-alpha.0 (2026-07-06)

### Fixed

* **ci:** align release manifest to lockstep 3.6.0 across all packages

## 3.6.0-alpha.0 (2026-07-06)

### Fixed

* **ci:** skip per-package GitHub releases to stop tag collisions

## 3.5.0-alpha.0 (2026-07-06)

### Added

* **core,server,client-ts:** asOf temporal filter on main graph endpoint
* **core:** add mnemo_semantic_neighbor table (migration 0073)
* **core:** add mnemoSemanticNeighbor drizzle model
* **core:** kNN semantic-neighbor backfill + edge loader
* **core:** multi-hop temporal relation traversal via recursive CTE
* **core:** thread semantic edges through graph assembly
* **server,client-ts,core:** expose graph traversal and path endpoints
* **server,client:** expose includeSemantic on /v1/graph + SDK
* **server:** add /v1/admin/graph/semantic-backfill endpoint

### Fixed

* **adapter-pg:** episode_id nullable + schema-qualify mnemo_set_workspace
* **adapter-postgres:** populate materialized views on fresh install (F4)
* **ci:** correct migration numbering to restore gap-free sequence 1-5
* **ci:** grant USAGE on mnemosyne schema directly to app_user
* **ci:** rename 0004 migration to 0005 to avoid duplicate prefix
* **ci:** rename migration 0004→0005 to resolve prefix collision
* **ci:** restore 0004 prefix on schema-access migration
* complete Mnemosyne remediation phases A-F
* **core:** fix three fresh-DB crash bugs found by T0.2 empirical audit
* **migrations:** regenerate squash baseline from pg_dump of 75 pre-squash migrations
* **migrations:** renumber post-baseline migrations to 0012-0014
* **rls:** grant DML on public.mnemo_semantic_neighbor to mnemo_app_role
* **security:** C1 cross-tenant authz, C2+H2 RLS policies, H3 pepper guard, 3 CI no-ops, 4 silent failures

### Changed

* **core:** use array form for pgTable extraConfig (non-deprecated)

### Documentation

* **remediation:** mark squash-baseline remediation RESOLVED
* **remediation:** squash baseline is broken — regeneration plan + evidence
* **status:** record 2026-07-01 empirical audit results

## 3.4.0-alpha.0 (2026-07-05)

### Added

* **server:** upgrade OpenTelemetry to v2 with backward compatibility

## 3.3.0-alpha.0 (2026-07-05)

### Added

* **adapter-postgres:** add DrizzleIdempotencyStore.reap() (RLS-safe, non-superuser)
* **adapter-postgres:** add durable mnemo_meter_event table (RLS+BRIN+idempotency) (F15, §35)
* **adapter-postgres:** break-glass two-person request table (F10)
* **adapter-postgres:** DrizzleBreakGlassStore with two-person guard (F10)
* **adapter-postgres:** export DrizzleBreakGlassStore (F10)
* **adapter-postgres:** fold episode residual deltas via applyDelta on reconstruct (F4)
* **adapter-postgres:** GUC-configurable anticipation MV windows, defaults preserved (F21)
* **adapter-postgres:** implement appendMeterEvent + DB-sourced spend/usage queries (F15)
* **adapter-postgres:** implement DrizzleSyncStorage.markSuperseded (RLS-safe federation merge)
* **adapter-postgres:** migration 0073 sync supersession-chain table
* **adapter-postgres:** MNEMO_DEPLOY_MODE-aware pool sizing (embedded/standalone/ha)
* **auth:** reject non-UUID workspace with 400 invalid_workspace (was 500)
* **bedrock:** add complete() support — Claude via Bedrock API Key
* **bootstrap:** self-hosted API key provisioning via push endpoint
* **cache:** add Hash ops (hSet/hGet/hGetAll/hDel) to CacheAdapter port + Redis impl
* **capture:** use workspace LLM provider for passive capture extraction
* **ci:** load-smoke job — 30s k6 recall smoke on every push to main
* **cli:** add mnemo init --docker — full local stack bootstrap in one command
* **cli:** add mnemo init — interactive wizard to configure server + MCP clients
* **cli:** add mnemo install — configures all detected AI coding agents
* **cli:** mnemo init creates user + tenant, accepts all key formats
* **cli:** W6 productionize recall/remember/forget + version + test suite
* **collapse:** wire workspace LLM override into collapseSession + cron sweep
* **config:** add temperature, maxTokens, embedDimensions, embedBatchSize, baseUrl to LLM config API
* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **consolidation:** wire per-workspace LLM into replay validator (P6)
* **core,server:** bridge hot-tier eviction + size into Prometheus via onHotTierEvict hook (F19)
* **core,types:** hybridRecallWeights helper + RecallQuery.embeddingMigrationActive (F28 1/2)
* **core:** add modeled per-metric USD cost table + meterEventCostUsd helper (§35, F15)
* **core:** add optional collapse.storage port to CreateCoreOptions
* **core:** add pure resolveCollapsePolicy helper with spec defaults (F2)
* **core:** buildCollapseContext uses injected collapse.storage (v3 RLS path)
* **core:** collapse reads turns via SessionBuffer durable path + clears Redis on success
* **core:** emit composition + rerank child spans in recallCold
* **core:** emit mnemo.embed child span in recall embedding read-through
* **core:** emit task.completed MnemoEvent on auto-extract alongside Episode (F26)
* **core:** encode spec latency budgets as a benchmark gate (hot/warm/cold/write)
* **core:** lightweight in-process self-edit undo window (revertSelfEdit) (F27)
* **core:** pure computeAnticipationAccuracy helper reading .id (F1 Bug B)
* **core:** re-export METER_UNIT_COST_USD + meterEventCostUsd from v3 barrel
* **core:** reconstruct compression source via applyDelta over residual deltas (F4)
* **core:** SessionBuffer — write-through Redis L1 session tier over PG
* **core:** set recall result attributes on mnemo.recall span (F18)
* **core:** store residual delta vs reconstructed parent in computeDeltaEpisodeLink (F4)
* **core:** wire §36 migration reweight (FTS 0.7/vector 0.3) into cold recall (F28 2/2)
* **core:** wire optional eps-DP embedding noise (MNEMO_EMBEDDING_NOISE, default off)
* **federation:** honor since cursor for incremental item pulls
* **federation:** thread conflictResolution into both prod apply paths
* **fed:** W3 federation soak — dual-node HTTP test, STABLE
* **fed:** W3 federation soak — STABLE
* **idempotency:** expose recovery_point + phase recorder on request context (spec §RDD9)
* **idempotency:** record collapse phases + resume on retry (spec §RDD9 F16)
* **idempotency:** recovery_point on Redis + in-memory live stores (spec §RDD9)
* **idempotency:** recovery_point port methods + Drizzle impl (spec §RDD9)
* **idempotency:** selectable Postgres recovery-point store (MNEMO_IDEMPOTENCY_STORE=postgres)
* **mcp:** accept §29 introspect aspects via alias mapping to §31 backend (F22)
* **mcp:** add memory_doctor — 27th tool with 8 operational diagnostics
* memory_context MCP tool + mnemo info CLI command
* **multi-tenant:** add tenant/user/workspace tables + scope_owner field (Gap 1+2+3)
* **multi-tenant:** bind user_id + tenant_id to auth context (Gap 5)
* **multi-tenant:** HTTP routes for tenant/user/workspace management (Gap 1+2)
* **multi-tenant:** multi-level recall — workspace + user + tenant (Gap 4)
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** RLS policies for tenant/user/workspace tables + withMnemoTenantTx
* **multi-tenant:** targetWorkspaceId on memory_remember — write to any accessible workspace
* **observability:** add CoT resolve latency histogram (topic_key|vector)
* **observability:** compute roi_multiplier metric + ROI&lt;1.5 burn alert
* **observability:** inject W3C trace context on outbound federation/webhook/outbox calls
* **obs:** W2 observability completion — rules wired, validator extended
* **obs:** W2 observability completion — rules wired, validator extended
* orchester-mnemosyne connection fix & hardening
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
* **p6:** dynamic LLM config per workspace — DB-stored, hot-swappable
* **P7/P13/P14:** API key management + /me identity + doctor CLI
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* plugin marketplace + standalone binary builds
* **plugin:** add Claude Code plugin + workspace mapping (P3)
* **quality:** LLM-enhanced consolidation, recall reranking, remind_when, anticipate
* **remember:** accept host-side precomputed embedding vector
* **sdk-go:** accept Idempotency-Key option on all mutating methods (TS/Python parity)
* **sdk-go:** add zero-dep idempotency key helper + request-option mechanism
* **sdk-go:** thread Idempotency-Key option through retry-stable request path
* **security:** provision non-superuser DB role so production passes assertSafeDbRole
* **server:** /v1/break-glass request + approve routes (F10)
* **server:** /v1/usage + /v1/cost read durable DB-sourced usage & spend (F15)
* **server:** distinguish EMPTY_SCOPE vs INSUFFICIENT_SCOPE in scope-guard 403
* **server:** drive SyncEngine.processBatch from gRPC FederationSync stream (F20)
* **server:** durable meter write-through + DB-sourced usage + boot persister cron (F15)
* **server:** emit mnemo.auth span from createAuthMiddleware
* **server:** emit queue_depth gauge from pending outbox count
* **server:** gate mk_admin_ privileged ops behind break-glass two-person grant (F10)
* **server:** gRPC session collapse threads per-agent CollapsePolicy (F2)
* **server:** HTTP collapse handler threads per-agent CollapsePolicy (F2)
* **server:** inject DrizzleStorageAdapter into factory collapse (collapse.storage)
* **server:** route session turn/scratch/pin through write-through SessionBuffer
* **server:** sweep resolves per-agent CollapsePolicy instead of hardcoded 50/8192/30min (F2)
* **server:** thread CALMem tokenBudget + RecMem rerank into POST /v1/recall
* **server:** wire DrizzleBreakGlassStore through ServerDeps + boot (F10)
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **types:** add appendMeterEvent + getMonthToDateUsageFromDb storage port methods (F15)
* **types:** add deterministic dependency-free text-delta codec (DELTAMEM §16)
* **types:** add optional RecallHit.embedding for RecMem rerank gate
* **types:** BreakGlassStore port + InMemory double (F10)
* **types:** declare 5 missing domain span names
* **types:** extend MnemoSpanAttributes with spec fields + mnemo.write alias (F18)
* **types:** fold episode residual deltas via applyDelta in InMemoryStorageAdapter (F4)
* **W0:** Quality Baseline & CI Hard Gate
* **W1:** performance baseline — k6 load scripts + CI smoke gate
* **w4:** core cognitive validation + API surface freeze gate
* **wave-ac3:** close final 0.5% spec gap — contract tests + per-workspace anticipation gauge

### Fixed

* **adapter-postgres:** add mnemo_set_workspace GUC to session read methods
* **adapter-postgres:** GRANT SELECT on mnemo_outbox to mnemo_app_role (queue_depth gauge)
* **adapter-postgres:** migration linter exempts CREATE INDEX on same-migration new tables
* **adapter-postgres:** OutboxWorker silently no-ops due to snake_case/camelCase mismatch
* **adapter-postgres:** query mnemo_fact (not mnemo_facts) in listWorkspaceIds
* **adapter-postgres:** rename outbox payload key statement→text in createFact
* **adapter-redis:** skip hash integration test when no Redis URL is set
* **bedrock:** support Bedrock API Key (Bearer token) — no AWS SDK needed
* **ci:** add --force to turbo run test to bypass stale cache
* **ci:** add vector extension + missing api_key columns to squash baseline
* **ci:** align vitest versions — coverage-v8@4.1.9 requires vitest@4.1.9
* **ci:** allow legacy empty-scope key in load smoke server
* **ci:** allow superuser DB role in load-smoke server startup
* **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
* **ci:** disable turbo cache for test task — missing outputs caused false failure reports
* **ci:** pin vitest@4.1.9 in adapter-postgres to match coverage-v8@4.1.9
* **ci:** pin vitest+coverage-v8@4.1.9 via pnpm overrides to prevent mixed version warning
* **ci:** unblock load-smoke — schema mismatch + alias intercept + plan upgrade
* **ci:** unblock red main tip from multi-tenant batch (4 jobs)
* **ci:** update lockfile to match pinned vitest@4.1.9 in adapter-postgres
* **ci:** use bcrypt hash for smoke API key, not argon2
* **ci:** use valid API key format in load smoke job
* **ci:** wire adapter-postgres migrations + stub embed for load-smoke
* collapse RLS v3 read-path — anticipation gauge non-null under prod role
* **config:** rename REDIS_URL → MNEMO_REDIS_URL in all deploy configs
* **core:** add missing public schema v3 columns via migration 0072
* **core:** add search_path + v3 GUC to all postgres pools and withMnemoTx
* **core:** collapse reads anticipation .id via pure helper; non-silent catch — F1 Bug B
* **core:** collapseSession fallback close uses ctx.storage (RLS-safe)
* **core:** complete telemetry span mocks broken by A2 child spans (recall-cold)
* **core:** default collapse per-turn mode to 'auto' not invalid 'standard' (F2)
* **core:** pass anticipation slot object to workSet (single-encode) — F1 Bug A
* **core:** populate cold-path hit embeddings so RecMem rerank gate can skip the LLM
* **docker:** remove PORT from override — port conflict broke server when override was applied
* **federation:** reject plaintext pull when peer keys configured (F9)
* **migrations:** 0002 handles duplicate table when 0001 baseline already created it in mnemosyne
* **migrations:** add scope_owner column to mnemosyne.mnemo_fact (0007)
* **migrations:** grant SELECT to mnemo_owner on v3 tables + update-checksums command
* **migrations:** recreate mv_confidence_map and mv_knowledge_gaps dropped by CASCADE
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **plugins:** remove noExternal yaml to stop dynamic require("process") crash
* **remember:** apply fact embeddings synchronously + authoritatively (Bug 2)
* **scripts:** create-api-key generates/validates UUID workspace
* **security:** consolidate public.mnemo_* tables into mnemosyne schema — fixes S2 RLS bypass
* **server:** deny empty-scope full-access bypass by default (F11)
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status
* **server:** encrypt webhook signing secret at rest with workspace KEK (F12)
* **server:** enforce RDD-7 self-edit per-day caps on gRPC SelfEdit
* **server:** fail-closed encryption boot gate (F8)
* **server:** fail-closed RBAC limit deps boot assertion (F11)
* **server:** import writes all 11 entity types with explicit skip accounting (F13)
* **server:** JSONL export covers decision/entity/strategy/workflow (4 missing spec types)
* **server:** recall without embedder returns 501 not 500
* **server:** register mountMemory route in app.ts
* **server:** route WS gap frame through subscriber buffer to preserve event ordering
* **server:** ship runtime workspace deps so the image boots
* **server:** wire §19 activeSessions dep so production boot passes assertRbacLimitsWired
* **server:** wire collapse adapters into factory core so §30 anticipation gauge works (F1)
* **server:** wire webhookSecretCipher into delivery cron + test /webhooks/:id/test route
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
* **test:** align CI-failing tests with F9 reject-by-default + F11 scope guard
* **tests:** mark Date.now() in workspace mapping test as determinism-ok

### Changed

* **adapter-postgres:** explode DrizzleStorageAdapter 5582→507 lines
* **core:** rename CoreLike → CoreContract, keep CoreLike as alias
* **core:** split factory.ts 2922→1900 lines into 3 focused modules
* **dry:** add getAuthCtx helper, replace 51 inline c.get() auth extractions
* **dry:** centralize toIso helper and offset/limit pagination schema
* **load:** add k6 scenario scripts (recall, remember, collapse, mixed)
* **load:** add k6 shared lib helpers (auth + payload)
* **load:** add seed script and load/README
* remove all v1/v2/v3 version labels from codebase
* **security:** centralize sensitivity ceiling checks into rbac.ts helpers
* **server:** drive inactivity sweep from sess:active ZSet, remove per-session N+1 connection
* **server:** extract boot sections from index.ts into src/boot/
* **server:** share RDD-7 self-edit counter keys between HTTP and gRPC
* **server:** split routes/index.ts 1297→78 lines into domain route files
* **server:** undo duplicate mountMemory in app.ts

### Documentation

* **backlog:** add P6 — dynamic LLM config with per-workspace fallback
* **backlog:** add P7-P14 — auth/keys/multi-user/workspace management gaps
* **backlog:** mark P1-P5 complete, add deuda técnica T1-T4
* **claude:** document typecheck requires prior build — not a code error
* **client-ts:** correct stale /v1 path comment in buildUrl
* **cli:** update README with all 20 commands including list/search/show/init --docker
* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* **core:** fix worth.ts header to Beta(2,2) posterior mean α/(α+β) (F23)
* **mcp:** comprehensive MCP user guide — 32 tools, setup options, passive capture, FAQ
* **perf:** replace aspirational banner with W1 measurement methodology
* **plan:** collapse v3 workspace-RLS read/write path remediation plan
* **plan:** harden W0 sub-plan for Sonnet execution (review pass)
* **plan:** road-to-Stable 1.0 — work plan to earn 100/100 (all packages Stable)
* **plans:** mark all implementation plans COMPLETED + add index README
* **plan:** spec-fidelity closeout — 17 tasks across 8 waves (A–H)
* **plan:** W0 sub-plan — quality baseline & CI hard gate (bite-sized, TDD)
* README polish — consistent comparison-table markers + status legend
* **readme:** fix port 3939→3000 and migration count 74→75
* **recall:** document CALMem tokenBudget + RecMem rerank activation contract
* reconcile package maturity labels — honest, consistent Beta across all docs
* reconcile spec topology + record spec-vs-impl deltas (closeout)
* **remediation:** add 2026-06-21 spec-100 remediation plan
* remove stale root STATUS.md duplicate
* retract premature 100% claim; correct task tracker (#113/#116/#118/#119, AC3 gauge) (F30)
* scope model gap analysis for product review
* **sdk-go:** document Idempotency-Key usage in package overview
* second accuracy pass — fix broken SDK examples + remaining fictional refs
* **security:** scope break-glass custodial steps as out-of-band (F10)
* **security:** specify mk_admin_ two-person break-glass approval (F10)
* STATUS.md — W1 Performance Baseline complete
* STATUS.md — W4 core cognitive validation complete
* STATUS.md records collapse RLS v3 read-path fix
* STATUS.md W5 consolidation scale-correctness complete
* **status:** update W0 quality gate completion — coverage + contracts + determinism
* track WIP plan docs (spec100 remediation, W1 perf, W2 observability)
* **types:** correct stale hyperedge comment + add e2e member-expansion test
* **w11-w12:** soc2 evidence real + planned banners dropped + api stability + tier flips
* W6 ground-truth verification in STATUS.md
* W7 ground-truth verification in STATUS.md
* **w9:** formally drop k8s/Helm for v1.0, bless Fly.io as Cloud target

## 3.2.0-alpha.0 (2026-06-21)

### Added

* **api:** Task 12 — 7 missing REST endpoints
* **api:** Task 15 — /v1/memory/* compatibility aliases for canonical /v1/* paths
* **ci:** wire §29 quality gate — bench:quality script + CI step
* **cli:** add shell completion + wire previously unreachable AB6.3 commands
* **composition:** lazy-seed built-in composition rules on first workspace write
* **events:** onEventRecorded hook + builtin reactions (close-fact / worth-decrement)
* **mcp:** Task 13 — workflow + skill tools and event.annotate action
* **obs:** Task 11 — Tempo + Loki + Grafana dashboards + Postgres tuning
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* Phase 1 — close all 8 correctness/security spec bugs (C1–C7, C9)
* **plugins:** add createTask + createEpisode to PluginContext
* **plugins:** ctx.createEvent — persist via storage.createEvent before bus emit
* **plugins:** ctx.createFact — storage path + clampSensitivity + subject/metadata
* **rbac:** enforce maxSelfEditsPerSession + maxSessionsConcurrent limits
* **rbac:** enforce taskScopes.canCreate + canDelegate/canDelegateTo in task handlers
* **rbac:** map granular 15-scope vocabulary per route/RPC family
* **rbac:** MNEMO_RBAC_DEFAULT_DENY zero-trust flag
* **rbac:** reach cross_agent_read trigger via x-mnemo-target-agent header
* **recall:** route POST /v1/recall through worth-gated v3 three-tier cascade
* **resilience:** Redis-backed idempotency + jti stores + 72h reaper
* **self-edit:** wire RDD-7 strengthen/weaken daily budget counters (Task 4)
* **spec-100:** Phase 2 Security Enforcement — 9 tasks complete
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **webhooks:** delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable

### Fixed

* **adapter-postgres:** C1 — correct DEK encoding, outbox plaintext leak, workspace-scope DEK pk
* **adapter-postgres:** encrypt audit detail with actor DEK + crypto-erasure read state (C3)
* **adapter-postgres:** implement updateSessionSummary so collapse summary persists (C5)
* **adapter-postgres:** logRecall writes fact_id(TEXT)+activation_score (C4)
* **adapter-postgres:** provision per-actor DEK and fail closed on confidential writes (C1)
* **adapter-postgres:** serialize audit appends + hash only spec fields (C2)
* **adapter-postgres:** serve Beta-Bernoulli worth for strategy/workflow/skill/reasoning (C7)
* **audit:** thread real actor_type through the audit trail
* **authz:** self_edit scope guard matched /self-edit but routes are /self/edit — scope was never enforced
* **ci:** canary SLO query uses emitted mnemo_recall_duration_seconds metric (C9)
* **migrations:** 0056 episode index plain CREATE INDEX + linter allow-marker (fixes CI integration)
* **migrations:** legacy public schema v3-compat (worth + sensitivity + api-key cols)
* **migrations:** runners honor no-transaction via dollar-quote-aware statement splitter (fixes CONCURRENTLY)
* **procedural:** monotonic prompt versioning + session A/B stamping
* **rbac:** thread taskScopes.canDelegateTo allow-list (supports '*')
* resolve 2 pre-existing test failures blocking green gate
* **server,core:** thread CollapsePolicy from agent profile into collapse pipeline (C6)

### Documentation

* **audit:** independent adversarial re-audit vs MEMORY_IMPROVEMENT.md — honest ~78%
* **plan:** path-to-100 implementation plan for Sonnet (P0→P2, TDD, exact edits)
* post-remediation spec comparison + path-to-100 (v3.1.0-alpha.0)
* spec-coverage audit + path-to-100% implementation plan

## 3.1.0-alpha.0 (2026-06-19)

### Added

* §30/§31 — anticipate lookAhead+context params; introspect limit
* **aa2.2:** WS replay engine — ID stamping, resubscribe handler, replay singleton
* **aa2.3:** REST catch-up GET /v1/memory/events?since=&channel=
* **aa2.4:** embedding-model migration engine
* **aa2.5:** hot-tier dump engine — ZSet→PG→reload on boot/shutdown
* **adapter-postgres:** Drizzle worth = α/(α+β) (Wave C2)
* **adapter-postgres:** migration 0013 — Beta-Bernoulli worth posterior (Wave C1)
* **adapter-postgres:** migration 0016 — metacognition MVs (Wave F1)
* **adapter-postgres:** migration 0017 — anticipation MVs (Wave G1)
* **adapter-postgres:** migration 0032 — mnemo_access_policy + mnemo_approval_request (§19)
* **adapter-postgres:** P0-2 vB — production DrizzleApiKeyStore + migration 0055
* **adapter-postgres:** P2 — apply procedural/reasoning Beta decay + migration 0053
* **adapter-postgres:** updateWorth bumps α/β + raw counters (Wave C3)
* **adapter-postgres:** zero-downtime migration safety — 5-check linter + no-transaction runner + CI shadow-apply (spec §35)
* **adapter,core:** LSH population path — remember→outbox→worker→mnemo_fact_lsh (spec §17)
* **adapter,types:** anticipation view read methods (Wave G2)
* **adapter,types:** meta-cognition view read methods (Wave F2)
* **adapter,types:** real episode depth + reconstructEpisode (spec §16)
* **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
* **adapter:** mnemo_fact_lsh table + lookup index migration 0023 (spec §17 Tier 2)
* **adapter:** partial unique index idx_fact_topic on mnemo_fact migration 0024 (spec §25.4)
* **anticipation:** 4-way blend + conditional/co-occurrence patterns + pre-injection (spec §30)
* **auth:** add key expiry + scope enforcement (P0.1 + P0.3)
* **auth:** P0-2(A) — §6 key deprecation grace on the live key scheme
* **billing:** 7-type meter events + 5-min aggregation + overage throttle + spend alerts + /v1/usage (spec §35)
* **cache:** §9 L2/L3 cache layers + Redis-down degradation ladder
* **chaos:** 6 resilience experiments + harness + weekly workflow + gameday runbook (spec §35)
* **ci:** OPS-8 — migration safety linter covers full committed v3 set
* **client-ts:** tasks/events/reasoning flat methods (Wave A6)
* **consolidation-mcp:** activate memory_consolidate + consolidation scheduler in server boot
* **consolidation:** add background scheduler — 60s interval, top-20 candidates
* **consolidation:** wire ReplayValidator into scheduler (P1.4)
* **core,adapter:** entity-keyed confidence map + coverage/freshness + trends + strengths + suggestedAction (spec §31)
* **core,governance:** §11 promote/demote/canonical actions + max-5-hop TD + governance.propagate
* **core,types,adapter:** kind-differentiated decay + Hebbian STDP/homeostatic (Wave Y1, §25.2/§25.3)
* **core,types,adapter:** materialiseInference port + composition engine (Wave H2)
* **core,types,adapter:** TD(λ) propagation + Wilson-score lower bound (Wave J3)
* **core,types,redis:** monotonic event ids + Redis-list replay buffer ops (§35)
* **core,types:** compositionality relation/fact_value DSL + multi-hop + warnings + conflicts + 4 seed rules (spec §32)
* **core,types:** hyperedge expansion in recall-cold stage 3b + outbox bump (Wave D4)
* **core,types:** wire composition hook into recall-cold; extend RecallHit/RecallResponse (Wave H3)
* **core:** §17 — hot-tier near-duplicate suppression (embedding-free)
* **core:** §29 — absolute quality gates + v1.6↔v3.0 comparison
* **core:** §29 — deterministic synthetic eval corpus + end-to-end harness
* **core/adapter:** RSN-1 — A/B session measurement + procedural transition
* **core/cron:** COG-1..3 — wire governance actions into production cron
* **core/types:** RDD-1..5 — outcome signals, dedup gate, learning mode
* **core:** buildAnticipationFeed — anticipation envelope (Wave G3)
* **core:** buildSelfModel — §31 meta-cognition envelope (Wave F3)
* **core:** composition hook on hot-tier recall path (Wave J2)
* **core:** DELTAMEM — episode embeddings + delta-episode auto-formation
* **core:** enforce worth serving gate + λ-drift time decay (spec §11)
* **core:** Experience-Compression cross-level episode-subtree compression (spec §2)
* **core:** fact topic-key idempotent upsert mirroring decision.ts (spec §25.4)
* **core:** hyperedge recall includes members (spec §15)
* **core:** L0 working memory — workGet/Set/Checkpoint/bloom/rateLimit (spec §9)
* **core:** P0-4 — wire §33 saveFactWithAutoResolve into the live write path
* **core:** P1/P2 cognitive remediation (workflow, verified green)
* **core:** pure §34.8 queue priority map + 3-stage shedding decision
* **core:** pure in-process typed event bus (spec §4)
* **core:** pure RBAC decision engine + namespace policies (§19)
* **core:** pure SimHash LSH banding over first 64 Matryoshka dims (spec §17)
* **core:** service-to-service federation JWT (EdDSA) + jti replay-prevention (§6)
* **core:** Tier 2 pointer recall + CALMem token-budget pre-stage (spec §17)
* **core:** UCE knowledge-type scheduler + collapse extraction bias (spec §10,§7)
* **core:** unify RecMem recurrence gate + add gated recall rerank (spec §1/§2,§7)
* **core:** wire session collapse pipeline — replace stub with 8-step collapse.ts call
* **cron:** COG-4..8 — real bodies for 5 remaining empty cron handlers
* **cup:** add v2→v3 migration CLI runner — batch ingestion with progress tracking
* **deploy:** canary SLO auto-rollback decision + SloRollbackMonitor + pipeline/DR runbooks + weekly test-restore (spec §35)
* **dx:** type/param error format + mk_test_ sandbox keys + CLI subcommands + mock server (spec §35)
* extend PrimitiveKind with hyperedge + updateWorth support (Wave D5)
* **federation-sync:** InMemorySyncStorage + SyncEngine wiring — POST /sync executes real peer sync
* **federation,core:** §33 complete — resolveConflict 4 rules + federatedConsensus contested + saveFactWithAutoResolve
* **federation:** §20 core — announce/mesh, scoped incremental sync, Ed25519+GCM payload, 4-rule apply path
* **federation:** DrizzleSyncStorage persistent sync state in Postgres (migration 0011)
* **federation:** H10 — vector-clock CRDT in SyncEngine for causal ordering
* **federation:** HTTP routes, InMemoryPeerStore/JobStore, server boot wiring
* **federation:** implement HTTP pull transport (PullClient + /items endpoint)
* **federation:** LWW conflict resolution — remove POST /resolve 501
* **federation:** make §33 federatedConsensus reachable from SyncEngine (trust-weighted reconcile)
* **federation:** make /peers/pending self-describing (discovery.enabled=false)
* **federation:** mk_fed_ &lt;-&gt; mTLS binding + TLS 1.3 assertion (§3/§6)
* **federation:** P0-1 — wire app-layer Ed25519+AES-GCM crypto into serve/pull
* **federation:** P0-1/P1 — app-layer crypto + merge strategy + scoped sync
* **gdpr:** per-actor DEK for crypto-erasure (P1.2)
* **mcp:** add memory_compose MCP tool — list/create/patch/dry-run composition rules (Wave H5)
* **mcp:** memory_event tool (Wave B2)
* **mcp:** memory_hyperedge tool — 20 tools total (Wave D3)
* **mcp:** memory_reasoning tool (Wave B3)
* **mcp:** memory_self_edit tool (Wave B5)
* **mcp:** memory_strategy tool + HTTP routes + SDK methods (Wave B4)
* **mcp:** memory_task tool (Wave B1)
* **mcp:** P1 §24 — unified memory_session tool + task/strategy domain verbs
* **obs:** completion-path LLM token metrics via hexagonal usage hook
* **observability:** Phase D — real OTel adapter, domain counter wiring, USE gauges, metrics alias, docker port fix, webhook dispatcher
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* **p2:** merge Wave A–I — §30-33, compositionality, anticipation, consensus
* **perf:** coalescer + batch embedding + cursor pagination + slow-query thresholds (spec §35)
* **pii:** NER layer (Phase 5.2) + LLM layer (Phase 5.3) for PII detection
* **plugins:** full MnemoPlugin hook surface + 9 built-ins + state + config discovery (spec §21)
* **plugins:** PluginLoader with in-process plugin support + server boot wiring
* **prospective-memory:** reminders schema, evaluator, HTTP routes, MCP tool activation
* **reasoning:** CoT distillation cache loop — resolve/record/feedback + quarantine/golden (spec §8)
* **reasoning:** RSN-2 procedural unit tests, RSN-4 durable self-edit budgets, RSN-5 fix memory_introspect description
* **recall-log:** TASK-4001 — mnemo_recall_log, port methods, DrizzleStorageAdapter, Stage 4 ACT-R
* **reminders:** 30s background evaluation polling — time-based auto-trigger
* **sec:** per-key sensitivity ceiling — recall honors the API key's maxSensitivity
* **security:** P0.1+P0.3+P0.2+P0.4+P1.2+P1.3+P1.4 — full security hardening sprint
* **security:** SEC-2 — IP allowlist + key-type prefixes (migration 0051)
* **security:** sensitivity ceiling on GET /facts routes (P0.2)
* **security:** Wave X1 — recall-path injection/anomaly/cache-poisoning detection
* **security:** Wave X2 — access-path detection, export approval gate, GDPR hard delete
* **self-edit:** Wave M2 — Self-Editing Memory with 6-action policy + agent profile + reflection cadence (spec §13)
* **server,adapter:** idempotency keys + date versioning + multi-layer rate limiting (Wave T1, spec §35/§34.9)
* **server,client-ts:** add composition admin routes + client namespace getter (Wave H4)
* **server,client-ts:** hyperedge HTTP routes + SDK flat methods (Wave D2)
* **server,federation:** workspace region-lock + cross-region metadata-only federation + residency docs (spec §35)
* **server,mcp,client-ts:** /v1/anticipation + memory_anticipate (Wave G4)
* **server,mcp,client-ts:** /v1/metacognition + memory_introspect (Wave F4)
* **server,types,adapter:** single cron registry + verify.codebase + all missing §28 crons (Wave Y2)
* **server,types:** H7 — validateTestKeyBinding in ScopedApiKeyAdapter.authenticate()
* **server:** §19 — enforce per-agent rate limits (limits.*)
* **server:** §22 — reasoning_tokens_saved + log↔trace correlation; fix duplicate metric
* **server:** §22 — register remaining metric families + wire recall_empty/federation_conflicts
* **server:** §3 — canonical MNEMO_001..010 operational error-code registry
* **server:** §34.6 — validate composition DSL verbs/ops at create (400)
* **server:** §35(n) — decision.created/superseded webhooks (12/12 canonical events)
* **server:** §35p — wire the embedding-migration cron (mnemo.embed.migration)
* **server:** /v1/events routes (Wave A4)
* **server:** /v1/reasoning routes (Wave A5)
* **server:** /v1/tasks routes (Wave A3)
* **server:** add webhook event dispatcher for domain events (OPS-6)
* **server:** anticipation mining cron + STATUS update (Wave G5)
* **server:** API-1..4 — governance REST routes + admin stats
* **server:** API-5..8 — implement 4 Unimplemented gRPC RPCs
* **server:** DrizzleSyncStorage swap + session inactivity sweep
* **server:** emit 11 lifecycle events onto bus (spec §4)
* **server:** full 15-scope guard mapping incl. hard_delete/governance/subscribe (§6)
* **server:** gRPC streaming RPCs over the Wave Q event bus (spec §4 R2)
* **server:** gRPC/ConnectRPC transport — proto + buf codegen + 7 unary RPCs (spec §4 R1)
* **server:** H2 — wire Prometheus metrics into business route handlers
* **server:** H5 — wire emitMeter billing calls into route handlers
* **server:** metacognition refresh cron at boot + STATUS update (Wave F5)
* **server:** mnemo_queue_* + mnemo_ws_* backpressure metrics (§34.8/§34.10)
* **server:** P0-2 vB — mount scoped-key auth alongside live keys (dark-launch)
* **server:** P1 — recall tiering + workflows/skills routes, gRPC Session/Import, webhooks, metrics
* **server:** per-WS-connection ring buffer + slow-consumer + drop-oldest (§34.10)
* **server:** RBAC policy middleware (60s cache) + approval-gate 202/resume (§19)
* **server:** SEC-1 — mount RBAC policy + approval-gate middleware
* **server:** shared row→wire mappers for task/event/reasoning (Wave A1)
* **server:** shedding gate wrapping QueueAdapter (§34.8)
* **server:** W4.3 wire mTLS+service-JWT binding into federation sync route
* **server:** Wave R — gRPC/ConnectRPC transport (spec §4 R1 + R2 + R3)
* **server:** WebSocket subscriptions at /v1/memory/ws (spec §4)
* **server:** wire plugin hooks into facts/recall routes + PluginContext builder (spec §21 U1.6+U1.7)
* **server:** wire Redis hot tier into v3 core boot (gated on MNEMO_REDIS_URL)
* **server:** wire v3 MnemoCore — remember/forget/recall use full v3 pipeline
* **session-collapse:** wire factory.collapseSession() to real pipeline + activate episode MCP
* **session:** pins + scratchpad + token/turn triggers + linking episode + hot-promote (spec §7)
* **storage:** add listWorkspaceIds() to StorageAdapter port, DrizzleStorageAdapter, InMemoryStorageAdapter
* **tasks:** state-machine guard + delegate + auto-extract + event annotations (spec §18)
* **types,adapter-postgres:** AccessPolicyStore + ApprovalStore ports + adapters (§19)
* **types,adapter-postgres:** hyperedge CRUD port + adapters (Wave D1)
* **types:** 15 spec memory scopes + spec-shaped AgentMemoryAccess/ApprovalTrigger (§6,§19)
* **types:** composition rule DSL schemas + DerivedInference (Wave H1)
* **types:** InMemory adapter Beta-Bernoulli parity (Wave C4)
* **types:** pointerCandidates + upsertFactLsh ports + lsh_upsert outbox event (spec §17)
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **ver:** VER-1 — benchmark regression gate (tsx + check-regression + baseline + CI job)
* **ver:** VER-2 — load-test harness (server.ts + run.ts + README)
* **ver:** VER-3 — recall-quality harness: eval-fixture.json + R@5≥0.95 integration test
* **ver:** VER-4 — full sweep script, verify:all, and phase-f verification record
* Wave T — standards + security hardening
* Wave W Part A — §33 Distributed Consensus + §20 Federation Protocol core
* Wave W Part B — §19 Agent RBAC + Approval Gate + §6 mTLS + Service JWT
* Wave Y — Engram Neuro-Dynamics + Cron Registry (§25/§28)
* Wave Z — Cognitive Completeness (RecMem, UCE, Compression, Governance, Cache)
* **wave-aa:** Backpressure & Resilience — shedding, WS replay, embed migration, hot-tier dump
* **wave-ac:** schema & contract completeness — final sweep (AC1–AC4 §34.6/7/9)
* **wave-i:** §33 Distributed Consensus — TRUST_ANCHORS, resolveConsensus, supermajority /resolve
* **wave-k:** correctness fixes — consolidation gate, worth gate, hyperedge members, delta episodes
* **wave-s:** SDK completion — TS federation endpoints, Python SDK, Go SDK
* **wave-t:** T2 auth hardening — argon2id, break-glass MFA, key rotation, anomaly detection
* **wave-t:** T3 encryption at rest — DEK→KEK hierarchy, column-level PII, ε-DP noise, KEK rotation
* **wave-t:** T4 OutcomeSignal + cold-start learning mode + stale-task cron
* **wave-u:** §14 Procedural Memory — metaprompt evolution engine + HTTP routes + weekly cron (U2+U3)
* **wave-v:** §22 Observability + §26 Infra + §29 Benchmarks + §27 CUP keyset + §36 Webhooks/Export/Contracts
* **wave/p:** Retrieval Tier 2 — POINTER/LSH + fact topic-key upsert
* **webhooks:** HTTP delivery, HMAC signing, CRUD endpoints, DB migration
* **webhooks:** Stripe-style t=ts,v1=sig format with 300s replay window (P1.3)

### Fixed

* §15 Hebbian relation weight (wrong relation) · §31 introspect limit (MCP+client)
* **adapter-postgres:** add types:node to tsconfig — resolves Buffer/process IDE errors
* **adapter-postgres:** exclude *.down.sql from the forward migration runner (data-loss guard)
* **adapter-postgres:** materialiseInference — single atomic db.transaction()
* **adapter,types:** guard cross-workspace parent lookup in createEpisode
* **adapter:** decayKind kind-filter + per-row elapsed time + RETURNING row count
* **c11:** wire propagateTdCredit in collapseSession
* **c9:** wire PII column encryption in createFact (GDPR crypto-erasure)
* **ci:** doc-lint tool count 14→23 + add mnemo_owner role to baseline migration
* **ci:** make migrations, typecheck, tests, and docker build all green
* **ci:** resolve both adapter and server integration test failures
* **client-ts:** typed returns, AbortSignal, pruned enum, JSDoc, tests (Wave A6 quality)
* **cog:** enforce self-edit cooldown + log working-memory fallback eviction
* **consolidation:** align gate with spec §12 — cluster≥3, worth&lt;0.5, 14d recency, conf≤0.7, admin-lock, rollback
* **consolidation:** quality fixes from K1 review — cosine extract, fail-closed lock, rollback log
* **consolidation:** unref() cast to {unref(): void} — avoids NodeJS namespace requirement
* **core,adapter:** quality review fixes — correct LSH embedding indexing, embed-error fallback, outbox guard
* **core,adapter:** remove stale createHash import, fix unused e var, use array form for Drizzle table config
* **core,federation:** decideAutoResolution explicit confidence gate + zero-llm fix
* **core:** §25.2 — make kind-differentiated decay actually run (semantic + crons)
* **core:** §33 — run deterministic consensus on the production fact-write path
* **core:** enforce sensitivity ceiling in the hot tier (recall-hot)
* **core:** handle concurrent topicKey upsert race + index predicate audit
* **core:** LSH planes must be 64-dim not 8-dim (spec §17)
* **core:** remove unused hotTierKey import in recall-hot-composition.test.ts
* **core:** restore DTS build by using .returning() without field selectors
* **core:** wire maybeRerank into recallCold pipeline (spec Z-A1.3 Step 12)
* **cron:** RDD-3 — stale-task cron flags at 14d instead of auto-archiving at 7d
* **docker:** don't re-leak workspace: peers in the generic peer-lift pass
* **docker:** install node-gyp toolchain in the build stage
* **docker:** OPS-5 — reconcile prod compose port with server listen port
* **docker:** pack adapter-redis tarball + generalize peer-dep lifting
* **docker:** skip optional workspace peers without tarballs + pack consolidation
* **docs:** patch 2 cold-LLM gaps — memory_episode_end stub + surprise gate formula
* **federation:** use static import + globalThis in tests after pull transport
* **gdpr:** SEC-3 — make DEK destruction fatal in GDPR hard-delete path
* **mcp/sdk/plugins:** expose asOf + anticipation context/lookAhead; clamp plugin write sensitivity
* **mcp:** cast typed SDK returns through unknown to satisfy TS2352
* **mcp:** double-cast structuredContent in self_edit for strict TS
* **mcp:** introspect structuredContent cast to unknown first (Wave F5 typecheck)
* **migrate:** provision both schemas — resolve dual-core deploy gap (finding #0)
* **migrate:** provision both schemas — resolve dual-core deploy gap (finding #0)
* **migration:** 0054 down — add migrate:allow-drop marker for the safety linter
* **obs/sec:** enrich /health/deep, per-operation rate-limit matrix, escalate Merkle tamper
* **obs:** emit mnemo_requests_total globally + route label; emit-or-delete dead metrics
* **ops:** P0-5 — instantiate the §34.8 job-shedding gate at boot
* **ops:** standardise docker/fly port to 3000 (OPS-5)
* **rdd:** RDD-7 — correct composition rule verbs and confidences to spec
* **rdd:** RDD-8 — restore anti-gaming caps (maxStrengthens=3, maxWeakens=5) + per-fact daily strengthen cap
* **reasoning:** recordReasoningUse on resolve HIT + InMemory updateWorth/queryReasoning fixes
* **recall-log:** uuid() instead of node:crypto, explicit type cast in recall-cold Stage 4
* **recall:** degrade gracefully to lexical-only when no LLM provider configured
* **sec:** §17/§5 — cold-tier sensitivity leak (viewFact hardcoded "internal")
* **sec:** §5 — Merkle audit hash commits to userAgent/metadata/timestamp
* **sec:** §5 per-key rate limit · §6 procedural scope · §7 remember sensitivity
* **sec:** §6/§13 — gRPC SelfEdit RPC requires memory:self_edit (not memory:write)
* **sec:** close P0 recall sensitivity leak on /v1/recall + gRPC recall
* **sec:** federation — close P0 JWT replay + P1 scope/egress/peer-enroll gaps
* **sec:** gRPC RBAC parity with HTTP (Forget scope, SelfEdit budgets, IP, RBAC/approval)
* **sec:** P0-3 — audit recall operations (detached, best-effort)
* **sec:** P0-6 — idempotency begin() correctly rejects concurrent duplicates
* **self-edit:** enforce requireReason in evaluateSelfEdit at policy layer
* **self-edit:** quality fixes — Map pruning, cadence exact-match, profile strengthen guard, reason forwarding, Span stub shape
* **self-edit:** remove unused policy param from applySelfEdit
* **self-edit:** scope editsBySession/deletesByDay per mountSelf call for test isolation + fix countsAsEdit bug
* **server:** §19 RBAC — populate req.namespace so namespace allow-lists enforce
* **server:** §8c — topic-key resolve path enforces the Wilson confidence gate
* **server:** add .max() caps to task body schemas, clean createTask handler
* **server:** add .openapi("ListEventsQuery") to events query schema
* **server:** audit fixes — §31 introspect capping, §22 dead metrics, §3 MNEMO wiring
* **server:** clear TS errors introduced by SEC-1 + pre-existing unused vars
* **server:** guard governance.propagate against abandoned sessions (spec §11)
* **server:** H1 — wire circuit breakers into route handlers + fix thunkFactory type
* **server:** remove embeddingStale from reasoningToWire wire shape (storage-layer flag)
* **server:** remove unused randomUUID import in tasks.ts
* **server:** reuse EventAnnotationSchema in response, add .min(1) to description, add DELETE tests
* **test:** correct apply-governance promote test values (Wilson lower bound fix) + add node ref to cup tests
* **test:** resolve TS errors in hard-delete-gdpr.test.ts
* **tests:** resolve TS errors in grpc-unary + admin-route + mcp reasoning
* **tests:** resolve TS errors in procedural.test.ts mock.calls access
* **test:** sync server tests to current implementation (stale-cron 14d+enqueueReview, 16 cron keys, otel shutdown ECONNREFUSED)
* **tsconfig:** add types:node to cup and consolidation packages
* **types:** correct Drizzle update return type and complete MnemoFact test factory
* **types:** remove duplicate MnemoHyperedge from relations.ts (Wave D TS fix)
* **types:** remove unused sql import; fix node type resolution in test files (Wave E post)
* **types:** rename MnemoBusEventType→MnemoEventType
* **v3.1:** wire federation peer dep, fix status docs, complete InMemoryStorageAdapter
* vector-index non-fact primitives + filter.kind; wire real LLM token/cost metrics
* **wave-ad:** wire all critical boot deps + fix monorepo build
* **wave-f:** replace inline import() types with top-level imports; remove unused ConfidenceMapRow import
* **wave-g:** rebuild stale type dists — SequentialPatternRow/PeriodicPatternRow now in adapter and mcp builds
* **wave-h:** fix mock type errors in composition-route.test.ts
* **wave-i:** remove unused [@ts-expect-error](https://github.com/ts-expect-error) in trust.test.ts
* **wave-x:** spec gap fixes — score demotion, anomaly outbox ordering, InjectionScore export, missing tests

### Changed

* **core:** remove as-any casts in expandHyperedgeMembers

### Documentation

* **architecture:** §4 — ADR reconciling the API path scheme
* **architecture:** write ARCHITECTURE_OVERVIEW.md with mermaid diagrams
* archive the backlog-to-100 plan and index it
* **assets:** drop stale version label from social preview, keep license badge
* **audit:** add finding #0 — Docker migrate ships a different schema than runtime
* **audit:** ground-truth audit 2026-06-14 + completion plan to 100%
* complete the doc index + fix remaining broken links
* **compliance,ops:** SOC2 controls + SEV1/2/3 IR + per-alert runbooks + evidence-collection script (spec §35)
* design-vs-code audit + remediation plan; fix stale CUP docs
* **federation:** P0-1 — app-layer crypto key setup (env + per-peer keys)
* final implementation audit + Haiku-executable remediation plan
* fix final-audit findings — accurate API examples, real MCP tool surface, package statuses, session SVG
* fix stale DATA_MODEL_V3.md refs + add bitemporal Cursor rule
* **mcp:** mark all 14 tools as live, add 4 missing schema cards
* **mcp:** sync README to the §24 MCP contract
* **mcp:** Wave B6 closeout — 19 tools, README, STATUS.md
* **plan:** decisive finding — runtime is a dual-core hybrid needing both schemas
* **plan:** revise P-1 cutover scope — runtime and v3 schema never integrated
* **plans:** add P2 implementation plan files (Waves A-I + master index)
* **plan:** scope the v3-canonical migration cutover with verified blockers
* **plans:** track documentation & repo-ordering plan (2026-06-13)
* RDD-9/API-9/RET-4 — document Postgres idempotency + session-L1 decisions, annotate memory_session split
* **readme:** correct primitives, MCP tool count, package status, and metrics to match source code
* **readme:** de-duplicate diagrams — new primitives + sensitivity SVGs, drop redundant architecture/recall mermaids, fix session sequence line breaks
* reflect hot-tier wiring, sensitivity guard, ESM-only bin, and federation discovery flag
* **remediation:** deep re-audit — full 36-section spec coverage gap map
* **remediation:** P0 progress — 3/6 done; re-scope remaining 3 as feature-sized
* **remediation:** P0-2 vB shipped — scoped-key auth (opt-in dark-launch) + rollout runbook
* **remediation:** Round-2 convergence map — closed §34.6/§19/§5, rationale for residual ~5%
* **remediation:** work plan to close the last ~7% and reach 100%
* **repo:** Phase 1+3 — LLM-oriented docs, TSDoc, and algorithm explanations
* **repo:** Phase 2 — MCP tool status flags and API.md banner
* **repo:** Phase 4 — OpenAPI pointer, curl quick-start, CLI error docs
* **repo:** Phase 5 — architecture diagram, how-to guides, package table
* **repo:** Phase 5+4 remaining — ADD_A_PRIMITIVE guide, ADD_AN_LLM_PROVIDER guide, MCP schema cards
* **repo:** Phase 6 — doc verification question bank + CI doc-lint guard
* scope core purity claim to src/v3/; drop stale /resolve 501 degraded note
* **security:** §21 — plugin threat model + isolation design
* STATUS.md Wave A — task/event/reasoning HTTP surfaces + SDK shipped
* STATUS.md Wave C — Beta-Bernoulli worth shipped
* STATUS.md Wave D — hyperedges shipped (20 MCP tools)
* **status:** mark PII NER/LLM, federation pull, and recall fallback as complete
* **status:** Phase E ground-truth verification — OPS-7/RDD-7/RDD-8/COG-9 + test drift fixes
* **status:** update stale federation and session sweep entries to v3.3 reality
* **status:** v3.2 feature matrix
* **status:** Wave AA ground-truth verification + STATUS.md update
* **status:** Wave AB ground-truth verification + STATUS.md update
* **status:** Wave K verified — consolidation gate, worth gate, hyperedge members, delta episodes
* **status:** Wave L verified — relation DSL + multi-hop inference, entity-keyed metacognition + trends
* **status:** Wave M verified — CoT distillation cache (§8) + self-editing memory (§13)
* **status:** Wave N verified — L0 working memory + session collapse pins/triggers/linking-episode
* **status:** Wave O verified — task state machine, delegate, auto-extract, event annotations, 4-way anticipation
* **status:** Wave P — Tier 2 POINTER/LSH + fact topic-key upsert verified
* **status:** Wave Q — §4 Event Bus + WebSocket rows + ground-truth table
* **status:** Wave R ground-truth verification — gRPC/ConnectRPC transport
* **status:** Wave W part A verified — §33 consensus complete, §20 federation core
* **status:** Wave W Part B verified — §19 RBAC engine + approval gate + §6 mTLS + service JWT
* **status:** Wave Z (part B) verified — §11 governance actions + §9 cache layers
* strengthen remediation plan to mega-complete (close the blind spot)
* update STATUS.md and CLAUDE.md for v3.1 completions
* **v3.2:** update architecture docs to reflect v3.2 implementation state
* **ver:** VER-5 — final adversarial re-audit checklist
* Wave Y STATUS.md — neuro-dynamics decay/STDP, cron registry, verify.codebase
* Wave Z STATUS.md — RecMem, UCE, Compression, Governance, Cache layers

### Security

* federation_received items keep trust score capped at 20.

## 2.5.0-alpha.0 (2026-06-13)

## 2.4.0-alpha.0 (2026-06-13)

### Added

* **adapter-llm:** implement LlmProviderAdapter bridging llm-providers → LLMAdapter port
* **cli:** implement mnemo CLI — recall, remember, forget, status, config
* **server:** graceful shutdown fix + metrics mount + coverage config
* **session:** wire session routes + patchFact in PATCH /memory/:id

### Fixed

* **adapter-llm:** quality fixes — empty-messages guard, dead-code cleanup, finishReason comment
* **audit:** resolve all remaining audit issues — ALG-01/02/03, FED-01, API-02, ARCH-01
* **cli:** add node types to tsconfig + fix string | undefined type errors
* **cli:** rename unused `match` param to `_match` in status formatter
* **core:** add node types to tsconfig to resolve Buffer TS errors
* **CRIT-01:** standardize GUC name to mnemosyne.workspace_id in tx.ts
* **docker:** handle workspace:* deps in both Docker images
* **guard-tests:** add /// &lt;reference types='node' /&gt; to suppress implicit-any in guard tests
* **migrations:** include created_at in mnemo_audit_log primary key
* **rbac.test:** explicit array type to suppress implicit-any on filterBySensitivity map
* **routes:** add sensitivity to Fact/RecallHit deps + PATCH ceiling guard
* **server:** accept seed-style ids on entity/episode/review routes + fix entity-facts 500
* **server:** accept underscore entity ids in graph focus param
* **TASK-5001:** use Uint8Array for bytea, remove unused fields
* **tests:** use allowed relation verb in contract test
* **tests:** use valid UUIDs for workspaceId in contract tests
* **types:** align RelationVerb with SQL schema CHECK constraint
* **types:** mark vitest external in tsup — fixes integration test runner

### Changed

* **middleware/rbac:** import SENSITIVITY_ORDER and Sensitivity from @mnemo-ai/types (dedup)

### Documentation

* comprehensive documentation update for v2.0.0-alpha.1
* unify repo — remove v3 fragmentation, mega README overhaul
* **v3:** achieve 10/10 architectural perfection
* **v3:** add FINISHING_PLAN.md — audit gap closure plan
* **v3:** comprehensive spec audit + silicon valley implementation plan
* **v3:** implement state-of-the-art cognitive primitives architecture
* **v3:** move architecture and api specifications to v3 directory

## [2.0.0-alpha.1] — 2026-06-12

### Added

- **`@mnemo-ai/adapter-llm`** — New package. `LlmProviderAdapter` class implementing the `LLMAdapter` hexagonal port. Bridges `@mnemo-ai/llm-providers` factory to the core v3 interface. Exports `createLlmAdapter(provider, opts)`. Supports `generate()`, `generateStructured<T>()`, `healthCheck()`. Guards against empty message arrays. 20 unit tests.

- **`@mnemo-ai/cli`** — New package. `mnemo` binary for direct operator access. Commands: `recall <query>`, `remember <text>`, `forget <id>`, `status`, `config set/get`. Config stored at `~/.mnemo/config.json`; `MNEMO_URL`/`MNEMO_KEY` env vars override. Pretty-prints recall hits as aligned table. Pure native fetch, no framework deps.

- **Session routes wired** — POST `/v1/session/start`, POST `/v1/session/:id/turn`, POST `/v1/session/:id/collapse` are fully functional. Previously all three threw `NotImplementedError` (501). Collapse returns 202 Accepted with `{ accepted: true, sessionId }` body.

- **`PATCH /v1/memory/:id` now supports `statement` and `confidence`** — Previously only `pinned` was accepted (statement/confidence threw 501). Now delegates to `core.patchFact()` which handles all three fields. Response returns the full `MemoryFact` including `confidence`.

- **Sensitivity ceiling RBAC** — `MNEMO_SENSITIVITY_CEILING` env var enforces a workspace-level read ceiling across all memory endpoints. Uses numeric comparison (`{public:0, internal:1, confidential:2, restricted:3}`) per MED-23. Returns 404 (not 403) on ceiling violations to prevent probing.

- **Shared Zod schemas** — All request/response validation consolidated into `packages/server/src/schemas.ts`. Eliminates per-route schema drift.

- **Hexagonal-purity guard tests** — CI test asserts that `packages/core/src/v3/` imports zero infrastructure packages (drizzle-orm, pg, redis, @neondatabase).

- **Migration-sequence guard tests** — CI test asserts migration filenames form a contiguous numeric sequence with no gaps or duplicates.

### Fixed

- **Node.js types in tsconfig** — `packages/core/tsconfig.json` and `packages/cli/tsconfig.json` now include `"types": ["node"]` to resolve `Buffer` and `process` TS language-server errors. Build was never broken; this fixes IDE diagnostics.

- **Unused `match` parameter** — Renamed to `_match` in CLI status formatter to satisfy `@typescript-eslint/no-unused-vars`.

- **`MNEMO_ALLOW_UNSAFE_DB_ROLE` safety check** — Improved error message when connecting as a superuser role that bypasses RLS.

### Changed

- **`PATCH /v1/memory/:id` body validation** — Returns `400 Bad Request` (was `404`) when none of `pinned`, `statement`, `confidence` are provided.

- **Session collapse response** — Now includes JSON body `{ accepted: true, sessionId: string }` (was empty 202).

---

## 2.3.0-alpha.0 (2026-06-11)

### Added

* **docs:** live Swagger UI + landing polish (Inter font, halo, gradient text)

### Fixed

* **ci:** dedupe @types/react via pnpm overrides — clear CI build failures
* **graph-viewer:** Next.js 15.5+ LayoutProps shape for CI clean builds

## 2.2.0-alpha.0 (2026-06-07)

### Added

* **docker:** pass MNEMO_ENCRYPTION_SECRET / KEYS into the server container (migration 0065)
* **docs:** cinematic landing + interactive playground
* per-workspace LLM provider config (migration 0065)

### Fixed

* **core:** factory.recall mapper reads h.fact.{id,statement} not raw top-level
* **migration:** make 0065 idempotent (DROP POLICY IF EXISTS, DROP TRIGGER IF EXISTS)

### Documentation

* **architecture:** expand into canonical system spec
* **diagrams:** bring inline CSS animations into the three SVG diagrams
* **diagrams:** fix memory-graph readability + reinforce architecture animations
* **diagrams:** static visibility hotfix for GitHub-embedded SVGs

## 2.1.0-alpha.0 (2026-06-06)

### Added

* add GET /v1/graph endpoint + client.graph() SDK method
* extract Mnemosyne v2.0.0-alpha.0 to standalone monorepo
* **graph:** port newer Memory Graph from Orchester — client/server split
* tramo 1 — 5 read endpoints (entities + episodes)
* tramo 2 — 5 write endpoints (entities POST/PATCH + review CRUD)
* tramo 3 — audit + export + restore + decisions (5 endpoints)
* tramo 4 — 10 endpoints (facts CRUD + decisions writes + relations + citations + review enqueue)
* tramo 5 — GET /v1/facts with FTS + keyset cursor + asOf

### Fixed

* **db:** add missing confidence column to mnemo_decision (0064)
* **docker:** --ignore-scripts when bolting peers into deploy bundle
* **docker:** align deploy + peer-install + COPY on the real bundle path
* **docker:** drop --no-frozen-lockfile from pnpm add
* **docker:** drop --prod from pnpm add (modes-conflict)
* **docker:** drop `COPY apps apps` — the standalone repo has no apps/
* **docker:** include tsconfig.base.json + turbo.json in build COPY
* **docker:** install peer deps into deploy bundle (postgres, drizzle-orm)
* **docker:** invoke mnemo-migrate via dist path, not .bin symlink
* **docker:** keep install scripts ON so bcrypt's native binding installs
* **docker:** pnpm deploy bundle was landing in the wrong absolute path
* **docker:** pnpm pack doesn't accept --filter (pnpm 9), cd into each pkg
* **docker:** synth-runtime-pkg matches pnpm pack's actual filename format
* **docker:** update create-api-key.js references to .cjs
* **docker:** use pnpm (not npm) to bolt peers onto the deploy bundle
* **migrations:** CREATE EXTENSION vector in 0015 so 0016+ can declare columns of type vector(N)
* **migrations:** make the full stream portable — verified against live pgvector
* resolve all 22 audit findings (6 critical) — green build + tests
* **runtime:** end-to-end fixes found by live HTTP testing against pgvector
* **test:** use portable path resolution instead of hardcoded /Users/... in integration test
* **visual:** social-preview layout bugs — review() overflow, pill asymmetry
* **visual:** SVG diagrams now render in all clients (drop CSS classes)

### Changed

* **docker:** rewrite Dockerfile.migrate without pnpm deploy
* **docker:** rewrite Dockerfile.server (drop pnpm deploy, install workspace peers as tarballs)

### Documentation

* open-source polish — README, cover, docs, graph-viewer example, OSS files
