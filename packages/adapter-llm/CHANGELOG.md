# Changelog

## 3.1.5-alpha.0 (2026-07-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.6.0-alpha.0
  * devDependencies
    * @mnemo-ai/llm-providers bumped to 3.4.0-alpha.0
  * peerDependencies
    * @mnemo-ai/llm-providers bumped to 3.4.0-alpha.0

## 3.1.4-alpha.0 (2026-07-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.5.0-alpha.0
  * devDependencies
    * @mnemo-ai/llm-providers bumped to 3.3.0-alpha.0
  * peerDependencies
    * @mnemo-ai/llm-providers bumped to 3.3.0-alpha.0

## 3.1.3-alpha.0 (2026-07-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.4.0-alpha.0
  * devDependencies
    * @mnemo-ai/llm-providers bumped to 3.2.0-alpha.0
  * peerDependencies
    * @mnemo-ai/llm-providers bumped to 3.2.0-alpha.0

## 3.1.2-alpha.0 (2026-07-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.3.0-alpha.0
  * devDependencies
    * @mnemo-ai/llm-providers bumped to 3.1.0-alpha.0
  * peerDependencies
    * @mnemo-ai/llm-providers bumped to 3.1.0-alpha.0

## 3.1.1-alpha.0 (2026-06-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.2.0-alpha.0
  * devDependencies
    * @mnemo-ai/llm-providers bumped to 3.0.2-alpha.0
  * peerDependencies
    * @mnemo-ai/llm-providers bumped to 3.0.2-alpha.0

## 3.1.0-alpha.0 (2026-06-19)


### Added

* **adapter-llm:** implement LlmProviderAdapter bridging llm-providers → LLMAdapter port
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* **perf:** coalescer + batch embedding + cursor pagination + slow-query thresholds (spec §35)


### Fixed

* **adapter-llm:** quality fixes — empty-messages guard, dead-code cleanup, finishReason comment
* vector-index non-fact primitives + filter.kind; wire real LLM token/cost metrics


### Documentation

* complete the doc index + fix remaining broken links
* comprehensive documentation update for v2.0.0-alpha.1
* fix final-audit findings — accurate API examples, real MCP tool surface, package statuses, session SVG
* **repo:** Phase 1+3 — LLM-oriented docs, TSDoc, and algorithm explanations
* unify repo — remove v3 fragmentation, mega README overhaul


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.1.0-alpha.0
  * devDependencies
    * @mnemo-ai/llm-providers bumped to 3.0.1-alpha.0
  * peerDependencies
    * @mnemo-ai/llm-providers bumped to 3.0.1-alpha.0
