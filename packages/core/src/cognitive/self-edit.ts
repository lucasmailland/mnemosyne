/**
 * Self-Editing Memory — pure policy layer (spec §13).
 * Zero infrastructure imports — all I/O flows through injected ports.
 *
 * Six actions:
 *   append    — append content to an existing fact/strategy/profile
 *   replace   — replace the content of a fact/strategy/profile
 *   strengthen — boost worth (positive reinforcement)
 *   weaken    — lower worth (negative reinforcement)
 *   forget    — archive/invalidate a fact (counts as a delete)
 *   reflect   — trigger full reflection cycle (never blocked by budget)
 *
 * Target polymorphism:
 *   "profile"          → {kind:"profile"}
 *   "strategy:{id}"    → {kind:"strategy", id}
 *   anything else      → {kind:"fact", id}
 */

import type { StorageAdapter } from "@mnemo-ai/types";
import type { Logger, Telemetry } from "@mnemo-ai/types";
import type { ActorProvenance } from "@mnemo-ai/types";
import type { MnemoFact } from "@mnemo-ai/types";
import { FactRevisionConflictError } from "@mnemo-ai/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SelfEditAction =
  "append" | "replace" | "strengthen" | "weaken" | "forget" | "reflect" | "link";

export type AllowedScope = "own_facts" | "own_strategies" | "own_profile";

export interface SelfEditPolicy {
  /** Maximum number of non-reflect edits per session. Default: 5 */
  maxEditsPerSession: number;
  /** Maximum number of "forget" (delete) operations per calendar day. Default: 3 */
  maxDeletesPerDay: number;
  /**
   * §34.7 — Maximum number of "strengthen" operations per calendar day.
   * Prevents runaway positive reinforcement loops. Default: 10.
   */
  maxStrengthensPerDay: number;
  /**
   * §34.7 — Maximum number of "weaken" operations per calendar day.
   * Prevents targeted worth-destruction. Default: 10.
   */
  maxWeakensPerDay: number;
  /** Whether a non-empty `reason` field is required. Default: true */
  requireReason: boolean;
  /**
   * §34.7 / §13 Cooldown in seconds between successive edits on the SAME target.
   * Prevents rapid-fire edits that circumvent the session budget.
   * Default: 300 (5 min).
   * @alias editGracePeriod — original §13 spec name, kept for backwards compat.
   */
  editCooldown: number;
  /**
   * §13 Grace period in seconds between successive edits on the SAME target.
   * Alias for editCooldown — the spec uses "editGracePeriod", the implementation
   * uses "editCooldown". Both are kept in sync to the same value.
   *
   * @field editGracePeriod - Implemented as a *cooldown* (rejects successive
   *   same-target edits faster than N seconds), NOT a rollback window.
   *   Staged/undoable edits are deferred to a future phase.
   */
  editGracePeriod: number;
  /**
   * §34.7 If true, "strengthen" and "weaken" operations on a target with
   * worth >= preserveWorthThreshold are silently downgraded to no-ops (not errors).
   * Protects high-worth memories from accidental strengthening beyond their ceiling.
   * Default: false.
   */
  preserveWorth: boolean;
  /**
   * §34.7 Worth ceiling threshold for preserveWorth semantics.
   * Only meaningful when preserveWorth=true. Default: 0.9.
   */
  preserveWorthThreshold: number;
  /**
   * §34.7 If true, all worth-modifying operations (strengthen/weaken) are blocked.
   * Used to "freeze" a memory's worth during A/B evaluation or legal hold.
   * Default: false.
   */
  freezeWorth: boolean;
  /**
   * §34.7 Threshold of same-target operations per hour after which the agent
   * is flagged for abuse review. 0 = disabled. Default: 5.
   */
  abuseFlagThresholdPerHour: number;
  /**
   * §13 Grace period (seconds) during which an append/replace edit can be
   * reverted via revertSelfEdit(). Distinct from editCooldown (which RATE-LIMITS
   * successive edits): this is a true undo window backed by an in-process
   * pre-edit snapshot. 0 disables undo. Default: 300 (5 min).
   */
  undoWindowSeconds: number;
  /** Which scopes the agent is allowed to edit. */
  allowEdit: ReadonlyArray<AllowedScope>;
  /** Actions that require human approval before execution. */
  requireApproval: ReadonlyArray<string>;
}

