// in-memory/index.ts — namespace barrel for InMemoryStorageAdapter's domain modules.
// decompose-inmemory-storage-adapter Batch B0 (design.md Module Map row 3).
//
// Accumulates one `export * as <module> from "./<module>.js";` line per
// batch (B1-B13), in Module Map row order (design.md rows 4-35).

export * as sessions from "./sessions.js";
export * as facts from "./facts.js";
export * as consolidation from "./consolidation.js";
export * as workspace from "./workspace.js";
export * as decisions from "./decisions.js";
export * as episodes from "./episodes.js";
export * as entities from "./entities.js";
export * as strategies from "./strategies.js";
export * as workflows from "./workflows.js";
export * as skills from "./skills.js";
export * as tasks from "./tasks.js";
export * as events from "./events.js";
export * as reasoning from "./reasoning.js";
export * as agent from "./agent.js";
export * as hyperedges from "./hyperedges.js";
export * as composition from "./composition.js";
export * as relations from "./relations.js";
export * as graph from "./graph.js";
export * as recall from "./recall.js";
export * as factIndex from "./fact-index.js";
export * as metacognition from "./metacognition.js";
export * as anticipation from "./anticipation.js";
export * as neuroDynamics from "./neuro-dynamics.js";
export * as activeLearning from "./active-learning.js";
export * as audit from "./audit.js";
export * as outbox from "./outbox.js";
export * as webhooks from "./webhooks.js";
export * as reminders from "./reminders.js";
export * as queryCache from "./query-cache.js";
export * as metrics from "./metrics.js";
export * as embeddingMaintenance from "./embedding-maintenance.js";
export * as lifecycle from "./lifecycle.js";
export * as harness from "./harness.js";
