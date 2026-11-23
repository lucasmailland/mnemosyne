# Changelog

## 3.6.3 (unreleased)

### Fixed

* `scope` on recall, remember and fact filters is `global | conversation | personal`. The
  `employee` and `team` values were in the types only: the server rejects them.
* `RecallInput.asOf` works: `POST /recall` ranks what memory held at that instant instead of
  ignoring the field. A future instant answers 400.

### Added

* `RecallHit.federation`: `{ peer, trustScore }` on items pulled from a federation peer.
* `RecallInput.hyde`, the opt-in HyDE pre-step of `POST /recall`.
* `RecallInput.includeGraph`, and `relations`/`hyperedges` on `RecallHit` when it is set.
* `listAgentPolicies`, `getAgentPolicy`, `putAgentPolicy` and `deleteAgentPolicy` for the
  agent RBAC policy routes under `/admin`.
* `listFederationItems` takes `cursor` and `knownCursor`, and its types match what the
  server serves: `remoteId`, `version`, `peerDomain`, `payload`, `deletedAt` on a
  tombstone, or the signed envelope (`FederationItemPayload`, `SealedFederationItem`).
* `createFederationPeer` for `POST /memory/federation/peers`. `PeerConfig` now matches what
  the server returns: `certFingerprint`, `hasApiKey` and `hasSymmetricKey`, never the secrets.

## 3.6.0-alpha.0 (2026-07-06)


### Added

* **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
* **mcp:** add memory_doctor — 27th tool with 8 operational diagnostics
* **mcp:** Task 13 — workflow + skill tools and event.annotate action
* memory_context MCP tool + mnemo info CLI command
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** targetWorkspaceId on memory_remember — write to any accessible workspace
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* **remember:** accept host-side precomputed embedding vector
* **server,client-ts,core:** expose graph traversal and path endpoints
* **server,client:** expose includeSemantic on /v1/graph + SDK
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance


### Fixed

* §15 Hebbian relation weight (wrong relation) · §31 introspect limit (MCP+client)
* **mcp/sdk/plugins:** expose asOf + anticipation context/lookAhead; clamp plugin write sensitivity
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics


### Changed

* remove all v1/v2/v3 version labels from codebase


### Documentation

* **client-ts:** correct stale /v1 path comment in buildUrl
* second accuracy pass — fix broken SDK examples + remaining fictional refs


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @mnemo-ai/core bumped to 3.6.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.6.0-alpha.0

## 3.5.0-alpha.0 (2026-07-06)


### Added

* **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
* **mcp:** add memory_doctor — 27th tool with 8 operational diagnostics
* **mcp:** Task 13 — workflow + skill tools and event.annotate action
* memory_context MCP tool + mnemo info CLI command
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** targetWorkspaceId on memory_remember — write to any accessible workspace
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* **remember:** accept host-side precomputed embedding vector
* **server,client-ts,core:** expose graph traversal and path endpoints
* **server,client:** expose includeSemantic on /v1/graph + SDK
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance


### Fixed

* §15 Hebbian relation weight (wrong relation) · §31 introspect limit (MCP+client)
* **mcp/sdk/plugins:** expose asOf + anticipation context/lookAhead; clamp plugin write sensitivity
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics


### Changed

* remove all v1/v2/v3 version labels from codebase


### Documentation

* **client-ts:** correct stale /v1 path comment in buildUrl
* second accuracy pass — fix broken SDK examples + remaining fictional refs


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @mnemo-ai/core bumped to 3.5.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.5.0-alpha.0

## 3.4.0-alpha.0 (2026-07-05)


### Added

* **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
* **mcp:** add memory_doctor — 27th tool with 8 operational diagnostics
* **mcp:** Task 13 — workflow + skill tools and event.annotate action
* memory_context MCP tool + mnemo info CLI command
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** targetWorkspaceId on memory_remember — write to any accessible workspace
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* **remember:** accept host-side precomputed embedding vector
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **wave-ac:** schema & contract completeness — final sweep (AC1–AC4 §34.6/7/9)
* **wave-s:** SDK completion — TS federation endpoints, Python SDK, Go SDK


### Fixed

* §15 Hebbian relation weight (wrong relation) · §31 introspect limit (MCP+client)
* **mcp/sdk/plugins:** expose asOf + anticipation context/lookAhead; clamp plugin write sensitivity
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics


### Changed

* remove all v1/v2/v3 version labels from codebase


### Documentation

* **client-ts:** correct stale /v1 path comment in buildUrl
* second accuracy pass — fix broken SDK examples + remaining fictional refs


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @mnemo-ai/core bumped to 3.4.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.4.0-alpha.0

## 3.3.0-alpha.0 (2026-07-05)


### Added

