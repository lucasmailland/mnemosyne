# Changelog

## 3.5.0-alpha.0 (2026-07-06)


### Added

* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **consolidation:** wire per-workspace LLM into replay validator (P6)
* **quality:** LLM-enhanced consolidation, recall reranking, remind_when, anticipate
* **W0:** Quality Baseline & CI Hard Gate


### Changed

* remove all v1/v2/v3 version labels from codebase


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/core bumped to 3.6.0-alpha.0
    * @mnemo-ai/types bumped to 3.6.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.6.0-alpha.0

## 3.4.0-alpha.0 (2026-07-06)


### Added

* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **consolidation:** wire per-workspace LLM into replay validator (P6)
* **quality:** LLM-enhanced consolidation, recall reranking, remind_when, anticipate
* **W0:** Quality Baseline & CI Hard Gate


### Changed

* remove all v1/v2/v3 version labels from codebase


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/core bumped to 3.5.0-alpha.0
    * @mnemo-ai/types bumped to 3.5.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.5.0-alpha.0

## 3.3.0-alpha.0 (2026-07-05)


### Added

* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **consolidation:** wire per-workspace LLM into replay validator (P6)
* **quality:** LLM-enhanced consolidation, recall reranking, remind_when, anticipate
* **W0:** Quality Baseline & CI Hard Gate


### Changed

* remove all v1/v2/v3 version labels from codebase


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/core bumped to 3.4.0-alpha.0
    * @mnemo-ai/types bumped to 3.4.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.4.0-alpha.0

## 3.2.0-alpha.0 (2026-07-05)


### Added

* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **consolidation:** wire per-workspace LLM into replay validator (P6)
* **quality:** LLM-enhanced consolidation, recall reranking, remind_when, anticipate
* **W0:** Quality Baseline & CI Hard Gate


### Changed

* remove all v1/v2/v3 version labels from codebase


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/core bumped to 3.3.0-alpha.0
    * @mnemo-ai/types bumped to 3.3.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.3.0-alpha.0

## 3.1.1-alpha.0 (2026-06-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/core bumped to 3.2.0-alpha.0
    * @mnemo-ai/types bumped to 3.2.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.2.0-alpha.0

## 3.1.0-alpha.0 (2026-06-19)


### Added

* **consolidation-mcp:** activate memory_consolidate + consolidation scheduler in server boot
* **consolidation:** add background scheduler — 60s interval, top-20 candidates
* **consolidation:** wire ReplayValidator into scheduler (P1.4)
* **core,governance:** §11 promote/demote/canonical actions + max-5-hop TD + governance.propagate
* **security:** P0.1+P0.3+P0.2+P0.4+P1.2+P1.3+P1.4 — full security hardening sprint
* Wave Z — Cognitive Completeness (RecMem, UCE, Compression, Governance, Cache)
* **wave-k:** correctness fixes — consolidation gate, worth gate, hyperedge members, delta episodes


### Fixed

* **consolidation:** align gate with spec §12 — cluster≥3, worth&lt;0.5, 14d recency, conf≤0.7, admin-lock, rollback
* **consolidation:** quality fixes from K1 review — cosine extract, fail-closed lock, rollback log
* **consolidation:** unref() cast to {unref(): void} — avoids NodeJS namespace requirement
* **tsconfig:** add types:node to cup and consolidation packages
* **types:** correct Drizzle update return type and complete MnemoFact test factory


### Documentation

* complete the doc index + fix remaining broken links
* comprehensive documentation update for v2.0.0-alpha.1
* fix final-audit findings — accurate API examples, real MCP tool surface, package statuses, session SVG
* **repo:** Phase 1+3 — LLM-oriented docs, TSDoc, and algorithm explanations
* unify repo — remove v3 fragmentation, mega README overhaul


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/core bumped to 3.1.0-alpha.0
    * @mnemo-ai/types bumped to 3.1.0-alpha.0
  * peerDependencies
    * @mnemo-ai/core bumped to 3.1.0-alpha.0