export type ParsedTarget =
  { kind: "profile" } | { kind: "strategy"; id: string } | { kind: "fact"; id: string };

export interface EvalInput {
  action: SelfEditAction;
  target: string;
  editsThisSession: number;
  deletesToday: number;
  /** §34.7 Number of strengthen operations performed today. */
  strengthensToday?: number;
  /** §34.7 Number of weaken operations performed today. */
  weakensToday?: number;
  /** §34.7 Number of strengthen operations for this specific target today. Max 1 per fact per day. */
  strengthensTodayForTarget?: number;
  /**
   * §34.7 Current worth of the target [0,1]. Used to enforce preserveWorth /
   * freezeWorth. null means unknown (policy checks are skipped).
   */
  targetWorth?: number | null;
  /**
   * §13 / §1167 Epoch-ms timestamp of this agent's most recent successful edit
   * (any non-reflect action), read from the durable counter store before eval.
   * null/undefined means "no prior edit recorded" → cooldown check is skipped.
   * When `now - lastEditAt < editCooldown * 1000`, the edit is REJECTED.
   */
  lastEditAt?: number | null;
  /**
   * §13 Current wall-clock time in epoch ms. Injected for testability /
   * determinism. Defaults to Date.now() when omitted.
   */
  now?: number;
  reason?: string;
}

export interface EvalResult {
  allow: boolean;
  reason?: string;
  /** Does this edit consume the session edit budget? */
  countsAsEdit: boolean;
  /** Does this edit consume the daily delete budget? */
  countsAsDelete: boolean;
  /** §34.7 Whether the agent should be flagged for abuse review. */
  abuseFlag?: boolean;
  /** APP-062: on a cooldown refusal, the seconds left before an edit is allowed. */
  retryAfterSeconds?: number;
}

export interface SelfEditRequest {
  workspaceId: string;
  agentId: string;
  requestedBy?: string;
  actorIsolationId?: string;
  userIsolationId?: string;
  action: SelfEditAction;
  target: string;
  content?: string;
  reason?: string;
  sessionId?: string;
  /** §34.7 Pre-computed EvalResult from evaluateSelfEdit. If provided with abuseFlag=true, the apply logs a warning. */
  evalResult?: EvalResult;
  /**
   * §13 Wall-clock epoch-ms at which this edit is applied. Injected for
   * deterministic undo-window tests. Defaults to Date.now() when omitted. Used
   * only to timestamp the undo snapshot.
   */
  now?: number;
  /**
   * p50-audit-log-emitters (PR7, design D3): the caller's resolved provenance
   * triple, used to emit a `self_edit` audit entry from INSIDE `applySelfEdit`
   * so both HTTP (`routes/self.ts`) and gRPC (`grpc.ts`) transports are
   * covered by a single emitter — a route-level emitter would silently miss
   * gRPC, which never goes through `routes/self.ts`. `requestedBy` above is a
   * flattened `userId ?? actorId` string and is not a usable provenance
   * source for a structured audit entry. Optional so every existing
   * caller/test that never threads a provenance triple keeps compiling and
   * passing unchanged — `applySelfEdit` only calls `ctx.storage.appendAuditEntry`
   * when this field is present.
   *
   * Corrected in this PR: PR1 (foundation) added this field to
   * `SelfEditOutcome` instead of here by mistake, so `applySelfEdit` could
   * never actually read it — `req: SelfEditRequest` is the input, not the
   * `SelfEditOutcome` return value. See apply-progress for the discrepancy note.
   */
  provenance?: ActorProvenance;
}

export interface SelfEditOutcome {
  applied: boolean;
  action: SelfEditAction;
  target: ParsedTarget;
  targetKind: ParsedTarget["kind"];
  replacementId?: string;
  countsAsEdit: boolean;
  countsAsDelete: boolean;
}

export class SelfEditTargetNotFoundError extends Error {
  readonly code = "self_edit_target_not_found";

  constructor() {
    super("Self-edit target not found");
    this.name = "SelfEditTargetNotFoundError";
  }
}

