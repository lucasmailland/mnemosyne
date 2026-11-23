# Mnemosyne v3 — Subconscious Consolidation (Sleep Cycles)

> **Version**: 3.0.0 | **Status**: Design | **Updated**: 2026-06-11

---

## 1. The Homeostatic Memory Model

Memory in an autonomous agent should not be a passive vector store. It must be a self-optimizing cognitive substrate. The **Subconscious Consolidation** subsystem (colloquially: "Sleep Cycles") is an asynchronous worker that synthesizes higher-order procedural knowledge (Skills and Workflows) from raw episodic and reasoning traces.

## 2. Triggering "Sleep"

The consolidation engine does not block the hot path (Recall/Remember). It runs via `@mnemo-ai/queue` (e.g., BullMQ or pg-boss) under two conditions:
1. **Idle Time**: The agent has not interacted with the workspace for > 15 minutes.
2. **Episode Saturation**: More than 50 new `mnemo_episode` or `mnemo_reasoning` rows have been inserted since the last cycle.

## 3. The Consolidation Algorithm

### 3.1. Pattern Discovery (The 3-Strike Rule)
The engine scans recent `mnemo_episode` delta-trees and their associated `mnemo_reasoning` traces.
1. It applies clustering (using existing dense vectors + DBSCAN/K-Means) to group similar problem-solving episodes.
2. **Threshold**: If it finds a cluster of **N ≥ 3** episodes with a similar semantic goal AND a "resolved" outcome.

### 3.2. Procedural Synthesis (LLM Distillation)
For valid clusters, the engine triggers the LLM Adapter with a strict JSON Schema requirement.

**Output Schema (`mnemo_skill`):**
```json
{
  "name": "string",
  "description": "string",
  "parameters": { "type": "object", "properties": "..." },
  "steps": [
    { "action": "string", "input": "any", "dependency": "step_id" }
  ],
  "context_required": ["fact_ids", "entity_ids"]
}
```

The synthesized output is inserted as a **new** `mnemo_skill` or `mnemo_workflow` primitive.
- The new primitive is cited (via `mnemo_citation`) back to the 3 `mnemo_episode` rows that generated it (provenance).
- Next time the agent faces a similar problem, `memory_recall` retrieves the newly minted `mnemo_skill` instead of raw, disjointed episodes.

## 4. Pruning (Synaptic Pruning)
During the sleep cycle, the engine also evaluates the `worth` metric of all primitives.
- If `worth < 0.1` and `hit_count > 10`, the primitive is softly archived (`valid_to = NOW()`).
- The system cleans up its own cognitive clutter.
