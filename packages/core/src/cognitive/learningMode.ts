/**
 * learningMode — cold-start workspace operational mode.
 *
 * RDD-5 (MEMORY_MODEL.md §Resolved Design Decisions ~line 3485-3522):
 *
 * New workspaces start in "learning" mode where 5 subsystems are DISABLED:
 *   - hotTier        — no ACT-R hot tier boosts (not enough data to be meaningful)
 *   - anticipation   — no anticipation mining (premature pattern detection)
 *   - composition    — no compositionality inference (no graph edges yet)
 *   - worthUpdates   — DISABLED (spec: "worthUpdatesDisabled: true" — must not mutate
 *                       worth on near-zero data to avoid premature convergence)
 *   - consolidation  — no consolidation (not enough facts to consolidate)
 *
 * Additionally: extractionAggressive=true (lower prefilter to gather more signal).
 *
 * In "production" mode all 5 subsystems are ENABLED and normal operation resumes.
 *
 * Graduation from learning → production happens when ANY of these criteria is met:
 *   { factCount: 50, sessionCount: 10, entityCount: 5, daysElapsed: 14 }
 * (Previously only sessionCount was checked — this was a spec violation.)
 *
 * This is pure domain logic (no I/O). The storage adapter owns DB read/write
 * for mnemo_workspace_mode.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkspaceModeRecord {
  workspaceId: string;
  /** "learning" = cold-start; "production" = full operation. */
  mode: "learning" | "production";
  sessionCount: number;
  promoteAt: number | null;
  /** When this workspace entered learning mode (for daysElapsed criterion). */
  startedAt?: Date;
  /** Cumulative fact count (for factCount criterion). */
  factCount?: number;
  /** Cumulative entity count (for entityCount criterion). */
  entityCount?: number;
}

/**
 * LearningGates: which subsystems are enabled for this workspace.
 *
 * A gate value of `true` means the subsystem IS active (can run).
 * A gate value of `false` means the subsystem is DISABLED (must be skipped).
 */
export interface LearningGates {
  /** ACT-R hot-tier score bumps — disabled during learning (no signal yet). */
  hotTier: boolean;
  /** Anticipation engine mining — disabled during learning (premature). */
  anticipation: boolean;
  /** Compositionality inference — disabled during learning (no graph yet). */
  composition: boolean;
  /** Worth update propagation — DISABLED during learning (spec: worthUpdatesDisabled). */
  worthUpdates: boolean;
  /** Consolidation scheduler — disabled during learning (not enough facts). */
  consolidation: boolean;
  /** Extraction aggressiveness — enabled during learning (lower prefilter). */
  extractionAggressive: boolean;
}

// ─── Graduation constants ─────────────────────────────────────────────────────

/**
 * Multi-criteria graduation thresholds (ANY one triggers promotion).
 * Spec: MEMORY_MODEL.md §Resolved Design Decisions ~line 3516.
 */
export const GRADUATION = {
  factCount: 50,
  sessionCount: 10,
  entityCount: 5,
  daysElapsed: 14,
} as const;

// ─── Pure functions ───────────────────────────────────────────────────────────

/**
 * Is the workspace in cold-start learning mode?
 *
 * A null record means the workspace has no mode row yet — default to learning mode
 * so new workspaces always start in cold-start (conservative: never gate on worth
 * before any signal has accumulated).
 */
export function isLearningMode(record: WorkspaceModeRecord | null | undefined): boolean {
  if (!record) return true; // default: new workspace → learning mode
  return record.mode === "learning";
}

/**
 * Compute which subsystems are enabled based on the workspace mode record.
 *
 * RDD-5: during learning mode, worthUpdates is FALSE (disabled).
 * Previously the code had worth updates ON during learning — this is the spec violation.
 */
export function gatesFor(record: WorkspaceModeRecord | null | undefined): LearningGates {
  const learning = isLearningMode(record);
  return {
    hotTier:             !learning,
    anticipation:        !learning,
    composition:         !learning,
    worthUpdates:        !learning,  // RDD-5: DISABLED during learning (was always ON)
    consolidation:       !learning,
    extractionAggressive: learning,  // lower prefilter during learning to gather more signal
  };
}

/**
 * Should the workspace graduate from learning → production?
 *
 * RDD-5: any of the 4 criteria triggers graduation (spec §Resolved Design Decisions ~3516).
 *
 * Previously only sessionCount was checked — this function now checks all 4.
 */
export function shouldGraduate(record: WorkspaceModeRecord): boolean {
  if (record.mode !== "learning") return false;

  // Criterion 1: fact count
  if ((record.factCount ?? 0) >= GRADUATION.factCount) return true;

  // Criterion 2: session count (either against the custom promoteAt or the spec default)
  const sessionThreshold = record.promoteAt ?? GRADUATION.sessionCount;
  if (record.sessionCount >= sessionThreshold) return true;

  // Criterion 3: entity count
  if ((record.entityCount ?? 0) >= GRADUATION.entityCount) return true;

  // Criterion 4: days elapsed since learning mode started
  if (record.startedAt) {
    const daysElapsed = (Date.now() - record.startedAt.getTime()) / 86_400_000;
    if (daysElapsed >= GRADUATION.daysElapsed) return true;
  }

  return false;
}

/**
 * @deprecated Use shouldGraduate() — this kept for backward compatibility.
 *
 * Legacy single-criterion promotion check (sessionCount >= promoteAt).
 * RDD-5 replaces this with shouldGraduate() which checks all 4 criteria.
 */
export function shouldAutoPromote(record: WorkspaceModeRecord): boolean {
  if (record.mode !== "learning") return false;
  if (record.promoteAt === null || record.promoteAt === undefined) return false;
  return record.sessionCount >= record.promoteAt;
}