/**
 * PRIM-1: `append` and `replace` carry their new text in `content`. Without it
 * `replace` wrote `content ?? ""` — it closed the fact and left an EMPTY active
 * successor — and `append` reported `applied: true` having changed nothing.
 * Thrown before any read or write, so a refused edit leaves no trace.
 */
export class SelfEditContentRequiredError extends Error {
  readonly code = "self_edit_content_required";

  constructor(readonly action: SelfEditAction) {
    super(`content is required (non-empty) for self-edit action '${action}'`);
    this.name = "SelfEditContentRequiredError";
  }
}

/** CHAOS-8: how many times `append` re-reads after losing a revision race. */
const APPEND_MAX_ATTEMPTS = 3;

/** Actions whose `content` IS the new text and so must not be blank. */
const CONTENT_ACTIONS: ReadonlySet<SelfEditAction> = new Set(["append", "replace"]);

/**
 * PRIM-1: true when `action` needs text and `content` has none worth storing.
 * Exported so transports can refuse the request before touching any budget.
 */
export function selfEditContentMissing(
  action: SelfEditAction,
  content: string | undefined
): boolean {
  return CONTENT_ACTIONS.has(action) && (content === undefined || content.trim().length === 0);
}

// ─── Minimal context interface for self-edit ─────────────────────────────────

