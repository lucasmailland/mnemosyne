// in-memory/anticipation.ts — InMemoryStorageAdapter's Anticipation port methods.
// decompose-inmemory-storage-adapter Batch B6 (design.md Module Map row 25).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — all 5 are stubs that
// read zero collections (D4/design.md confirmed).

import type {
  SequentialPatternRow,
  PeriodicPatternRow,
  ConditionalPatternRow,
  CoOccurrencePatternRow,
} from "../../primitives.js";
import type { InMemoryStorageState } from "./state.js";

export async function getSequentialPatterns(
  _state: InMemoryStorageState,
  _args: {
    workspaceId: string;
    predecessorId?: string;
    minConfidence?: number;
    limit?: number;
  }
): Promise<SequentialPatternRow[]> {
  return []; // no recall history in memory
}

export async function getPeriodicPatterns(
  _state: InMemoryStorageState,
  _args: {
    workspaceId: string;
    dayOfWeek?: number;
    hourBucket?: number;
    limit?: number;
  }
): Promise<PeriodicPatternRow[]> {
  return []; // no periodic data in memory
}

export async function refreshAnticipationViews(_state: InMemoryStorageState): Promise<void> {
  // no-op
}

export async function getConditionalPatterns(
  _state: InMemoryStorageState
): Promise<ConditionalPatternRow[]> {
  return [];
}

export async function getCoOccurrencePatterns(
  _state: InMemoryStorageState
): Promise<CoOccurrencePatternRow[]> {
  return [];
}