* **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
* **mcp:** add memory_doctor — 27th tool with 8 operational diagnostics
* **mcp:** Task 13 — workflow + skill tools and event.annotate action
* memory_context MCP tool + mnemo info CLI command
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** targetWorkspaceId on memory_remember — write to any accessible workspace
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* **remember:** accept host-side precomputed embedding vector
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **wave-ac:** schema & contract completeness — final sweep (AC1–AC4 §34.6/7/9)
* **wave-s:** SDK completion — TS federation endpoints, Python SDK, Go SDK


### Fixed

* §15 Hebbian relation weight (wrong relation) · §31 introspect limit (MCP+client)
* **mcp/sdk/plugins:** expose asOf + anticipation context/lookAhead; clamp plugin write sensitivity
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics


### Changed

* remove all v1/v2/v3 version labels from codebase


### Documentation

* **client-ts:** correct stale /v1 path comment in buildUrl
* second accuracy pass — fix broken SDK examples + remaining fictional refs


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @mnemo-ai/core bumped to 3.3.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.3.0-alpha.0

## 3.2.0-alpha.0 (2026-06-21)


### Added

* **mcp:** Task 13 — workflow + skill tools and event.annotate action
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @mnemo-ai/core bumped to 3.2.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.2.0-alpha.0

## 3.1.0-alpha.0 (2026-06-19)


### Added

* **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
* **client-ts:** tasks/events/reasoning flat methods (Wave A6)
* **consolidation-mcp:** activate memory_consolidate + consolidation scheduler in server boot
* **mcp:** memory_strategy tool + HTTP routes + SDK methods (Wave B4)
* **p2:** merge Wave A–I — §30-33, compositionality, anticipation, consensus
* **prospective-memory:** reminders schema, evaluator, HTTP routes, MCP tool activation
* **self-edit:** Wave M2 — Self-Editing Memory with 6-action policy + agent profile + reflection cadence (spec §13)
* **server,client-ts:** add composition admin routes + client namespace getter (Wave H4)
* **server,client-ts:** hyperedge HTTP routes + SDK flat methods (Wave D2)
* **server,mcp,client-ts:** /v1/anticipation + memory_anticipate (Wave G4)
* **server,mcp,client-ts:** /v1/metacognition + memory_introspect (Wave F4)
* **session-collapse:** wire factory.collapseSession() to real pipeline + activate episode MCP
* **wave-ac:** schema & contract completeness — final sweep (AC1–AC4 §34.6/7/9)
* **wave-s:** SDK completion — TS federation endpoints, Python SDK, Go SDK


### Fixed

* §15 Hebbian relation weight (wrong relation) · §31 introspect limit (MCP+client)
* **client-ts:** typed returns, AbortSignal, pruned enum, JSDoc, tests (Wave A6 quality)
* **mcp/sdk/plugins:** expose asOf + anticipation context/lookAhead; clamp plugin write sensitivity


### Documentation

* **repo:** Phase 1+3 — LLM-oriented docs, TSDoc, and algorithm explanations


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @mnemo-ai/core bumped to 3.1.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.1.0-alpha.0

## 2.2.2-alpha.0 (2026-06-13)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @mnemo-ai/core bumped to 2.4.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 2.4.0-alpha.0

## 2.2.1-alpha.0 (2026-06-13)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @mnemo-ai/core bumped to 2.3.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 2.3.0-alpha.0

## 2.2.0-alpha.0 (2026-06-11)


### Added

* add GET /v1/graph endpoint + client.graph() SDK method
* extract Mnemosyne v2.0.0-alpha.0 to standalone monorepo
* per-workspace LLM provider config (migration 0065)
* tramo 1 — 5 read endpoints (entities + episodes)
* tramo 2 — 5 write endpoints (entities POST/PATCH + review CRUD)
* tramo 3 — audit + export + restore + decisions (5 endpoints)
* tramo 4 — 10 endpoints (facts CRUD + decisions writes + relations + citations + review enqueue)
* tramo 5 — GET /v1/facts with FTS + keyset cursor + asOf


### Fixed

* resolve all 22 audit findings (6 critical) — green build + tests


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @mnemo-ai/core bumped to 2.2.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 2.2.0-alpha.0

## 2.1.0-alpha.0 (2026-06-07)


### Added

* add GET /v1/graph endpoint + client.graph() SDK method
* extract Mnemosyne v2.0.0-alpha.0 to standalone monorepo
* per-workspace LLM provider config (migration 0065)
* tramo 1 — 5 read endpoints (entities + episodes)
* tramo 2 — 5 write endpoints (entities POST/PATCH + review CRUD)
* tramo 3 — audit + export + restore + decisions (5 endpoints)
* tramo 4 — 10 endpoints (facts CRUD + decisions writes + relations + citations + review enqueue)
* tramo 5 — GET /v1/facts with FTS + keyset cursor + asOf


### Fixed

* resolve all 22 audit findings (6 critical) — green build + tests


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @mnemo-ai/core bumped to 2.1.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 2.1.0-alpha.0