export interface SelfEditContext {
  storage: StorageAdapter;
  logger: Logger;
  telemetry: Telemetry;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_SELF_EDIT_POLICY: SelfEditPolicy = {
  maxEditsPerSession: 5,
  maxDeletesPerDay: 3,
  maxStrengthensPerDay: 3,
  maxWeakensPerDay: 5,
  requireReason: true,
  editCooldown: 300,
  editGracePeriod: 300, // §13 alias — kept in sync with editCooldown
  preserveWorth: false,
  preserveWorthThreshold: 0.9,
  freezeWorth: false,
  abuseFlagThresholdPerHour: 5,
  undoWindowSeconds: 300,
  allowEdit: ["own_facts", "own_strategies", "own_profile"],
  requireApproval: ["delete_fact", "edit_entity", "change_decision"],
};

// ─── parseTarget ─────────────────────────────────────────────────────────────

/**
 * Parse the polymorphic `target` string into a typed ParsedTarget.
 *   "profile"        → { kind: "profile" }
 *   "strategy:{id}"  → { kind: "strategy", id }
 *   anything else    → { kind: "fact", id: target }
 */
export function parseTarget(target: string): ParsedTarget {
  if (target === "profile") return { kind: "profile" };
  if (target.startsWith("strategy:")) {
    return { kind: "strategy", id: target.slice("strategy:".length) };
  }
  return { kind: "fact", id: target };
}

// ─── evaluateSelfEdit ─────────────────────────────────────────────────────────

/**
 * Pure policy evaluation — no I/O.
 * Returns whether the action is allowed, and whether it consumes budget.
 *
 * §34.7 additions:
 *  - maxStrengthensPerDay / maxWeakensPerDay budget checks
 *  - freezeWorth guard (blocks strengthen/weaken entirely)
 *  - preserveWorth guard (blocks strengthen when worth >= threshold)
 *  - abuseFlagThresholdPerHour signalling (sets abuseFlag on result)
 */
export function evaluateSelfEdit(input: EvalInput, policy: SelfEditPolicy): EvalResult {
  const {
    action,
    target,
    editsThisSession,
    deletesToday,
    strengthensToday = 0,
    weakensToday = 0,
    targetWorth,
    lastEditAt,
  } = input;

  // reflect is always allowed, never consumes budget
  if (action === "reflect") {
    return { allow: true, countsAsEdit: false, countsAsDelete: false };
  }

  // link creates a hyperedge across fact members — treat as a normal budgeted edit
  // targeting own_facts scope (the anchor is always a fact id).
  // Falls through to the standard requireReason / scope / budget checks below.

  // requireReason is enforced at the policy layer (spec §13)
  if (policy.requireReason && !input.reason) {
    return {
      allow: false,
      reason: "reason is required by policy (requireReason=true)",
      countsAsEdit: false,
      countsAsDelete: false,
    };
  }

  // Check scope permissions for the target kind
  const parsed = parseTarget(target);
  if (parsed.kind === "fact" && !policy.allowEdit.includes("own_facts")) {
    return {
      allow: false,
      reason: "Editing own_facts is not in the allowed scope.",
      countsAsEdit: false,
      countsAsDelete: false,
    };
  }
  if (parsed.kind === "strategy" && !policy.allowEdit.includes("own_strategies")) {
    return {
      allow: false,
      reason: "Editing own_strategies is not in the allowed scope.",
      countsAsEdit: false,
      countsAsDelete: false,
    };
  }
  if (parsed.kind === "profile" && !policy.allowEdit.includes("own_profile")) {
    return {
      allow: false,
      reason: "Editing own_profile is not in the allowed scope.",
      countsAsEdit: false,
      countsAsDelete: false,
    };
  }

  // §13 / §1167 cooldown: reject successive edits issued faster than editCooldown.
  // Applies to every non-reflect action (reflect already returned above). The
  // caller persists `lastEditAt` in the same durable store as the budget counters
  // and reads it back into the eval input; null/undefined → no prior edit → skip.
  if (policy.editCooldown > 0 && lastEditAt != null) {
    const now = input.now ?? Date.now();
    const elapsedMs = now - lastEditAt;
    const cooldownMs = policy.editCooldown * 1000;
    if (elapsedMs < cooldownMs) {
      const waitSeconds = Math.ceil((cooldownMs - elapsedMs) / 1000);
      return {
        allow: false,
        reason: `edit cooldown active: ${waitSeconds}s remaining (editCooldown=${policy.editCooldown}s).`,
        retryAfterSeconds: waitSeconds,
        countsAsEdit: false,
        countsAsDelete: false,
      };
    }
  }

  const isDelete = action === "forget";
  const isStrengthen = action === "strengthen";
  const isWeaken = action === "weaken";
  const isWorthOp = isStrengthen || isWeaken;

  // §34.7 freezeWorth: block all worth-modifying operations
  if (isWorthOp && policy.freezeWorth) {
    return {
      allow: false,
      reason: "Worth operations are frozen for this target (freezeWorth=true).",
      countsAsEdit: false,
      countsAsDelete: false,
    };
  }

  // §34.7 preserveWorth: block strengthen when target worth is at or above threshold
  if (isStrengthen && policy.preserveWorth && targetWorth != null) {
    if (targetWorth >= policy.preserveWorthThreshold) {
      return {
        allow: false,
        reason: `strengthen blocked: target worth ${targetWorth.toFixed(3)} >= preserveWorthThreshold ${policy.preserveWorthThreshold} (preserveWorth=true).`,
        countsAsEdit: false,
        countsAsDelete: false,
      };
    }
  }

  // §34.7 maxStrengthensPerDay budget
  if (isStrengthen && strengthensToday >= policy.maxStrengthensPerDay) {
    return {
      allow: false,
      reason: `maxStrengthensPerDay (${policy.maxStrengthensPerDay}) reached. Try again tomorrow.`,
      countsAsEdit: false,
      countsAsDelete: false,
    };
  }

  // §34.7 per-fact strengthen cap: max 1 strengthen per fact per day
  if (isStrengthen && (input.strengthensTodayForTarget ?? 0) >= 1) {
    return {
      allow: false,
      reason: "max 1 strengthen per fact per day",
      countsAsEdit: false,
      countsAsDelete: false,
    };
  }

  // §34.7 maxWeakensPerDay budget
  if (isWeaken && weakensToday >= policy.maxWeakensPerDay) {
    return {
      allow: false,
      reason: `maxWeakensPerDay (${policy.maxWeakensPerDay}) reached. Try again tomorrow.`,
      countsAsEdit: false,
      countsAsDelete: false,
    };
  }

  // Check delete budget first (before edit budget)
  if (isDelete && deletesToday >= policy.maxDeletesPerDay) {
    return {
      allow: false,
      reason: `maxDeletesPerDay (${policy.maxDeletesPerDay}) reached. Try again tomorrow.`,
      countsAsEdit: false,
      countsAsDelete: false,
    };
  }

  // Check edit budget
  if (editsThisSession >= policy.maxEditsPerSession) {
    return {
      allow: false,
      reason: `maxEditsPerSession (${policy.maxEditsPerSession}) reached for this session.`,
      countsAsEdit: false,
      countsAsDelete: false,
    };
  }

  // §34.7 abuse flag: set when worth-op rate is already at threshold
  // The caller is responsible for tracking the hourly rate — we just signal
  // when the combined strengthen+weaken count for the hour hits the threshold.
  const combinedWorthOpsToday = strengthensToday + weakensToday;
  const abuseFlag =
    policy.abuseFlagThresholdPerHour > 0 &&
    isWorthOp &&
    combinedWorthOpsToday + 1 >= policy.abuseFlagThresholdPerHour;

  return {
    allow: true,
    countsAsEdit: true,
    countsAsDelete: isDelete,
    ...(abuseFlag ? { abuseFlag: true } : {}),
  };
}

// ─── §13 Undo window ───────────────────────────────────────────────────────────

/**
 * Pre-edit snapshot captured by applySelfEdit for append/replace actions, so the
 * edit can be reverted within the policy undo window via revertSelfEdit().
 *
 * IMPORTANT: this store is PROCESS-LOCAL (a module-level Map). It is a lightweight
 * best-effort grace window, NOT a durable rollback log — snapshots are lost on
 * restart and are NOT shared across instances. A future multi-instance deployment
 * that needs cross-process undo must move this to a durable port. Keyed by
 * `${workspaceId}:${target}` so concurrent workspaces never collide.
 */
interface UndoSnapshot {
  /** ParsedTarget kind so revert routes to the right storage method. */
  kind: ParsedTarget["kind"];
  /** The id (fact/strategy) or the agentId (profile). */
  id: string;
  /** Pre-edit content: fact.statement / strategy.action / profile.summary. */
  previousContent: string;
  /** Epoch-ms when the edit was applied (window start). */
  editedAtMs: number;
  workspaceId: string;
  agentId: string;
}

const undoSnapshots = new Map<string, UndoSnapshot>();

function undoKey(workspaceId: string, target: string): string {
  return `${workspaceId}:${target}`;
}

/**
 * Revert the most recent append/replace on `target` if it happened within
 * `undoWindowSeconds`. Returns true on a successful revert, false when there is
 * no snapshot or the window has elapsed (snapshot is dropped in both terminal
 * cases). Pure-policy + port I/O — never throws on a missing target.
 */
export async function revertSelfEdit(
  ctx: SelfEditContext,
  target: string,
  opts: { workspaceId: string; undoWindowSeconds: number; now?: number }
): Promise<boolean> {
  const key = undoKey(opts.workspaceId, target);
  const snap = undoSnapshots.get(key);
  if (!snap) return false;

  const now = opts.now ?? Date.now();
  if (opts.undoWindowSeconds <= 0 || now - snap.editedAtMs > opts.undoWindowSeconds * 1000) {
    undoSnapshots.delete(key); // window elapsed — discard so it can't be reused
    return false;
  }

  const span = ctx.telemetry.startSpan("mnemo.self.edit.revert", {
    attributes: { targetKind: snap.kind },
  });
  try {
    if (snap.kind === "fact") {
      const current = await ctx.storage.getFact(snap.id, snap.workspaceId);
      if (!current || current.status !== "active" || current.validTo != null) {
        undoSnapshots.delete(key);
        return false;
      }
      const reverted = await ctx.storage.updateFact(snap.id, snap.workspaceId, {
        statement: snap.previousContent,
      });
      if (!reverted) {
        undoSnapshots.delete(key);
        return false;
      }
    } else if (snap.kind === "strategy") {
      await ctx.storage.updateStrategy(snap.id, {
        workspaceId: snap.workspaceId,
        action: snap.previousContent,
      });
    } else {
      await ctx.storage.upsertAgentProfile({
        workspaceId: snap.workspaceId,
        agentId: snap.agentId,
        summary: snap.previousContent,
      });
    }
    undoSnapshots.delete(key); // single-use
    ctx.logger.info("self_edit.reverted", {
      workspaceId: snap.workspaceId,
      agentId: snap.agentId,
      target,
      targetKind: snap.kind,
    });
    return true;
  } finally {
    span.end();
  }
}

// ─── applySelfEdit ────────────────────────────────────────────────────────────

/**
 * Orchestrate the approved edit through ctx.storage.
 * The caller MUST run evaluateSelfEdit first and verify allow === true.
 *
 * reflect is intentionally unsupported here — route it to runReflectionCycle()
 * in self-reflect.ts instead.
 */
export async function applySelfEdit(
  ctx: SelfEditContext,
  req: SelfEditRequest
): Promise<SelfEditOutcome> {
  const { action, target, content, workspaceId, agentId } = req;
  const parsed = parseTarget(target);

  if (action === "reflect") {
    throw new Error(
      'applySelfEdit: use runReflectionCycle() in self-reflect.ts for the "reflect" action.'
    );
  }

  // PRIM-1: refuse blank text before the abuse review item, the target read and
  // every mutation below. The text itself is stored as supplied (not trimmed).
  if (selfEditContentMissing(action, content)) {
    throw new SelfEditContentRequiredError(action);
  }

  // §34.7 abuse flag: log a warning if the eval flagged abuse so it surfaces in telemetry.
  if (req.evalResult?.abuseFlag) {
    ctx.logger.warn("self_edit.abuse_flag", {
      workspaceId,
      agentId,
      action,
      target,
      errorCode: "mnemo.self_edit.abuse_flagged",
    });
    // P111: this used to append a `self_edit_abuse_review` queue_job. Nothing
    // consumed that job — no `queue.process` handler was ever registered for it
    // — and the payload was written flat, so even with a consumer the outbox
    // worker would have enqueued `{}` (the same shape bug as P74's two
    // producers). An abuse signal that a security policy raises, and that then
    // goes nowhere, is worse than not raising it: the warning log above made it
    // look handled.
    //
    // Routed instead to `mnemo_review_item`, the durable review queue that
    // already backs the analogous case — remember()'s §33 contradiction review
    // uses the very same call. That makes the flag queryable and resolvable
    // rather than fire-and-forget.
    //
    // `profile` targets carry no primitive id (parseTarget returns {kind} only),
    // so the agent id stands in as the subject of the review — the thing being
    // reviewed there IS the agent's behaviour, not a row.
    await ctx.storage.enqueueReviewItem({
      workspaceId,
      primitiveId: "id" in parsed && parsed.id ? parsed.id : (agentId ?? "unknown"),
      primitiveKind: parsed.kind,
      reason: "self_edit_abuse",
      detail: {
        agentId,
        action,
        target,
        ...(req.reason ? { requestedReason: req.reason } : {}),
      },
    });
  }

  const span = ctx.telemetry.startSpan("mnemo.self.edit", {
    attributes: { action, targetKind: parsed.kind },
  });
  let replacementId: string | undefined;
  try {
    // P123 — the target has to EXIST before any branch pretends to act on it.
    //
    // The switch below grew one existence check (`replace`, which throws) and
    // several branches with none. `append` read the row and, when it found
    // nothing, ran `if (existing && content)` with no `else`: the branch fell
    // through to the switch's success return, so a nonexistent id came back as
    // `applied: true` with nothing written. `strengthen`/`weaken`/`forget` never
    // read the row at all — they call `updateWorth`/`archiveFact` on whatever id
    // they were handed and report success regardless of whether it matched.
    //
    // That is worse than a missing 404. An agent that appends knowledge and is
    // told `applied: true` has no reason to check, and the write is charged
    // against the edit budget and starts the 300s cooldown — it pays for a write
    // that never happened. Verified against the running container before fixing.
    //
    // Hoisted out of the branches rather than patched into each one, because
    // "did the thing I am about to edit exist" is a property of the OPERATION,
    // not of any single case — and the next branch someone adds inherits it
    // instead of having to remember. `reflect` and `link` are excluded: reflect
    // does not address a row, and link's target is one member id among several
    // whose validity is `createHyperedge`'s business.
    const NEEDS_EXISTING_TARGET = new Set(["append", "replace", "strengthen", "weaken", "forget"]);
    let targetRow: MnemoFact | null = null;
    if (NEEDS_EXISTING_TARGET.has(action) && "id" in parsed && parsed.id) {
      if (parsed.kind === "fact") {
        targetRow = await ctx.storage.getFact(parsed.id, workspaceId);
        if (!targetRow) throw new SelfEditTargetNotFoundError();
      } else if (parsed.kind === "strategy") {
        const strategy = await ctx.storage.getStrategy(parsed.id, workspaceId);
        if (!strategy) throw new SelfEditTargetNotFoundError();
      }
    }

    switch (action) {
      case "strengthen": {
        if (parsed.kind === "profile") {
          throw new Error("strengthen/weaken requires a fact or strategy target, not profile");
        }
        await ctx.storage.updateWorth(
          parsed.kind === "fact" ? parsed.id : parsed.id,
          workspaceId,
          parsed.kind === "fact" ? "fact" : "strategy",
          { success: 1, failure: 0, creditWeight: 1 }
        );
        break;
      }

      case "weaken": {
        if (parsed.kind === "profile") {
          throw new Error("strengthen/weaken requires a fact or strategy target, not profile");
        }
        await ctx.storage.updateWorth(
          parsed.kind === "fact" ? parsed.id : parsed.id,
          workspaceId,
          parsed.kind === "fact" ? "fact" : "strategy",
          { success: 0, failure: 1, creditWeight: 1 }
        );
        break;
      }

      case "forget": {
        if (parsed.kind === "fact") {
          await ctx.storage.archiveFact(parsed.id, workspaceId);
        } else if (parsed.kind === "strategy") {
          await ctx.storage.archiveStrategy(parsed.id, workspaceId);
        }
        // forget on profile is a no-op (can't delete own profile)
        break;
      }

      case "append": {
        const editedAtMs = req.now ?? Date.now();
        if (parsed.kind === "fact") {
          // P123: `targetRow` was fetched and null-checked above, so a missing
          // fact can no longer reach here. Reused rather than re-read: two
          // reads could disagree, and the second one is what the old code
          // silently trusted.
          let existing = targetRow;
          // CHAOS-8: append is read-modify-write, and the read above holds no
          // lock — two concurrent appends both read the same text and the
          // second UPDATE erased the first. The write is conditional on the
          // revision that was read; on a conflict, re-read and re-apply.
          for (let attempt = 1; existing && content; attempt++) {
            undoSnapshots.set(undoKey(workspaceId, target), {
              kind: "fact",
              id: parsed.id,
              previousContent: existing.statement,
              editedAtMs,
              workspaceId,
              agentId,
            });
            let updated: MnemoFact | null;
            try {
              updated = await ctx.storage.updateFact(parsed.id, workspaceId, {
                statement: existing.statement + "\n" + content,
                ...(typeof existing.revisionCount === "number"
                  ? { expectedRevision: existing.revisionCount }
                  : {}),
              });
            } catch (err) {
              const conflict =
                err instanceof FactRevisionConflictError ||
                (err as { code?: unknown } | null)?.code === "REVISION_CONFLICT";
              if (!conflict || attempt >= APPEND_MAX_ATTEMPTS) {
                undoSnapshots.delete(undoKey(workspaceId, target));
                throw err;
              }
              existing = await ctx.storage.getFact(parsed.id, workspaceId);
              if (!existing) {
                undoSnapshots.delete(undoKey(workspaceId, target));
                throw new SelfEditTargetNotFoundError();
              }
              continue;
            }
            if (!updated) {
              undoSnapshots.delete(undoKey(workspaceId, target));
              throw new SelfEditTargetNotFoundError();
            }
            break;
          }
        } else if (parsed.kind === "strategy") {
          const existing = await ctx.storage.getStrategy(parsed.id, workspaceId);
          if (existing && content) {
            undoSnapshots.set(undoKey(workspaceId, target), {
              kind: "strategy",
              id: parsed.id,
              previousContent: existing.action,
              editedAtMs,
              workspaceId,
              agentId,
            });
            await ctx.storage.updateStrategy(parsed.id, {
              workspaceId,
              action: existing.action + "\n" + content,
            });
          }
        } else {
          // profile append — merge into summary
          const existing = await ctx.storage.getAgentProfile(workspaceId, agentId);
          undoSnapshots.set(undoKey(workspaceId, target), {
            kind: "profile",
            id: agentId,
            previousContent: existing?.summary ?? "",
            editedAtMs,
            workspaceId,
            agentId,
          });
          const summary = (existing?.summary ?? "") + (content ? "\n" + content : "");
          await ctx.storage.upsertAgentProfile({ workspaceId, agentId, summary });
        }
        break;
      }

      case "replace": {
        const editedAtMs = req.now ?? Date.now();
        if (parsed.kind === "fact") {
          const result = await ctx.storage.replaceFact({
            id: parsed.id,
            workspaceId,
            statement: content ?? "",
            requestedBy: req.requestedBy ?? agentId,
            agentId,
            ...(req.actorIsolationId ? { actorIsolationId: req.actorIsolationId } : {}),
            ...(req.userIsolationId ? { userIsolationId: req.userIsolationId } : {}),
          });
          if (!result) throw new SelfEditTargetNotFoundError();
          replacementId = result.replacement.id;
          undoSnapshots.delete(undoKey(workspaceId, target));
        } else if (parsed.kind === "strategy") {
          const existing = await ctx.storage.getStrategy(parsed.id, workspaceId);
          undoSnapshots.set(undoKey(workspaceId, target), {
            kind: "strategy",
            id: parsed.id,
            previousContent: existing?.action ?? "",
            editedAtMs,
            workspaceId,
            agentId,
          });
          await ctx.storage.updateStrategy(parsed.id, {
            workspaceId,
            action: content ?? "",
          });
        } else {
          // profile replace
          const existing = await ctx.storage.getAgentProfile(workspaceId, agentId);
          undoSnapshots.set(undoKey(workspaceId, target), {
            kind: "profile",
            id: agentId,
            previousContent: existing?.summary ?? "",
            editedAtMs,
            workspaceId,
            agentId,
          });
          await ctx.storage.upsertAgentProfile({ workspaceId, agentId, summary: content ?? "" });
        }
        break;
      }

      case "link": {
        // content = comma-separated co-member ids; target is the anchor member.
        const others = (content ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const memberIds = [target, ...others];
        if (memberIds.length < 3) {
          throw new Error(
            `link requires ≥3 member ids (anchor + ≥2 in content), got ${memberIds.length}`
          );
        }
        await ctx.storage.createHyperedge({
          workspaceId,
          memberIds,
          label: "associated",
          description: `Manually linked via self-edit: ${req.reason ?? ""}`.trim(),
        });
        break;
      }
    }

    // Determine budget impact directly from action type.
    // We pass reason=undefined into evaluateSelfEdit here which would trip
    // requireReason and always return countsAsEdit=false — so derive these
    // values from the action directly instead.
    const isDelete = action === "forget";
    const countsAsEdit = true; // all non-reflect actions consume edit budget
    const countsAsDelete = isDelete;

    // p50-audit-log-emitters (PR7, design D3/D1 emitter map): emit `self_edit`
    // from inside applySelfEdit so both the HTTP transport (routes/self.ts)
    // and the gRPC transport (grpc.ts) are covered by this single call site —
    // gated on req.provenance being present so every pre-existing caller/test
    // that never threads a provenance triple keeps compiling and passing
    // unchanged (their storage stubs don't implement appendAuditEntry).
    // Unguarded await, matching the existing inline convention already used
    // by forget.ts's hard_delete/delete emitters — core emitters do NOT use
    // the server-only emitAudit() helper (that would violate hexagonal
    // purity: packages/core/src/cognitive/ must stay free of server imports).
    if (req.provenance) {
      const resourceId = parsed.kind === "profile" ? agentId : parsed.id;
      await ctx.storage.appendAuditEntry({
        workspaceId,
        actorType: req.provenance.actorType,
        actorId: req.provenance.actorId,
        action: "self_edit",
        resourceKind: "self_edit",
        resourceId,
        isTerminal: false,
        detail: {
          ...(req.provenance.userId ? { userId: req.provenance.userId } : {}),
          action,
          targetKind: parsed.kind,
          agentId,
          ...(replacementId ? { replacementId } : {}),
          ...(req.evalResult?.abuseFlag ? { abuseFlag: true } : {}),
        },
      });
    }

    return {
      applied: true,
      action,
      target: parsed,
      targetKind: parsed.kind,
      ...(replacementId ? { replacementId } : {}),
      countsAsEdit,
      countsAsDelete,
    };
  } finally {
    span.end();
  }
}
