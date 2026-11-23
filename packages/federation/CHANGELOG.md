# Changelog

## 3.5.0-alpha.0 (2026-07-06)


### Added

* **federation:** H10 — vector-clock CRDT in SyncEngine for causal ordering
* **federation:** make §33 federatedConsensus reachable from SyncEngine (trust-weighted reconcile)
* **federation:** P0-1/P1 — app-layer crypto + merge strategy + scoped sync
* **federation:** thread conflictResolution into both prod apply paths
* **fed:** W3 federation soak — dual-node HTTP test, STABLE
* **fed:** W3 federation soak — STABLE
* **observability:** inject W3C trace context on outbound federation/webhook/outbox calls
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **W0:** Quality Baseline & CI Hard Gate


### Fixed

* **federation:** reject plaintext pull when peer keys configured (F9)
* **sec:** federation — close P0 JWT replay + P1 scope/egress/peer-enroll gaps
* **test:** align CI-failing tests with F9 reject-by-default + F11 scope guard


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* second accuracy pass — fix broken SDK examples + remaining fictional refs


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.6.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.6.0-alpha.0

## 3.4.0-alpha.0 (2026-07-06)


### Added

* **federation:** H10 — vector-clock CRDT in SyncEngine for causal ordering
* **federation:** make §33 federatedConsensus reachable from SyncEngine (trust-weighted reconcile)
* **federation:** P0-1/P1 — app-layer crypto + merge strategy + scoped sync
* **federation:** thread conflictResolution into both prod apply paths
* **fed:** W3 federation soak — dual-node HTTP test, STABLE
* **fed:** W3 federation soak — STABLE
* **observability:** inject W3C trace context on outbound federation/webhook/outbox calls
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **W0:** Quality Baseline & CI Hard Gate


### Fixed

* **federation:** reject plaintext pull when peer keys configured (F9)
* **sec:** federation — close P0 JWT replay + P1 scope/egress/peer-enroll gaps
* **test:** align CI-failing tests with F9 reject-by-default + F11 scope guard


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* second accuracy pass — fix broken SDK examples + remaining fictional refs


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.5.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.5.0-alpha.0

## 3.3.0-alpha.0 (2026-07-05)


### Added

* **federation:** H10 — vector-clock CRDT in SyncEngine for causal ordering
* **federation:** make §33 federatedConsensus reachable from SyncEngine (trust-weighted reconcile)
* **federation:** P0-1/P1 — app-layer crypto + merge strategy + scoped sync
* **federation:** thread conflictResolution into both prod apply paths
* **fed:** W3 federation soak — dual-node HTTP test, STABLE
* **fed:** W3 federation soak — STABLE
* **observability:** inject W3C trace context on outbound federation/webhook/outbox calls
* **server,federation:** workspace region-lock + cross-region metadata-only federation + residency docs (spec §35)
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **W0:** Quality Baseline & CI Hard Gate


### Fixed

* **federation:** reject plaintext pull when peer keys configured (F9)
* **sec:** federation — close P0 JWT replay + P1 scope/egress/peer-enroll gaps
* **test:** align CI-failing tests with F9 reject-by-default + F11 scope guard


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* second accuracy pass — fix broken SDK examples + remaining fictional refs


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.4.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.4.0-alpha.0

## 3.2.0-alpha.0 (2026-07-05)


### Added

* **federation:** thread conflictResolution into both prod apply paths
* **fed:** W3 federation soak — dual-node HTTP test, STABLE
* **fed:** W3 federation soak — STABLE
* **observability:** inject W3C trace context on outbound federation/webhook/outbox calls
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **W0:** Quality Baseline & CI Hard Gate


### Fixed

* **federation:** reject plaintext pull when peer keys configured (F9)
* **test:** align CI-failing tests with F9 reject-by-default + F11 scope guard


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* second accuracy pass — fix broken SDK examples + remaining fictional refs


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.3.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.3.0-alpha.0

## 3.1.1-alpha.0 (2026-06-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.2.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.2.0-alpha.0

## 3.1.0-alpha.0 (2026-06-19)


### Added

* **federation-sync:** InMemorySyncStorage + SyncEngine wiring — POST /sync executes real peer sync
* **federation,core:** §33 complete — resolveConflict 4 rules + federatedConsensus contested + saveFactWithAutoResolve
* **federation:** §20 core — announce/mesh, scoped incremental sync, Ed25519+GCM payload, 4-rule apply path
* **federation:** H10 — vector-clock CRDT in SyncEngine for causal ordering
* **federation:** HTTP routes, InMemoryPeerStore/JobStore, server boot wiring
* **federation:** implement HTTP pull transport (PullClient + /items endpoint)
* **federation:** make §33 federatedConsensus reachable from SyncEngine (trust-weighted reconcile)
* **federation:** mk_fed_ &lt;-&gt; mTLS binding + TLS 1.3 assertion (§3/§6)
* **federation:** P0-1/P1 — app-layer crypto + merge strategy + scoped sync
* **p2:** merge Wave A–I — §30-33, compositionality, anticipation, consensus
* **server,federation:** workspace region-lock + cross-region metadata-only federation + residency docs (spec §35)
* Wave W Part A — §33 Distributed Consensus + §20 Federation Protocol core
* Wave W Part B — §19 Agent RBAC + Approval Gate + §6 mTLS + Service JWT
* **wave-i:** §33 Distributed Consensus — TRUST_ANCHORS, resolveConsensus, supermajority /resolve


### Fixed

* **audit:** resolve all remaining audit issues — ALG-01/02/03, FED-01, API-02, ARCH-01
* **core,federation:** decideAutoResolution explicit confidence gate + zero-llm fix
* **federation:** use static import + globalThis in tests after pull transport
* **sec:** federation — close P0 JWT replay + P1 scope/egress/peer-enroll gaps
* **v3.1:** wire federation peer dep, fix status docs, complete InMemoryStorageAdapter
* **wave-i:** remove unused [@ts-expect-error](https://github.com/ts-expect-error) in trust.test.ts


### Documentation

* comprehensive documentation update for v2.0.0-alpha.1
* fix final-audit findings — accurate API examples, real MCP tool surface, package statuses, session SVG
* **repo:** Phase 1+3 — LLM-oriented docs, TSDoc, and algorithm explanations
* unify repo — remove v3 fragmentation, mega README overhaul


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.1.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.1.0-alpha.0
