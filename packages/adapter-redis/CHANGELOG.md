# Changelog

## 3.6.0-alpha.0 (2026-07-06)


### Added

* **cache:** add Hash ops (hSet/hGet/hGetAll/hDel) to CacheAdapter port + Redis impl
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance


### Fixed

* **adapter-redis:** skip hash integration test when no Redis URL is set


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.6.0-alpha.0
    * @mnemo-ai/core bumped to 3.6.0-alpha.0

## 3.5.0-alpha.0 (2026-07-06)


### Added

* **cache:** add Hash ops (hSet/hGet/hGetAll/hDel) to CacheAdapter port + Redis impl
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance


### Fixed

* **adapter-redis:** skip hash integration test when no Redis URL is set


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.5.0-alpha.0
    * @mnemo-ai/core bumped to 3.5.0-alpha.0

## 3.4.0-alpha.0 (2026-07-05)


### Added

* **cache:** add Hash ops (hSet/hGet/hGetAll/hDel) to CacheAdapter port + Redis impl
* **core,types,redis:** monotonic event ids + Redis-list replay buffer ops (§35)
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **wave-aa:** Backpressure & Resilience — shedding, WS replay, embed migration, hot-tier dump


### Fixed

* **adapter-redis:** skip hash integration test when no Redis URL is set
* **wave-ad:** wire all critical boot deps + fix monorepo build


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.4.0-alpha.0
    * @mnemo-ai/core bumped to 3.4.0-alpha.0

## 3.3.0-alpha.0 (2026-07-05)


### Added

* **cache:** add Hash ops (hSet/hGet/hGetAll/hDel) to CacheAdapter port + Redis impl
* **core,types,redis:** monotonic event ids + Redis-list replay buffer ops (§35)
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **wave-aa:** Backpressure & Resilience — shedding, WS replay, embed migration, hot-tier dump


### Fixed

* **adapter-redis:** skip hash integration test when no Redis URL is set
* **wave-ad:** wire all critical boot deps + fix monorepo build


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.3.0-alpha.0
    * @mnemo-ai/core bumped to 3.3.0-alpha.0

## 3.2.0-alpha.0 (2026-06-21)


### Added

* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.2.0-alpha.0
    * @mnemo-ai/core bumped to 3.2.0-alpha.0

## 3.1.0-alpha.0 (2026-06-19)


### Added

* **cache:** §9 L2/L3 cache layers + Redis-down degradation ladder
* **core,types,redis:** monotonic event ids + Redis-list replay buffer ops (§35)
* **core:** L0 working memory — workGet/Set/Checkpoint/bloom/rateLimit (spec §9)
* **security:** Wave X2 — access-path detection, export approval gate, GDPR hard delete
* Wave Z — Cognitive Completeness (RecMem, UCE, Compression, Governance, Cache)
* **wave-aa:** Backpressure & Resilience — shedding, WS replay, embed migration, hot-tier dump


### Fixed

* **wave-ad:** wire all critical boot deps + fix monorepo build


### Documentation

* comprehensive documentation update for v2.0.0-alpha.1
* fix final-audit findings — accurate API examples, real MCP tool surface, package statuses, session SVG
* reflect hot-tier wiring, sensitivity guard, ESM-only bin, and federation discovery flag
* **repo:** Phase 1+3 — LLM-oriented docs, TSDoc, and algorithm explanations
* unify repo — remove v3 fragmentation, mega README overhaul


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.1.0-alpha.0
    * @mnemo-ai/core bumped to 3.1.0-alpha.0
