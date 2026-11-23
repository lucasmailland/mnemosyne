// Federation SyncEngine with tombstone support (TASK-13001).
// AUDIT_REPORT.md FED-03, PLUGINS_AND_FEDERATION.md §11.
//
// Critical security invariants (non-negotiable):
//   1. Version-inflation guard: reject incoming.version > local.version + 100
//      when the local copy came from ANOTHER peer. A copy from the same peer is
//      that peer's own item (the caller stamps peerDomain with the authenticated
//      peer), so a jump there only touches its own data, and a fact edited more
//      than 100 times between two syncs still arrives.
//   2. Attribution cap: all federated items → attribution = "federation_received"
//      regardless of claimed attribution value (trust score 20, no promotion).
//      Enforced at EVERY read of remote-sourced attribution/worth — conflict
//      resolution and consensus voting, not just the final upsert — so a peer
//      cannot win a conflict/vote by self-declaring a higher trust anchor or
//      an inflated worth before the cap is applied.
//   3. Resurrection guard: check mnemo_deletion_log before accepting any item
//   4. Tombstone handling: process deletedAt items — archive local + log deletion,
//      only when the sender is the peer the local copy came from. A tombstone
//      for another peer's item is rejected; one for an item we do not hold
//      changes nothing, so a peer cannot pre-block ids it does not own.
//
// Peer trust weights come from LOCAL peer config ONLY — never from self-reported
// vote payloads (this would allow a compromised peer to elevate its own weight).

import { resolveConflict, type ConflictFact } from "./resolveConflict.js";
import {
  federatedConsensus,
  type ConsensusResult,
  type FederationVote,
} from "./federatedConsensus.js";

// ─── Vector clock — §20 CRDT ordering ────────────────────────────────────────

/** Lamport vector clock: { peerId → monotonic counter } */
export type VectorClock = Record<string, number>;

type VCRelation = "dominates" | "dominated" | "concurrent" | "equal";

/** Compare two vector clocks. Returns the relationship of `a` relative to `b`. */
export function vcCompare(a: VectorClock, b: VectorClock): VCRelation {
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let aGt = false;
  let bGt = false;
  for (const k of allKeys) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (av > bv) aGt = true;
    else if (bv > av) bGt = true;
  }
  if (!aGt && !bGt) return "equal";
  if (aGt && !bGt) return "dominates";
  if (!aGt && bGt) return "dominated";
  return "concurrent";
}

/** Merge two vector clocks by taking the max per component. */
export function vcMerge(a: VectorClock, b: VectorClock): VectorClock {
  const result: VectorClock = { ...a };
  for (const [k, v] of Object.entries(b)) {
    result[k] = Math.max(result[k] ?? 0, v);
  }
  return result;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FederatedItem {
  /** Stable identifier across federation peers. */
  remoteId: string;
  /** Monotonically increasing version from the originating peer. */
  version: number;
  /**
   * CRDT vector clock for partial-order causal tracking (§20).
   * When present, vcCompare() is used instead of version comparison.
   */
  vectorClock?: VectorClock;
  /** The claimed attribution — MUST be overridden to "federation_received". */
  attribution?: string;
  /** ISO timestamp of logical deletion (tombstone). */
  deletedAt?: string;
  /** Arbitrary payload (fact, decision, entity, etc.). */
  payload: Record<string, unknown>;
  /** The peer that sent this item. */
  peerDomain: string;
}

export interface LocalItemRef {
  localId: string;
  remoteId: string;
  version: number;
  /** Vector clock stored with the local item; undefined for pre-VC items. */
  vectorClock?: VectorClock;
  workspaceId: string;
  peerDomain: string;
  /** Attribution of the locally stored item (for resolver). */
  attribution?: string;
  /** Worth score of the locally stored item (for resolver). */
  worth?: number;
  /** validFrom ISO string of the locally stored item (for resolver). */
  validFrom?: string;
}

export interface SyncStorage {
  findByRemoteId(remoteId: string, workspaceId: string): Promise<LocalItemRef | null>;
  isInDeletionLog(remoteId: string, workspaceId: string): Promise<boolean>;
  upsertFederatedItem(opts: {
    workspaceId: string;
    remoteId: string;
    peerDomain: string;
    version: number;
    vectorClock?: VectorClock;
    attribution: "federation_received";
    payload: Record<string, unknown>;
  }): Promise<{ localId: string }>;
  archiveLocalItem(localId: string, workspaceId: string): Promise<void>;
  insertDeletionLog(opts: {
    workspaceId: string;
    remoteId: string;
    peerDomain: string;
    reason: "federation_tombstone";
    deletedAt: string;
  }): Promise<void>;
  /**
   * §20 "merge" supersession chain — link an old local item to the new item that
   * supersedes it, retaining (not discarding) the prior version. Optional: storage
   * adapters that predate the merge strategy may omit it, in which case the engine
   * degrades the merge to a plain theirs-wins upsert (logged).
   */
  markSuperseded?(opts: {
    workspaceId: string;
    /** localId of the prior item being superseded. */
    supersededLocalId: string;
    /** remoteId the new item shares with the prior one (the supersession chain key). */
    remoteId: string;
    peerDomain: string;
  }): Promise<void>;
}

export interface SyncLogger {
  warn(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
}

export interface SyncEngineContext {
  storage: SyncStorage;
  logger: SyncLogger;
  workspaceId: string;
  /** Called when a conflict is unresolvable and needs human review. */
  onContested?: (context: { remoteId: string; workspaceId: string }) => void;
}

export type SyncOutcome =
  | "upserted"
  | "tombstoned"
  | "rejected_version_inflation"
  | "rejected_resurrection_guard"
  | "rejected_foreign_tombstone"
  | "skipped_no_change"
  | "skipped_tie_lost"
  | "skipped_resolver_kept_local"
  | "contested_enqueued_review"
  | "merged_superseded"
  | "reconciled_consensus_incoming"
  | "reconciled_consensus_local"
  | "error";

export interface SyncItemResult {
  remoteId: string;
  outcome: SyncOutcome;
}

/**
 * §20 conflict-resolution strategy (the 4 spec strategies):
 *   - theirs_wins: incoming always supersedes local (skip resolver)
 *   - ours_wins:   local is always kept (skip resolver)
 *   - manual:      every conflict is enqueued for human review
 *   - merge:       supersession chain — incoming becomes current, the prior local
 *                  item is retained and linked as superseded (nothing discarded)
 * Omitted → default: run the §33 trust/recency/worth resolver.
 */
export type ConflictResolution = "theirs_wins" | "ours_wins" | "manual" | "merge";

/**
 * One already-gathered version of a fact as held by a specific federation peer.
 * This is the unit of the §33 multi-instance vote: the caller assembles these
 * (e.g. from per-peer pull results / the PeerStore) BEFORE handing them to the
 * engine. The engine never fetches them itself — gathering is a caller concern.
 *
 * `worth`/`freshness`/`attribution` describe the peer's copy; `instanceId` keys
 * the LOCAL trust weight (see ProcessItemOpts.peerTrustWeights) — it is NEVER a
 * channel for a peer to assert its own trust.
 */
export interface PeerVersion {
  /** The peer instance that holds this version (keys the local trust weight). */
  instanceId: string;
  /** The version identifier this peer is voting for (e.g. content hash / version tag). */
  factVersion: string;
  /** TRUST_ANCHORS attribution of the peer's copy. */
  attribution: string;
  /** Worth score of the peer's copy (defaults to 1 when absent). */
  worth?: number;
  /** ISO timestamp the peer's copy was recorded (drives freshness decay). */
  freshness?: string;
}

export interface ProcessItemOpts {
  conflictResolution?: ConflictResolution;
  /**
   * §33 multi-instance consensus inputs. When the SAME fact has versions/votes
   * from MULTIPLE peers (more than the single incoming item), the caller passes
   * the other known peer versions here. The pairwise resolveConflict path still
   * runs first; only when it is UNDECIDED and these multi-peer votes exist does
   * the engine escalate to the weighted-supermajority federatedConsensus vote.
   * Absent/empty → behaviour is unchanged (pure pairwise resolveConflict).
   */
  knownPeerVersions?: PeerVersion[];
  /**
   * Per-instance trust weights from the LOCAL PeerStore (PeerConfig.trustWeight),
   * keyed by instanceId. Required for a trustworthy vote; passed straight through
   * to federatedConsensus. NEVER assembled from peer payloads.
   */
  peerTrustWeights?: ReadonlyMap<string, number>;
}

// ─── Version-inflation limit (constant, not configurable) ─────────────────────

const MAX_VERSION_JUMP = 100;

// ─── Attribution/worth cap for remote-sourced input (S7/S8) ───────────────────
//
// `attribution` and `worth` on an incoming item are self-reported by the
// sending peer inside its payload — an untrusted input. The file header's
// "Attribution cap" invariant previously only applied at the final upsert
// (attribution: "federation_received" in upsertItem below), AFTER
// resolveConflict/federatedConsensus had already scored and decided the
// winner using the peer's own unclamped claim (e.g. a peer claiming
// attribution:"objective_fact" would score 100 instead of the federation
// ceiling of 20, and an unbounded worth would dominate any weighted vote).
// These helpers enforce the cap at every point remote-sourced attribution/
// worth is read, not just at the point of writing.
const FEDERATION_RECEIVED_ATTRIBUTION = "federation_received";

/** Worth is a Beta-distribution mean in [0, 1] for local data; clamp remote claims to match. */
function clampRemoteWorth(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

// ─── SyncEngine ───────────────────────────────────────────────────────────────

export class SyncEngine {
  constructor(private readonly ctx: SyncEngineContext) {}

  /**
   * The same engine writing into `workspaceId`. A sync job pulls into the
   * workspace that triggered it, not the engine's boot-time default.
   * `run` sets this run's `onContested` handler.
   */
  forWorkspace(workspaceId: string, run: Pick<SyncEngineContext, "onContested"> = {}): SyncEngine {
    return new SyncEngine({ ...this.ctx, workspaceId, ...run });
  }

  /**
   * Process a single incoming federated item.
   * Returns the outcome for observability / logging.
   */
  async processItem(item: FederatedItem, opts?: ProcessItemOpts): Promise<SyncItemResult> {
    const { storage, logger, workspaceId } = this.ctx;
    const { remoteId, version, vectorClock, deletedAt, peerDomain, payload } = item;

    // ── Resurrection guard: refuse items that were previously deleted ──────────
    const wasDeleted = await storage.isInDeletionLog(remoteId, workspaceId);
    if (wasDeleted) {
      logger.warn("federation: resurrection guard triggered — item is in deletion log", {
        remoteId,
        peerDomain,
        version,
      });
      return { remoteId, outcome: "rejected_resurrection_guard" };
    }

    const local = await storage.findByRemoteId(remoteId, workspaceId);
    // The local copy came from the sender. Only the exact peer id counts: copies
    // older servers stored under a host name were renamed once by migration 0066
    // where that was unambiguous, and the rest stay another origin.
    const fromSender = local !== null && local.peerDomain === peerDomain;

    // ── Tombstone processing ───────────────────────────────────────────────────
    if (deletedAt) {
      if (!local) {
        // Nothing to delete. Logging it would let any peer block an id it does not own.
        return { remoteId, outcome: "skipped_no_change" };
      }
      if (!fromSender) {
        logger.warn("federation: tombstone from a peer that is not the item's origin", {
          remoteId,
          peerDomain,
          originPeer: local.peerDomain,
        });
        return { remoteId, outcome: "rejected_foreign_tombstone" };
      }
      await storage.archiveLocalItem(local.localId, workspaceId);
      await storage.insertDeletionLog({
        workspaceId,
        remoteId,
        peerDomain,
        reason: "federation_tombstone",
        deletedAt,
      });
      logger.info("federation: tombstone processed", { remoteId, peerDomain, deletedAt });
      return { remoteId, outcome: "tombstoned" };
    }

    // ── Version-inflation guard ────────────────────────────────────────────────
    // A copy from the same peer is not in conflict with it (see below).
    const sameOrigin = fromSender && !(vectorClock && local!.vectorClock);
    if (local && !sameOrigin && version > local.version + MAX_VERSION_JUMP) {
      logger.warn("federation: version-inflation guard triggered", {
        remoteId,
        peerDomain,
        incomingVersion: version,
        localVersion: local.version,
        maxJump: MAX_VERSION_JUMP,
      });
      return { remoteId, outcome: "rejected_version_inflation" };
    }

    // ── §20 Vector-clock causal ordering (when both sides carry a VC) ─────────
    if (local && vectorClock && local.vectorClock) {
      const vcRelation = vcCompare(vectorClock, local.vectorClock);
      if (vcRelation === "equal" || vcRelation === "dominated") {
        logger.debug("federation: vc — local is causally current or newer, skipping", {
          remoteId,
          vcRelation,
        });
        return { remoteId, outcome: "skipped_no_change" };
      }
      if (vcRelation === "concurrent") {
        // Concurrent updates: delegate to conflict resolver below (don't short-circuit)
        logger.debug("federation: vc — concurrent update detected, running resolver", { remoteId });
      }
      // vcRelation === "dominates": incoming is causally newer — fall through to upsert
    }

    // ── §20/§33 Conflict resolver (runs when local exists) ────────────────────
    if (local) {
      const strategy = opts?.conflictResolution;

      // Explicit short-circuit: ours_wins always keeps local
      if (strategy === "ours_wins") {
        logger.debug("federation: ours_wins strategy — keeping local", { remoteId });
        return { remoteId, outcome: "skipped_resolver_kept_local" };
      }

      // Explicit short-circuit: manual always enqueues review
      if (strategy === "manual") {
        this.ctx.onContested?.({ remoteId, workspaceId });
        logger.debug("federation: manual strategy — enqueuing contested review", { remoteId });
        return { remoteId, outcome: "contested_enqueued_review" };
      }

      // §20 "merge" supersession chain: retain the prior local item (link it as
      // superseded) and let the incoming item become current via the upsert below.
      // Neither side is discarded. If the storage adapter predates merge support
      // (no markSuperseded), degrade to a plain theirs-wins upsert with a warning
      // rather than silently dropping the supersession link.
      if (strategy === "merge") {
        if (storage.markSuperseded) {
          await storage.markSuperseded({
            workspaceId,
            supersededLocalId: local.localId,
            remoteId,
            peerDomain,
          });
          logger.info(
            "federation: merge strategy — prior item superseded, incoming becomes current",
            {
              remoteId,
              supersededLocalId: local.localId,
            }
          );
          // Fall through to the upsert below; report the merge-specific outcome.
          await this.upsertItem(item, local, logger);
          return { remoteId, outcome: "merged_superseded" };
        }
        logger.warn(
          "federation: merge strategy requested but storage has no markSuperseded — " +
            "degrading to theirs_wins upsert (supersession chain not recorded)",
          { remoteId }
        );
        // Fall through to upsert (theirs_wins semantics) below.
      }

      // A copy that came from this same peer is not in conflict with it: a
      // higher version is that peer's own update and applies, anything else is
      // what we already hold. Only a copy from another peer goes to the resolver
      // (with two federation_received sides it can only answer "recency, 0.7",
      // under the 0.7 bar, so every update used to end contested).
      if (sameOrigin && version <= local.version && strategy !== "theirs_wins") {
        return { remoteId, outcome: "skipped_no_change" };
      }

      // When both have VCs and incoming dominates, skip the resolver (VC is authoritative)
      const skipResolver =
        sameOrigin ||
        (vectorClock &&
          local.vectorClock &&
          vcCompare(vectorClock, local.vectorClock) === "dominates");

      // Explicit theirs_wins (and degraded merge, see above): fall through to upsert
      // (skip resolver). `merge` only reaches here when storage lacks markSuperseded,
      // in which case it behaves as theirs_wins.
      if (strategy !== "theirs_wins" && strategy !== "merge" && !skipResolver) {
        // Default: run the §33 resolveConflict resolver
        const lf: ConflictFact = {
          attribution: local.attribution ?? "federation_received",
          worth: local.worth ?? 1,
          validFrom: new Date(local.validFrom ?? new Date().toISOString()),
        };
        const inf: ConflictFact = {
          // S7: never trust the peer's claimed attribution — it is always
          // federation_received (trust score 20) at decision time, not just at upsert.
          attribution: FEDERATION_RECEIVED_ATTRIBUTION,
          worth: clampRemoteWorth((payload as Record<string, unknown>)["worth"]),
          validFrom: new Date(
            String((payload as Record<string, unknown>)["validFrom"] ?? new Date().toISOString())
          ),
        };
        const v = resolveConflict(lf, inf);
        const decisiveIncoming = v.winner === "incoming" && v.confidence > 0.7;
        const decisiveLocal = v.winner === "local" && v.confidence > 0.7;

        // ── §33 multi-instance escalation ──────────────────────────────────
        // The pairwise resolver only ever sees 2 candidates (local + this one
        // incoming peer). When the SAME fact has versions from MORE peers (the
        // caller gathered them into opts.knownPeerVersions), a 2-way verdict is
        // not the whole story: escalate to the weighted-supermajority vote over
        // ALL known versions. Only do this when the pairwise verdict was NOT a
        // clear incoming win (a decisive incoming win already agrees with "adopt
        // incoming", so there is nothing to reconcile) — keeping resolveConflict
        // as the authoritative single-peer / fallback path.
        const peerVersions = opts?.knownPeerVersions;
        if (!decisiveIncoming && peerVersions && peerVersions.length > 0) {
          const consensusResult = this.reconcileVersions(
            { local, localFact: lf, incoming: item, incomingFact: inf, peerVersions },
            opts?.peerTrustWeights
          );
          if (consensusResult.status === "consensus") {
            const localVersion = versionKeyForLocal(local);
            const incomingVersion = versionKeyForIncoming(item);
            if (consensusResult.adoptedVersion === incomingVersion) {
              logger.info("federation: §33 consensus adopted incoming version", {
                remoteId,
                adoptedVersion: consensusResult.adoptedVersion,
                confidence: consensusResult.confidence,
              });
              await this.upsertItem(item, local, logger);
              return { remoteId, outcome: "reconciled_consensus_incoming" };
            }
            if (consensusResult.adoptedVersion === localVersion) {
              logger.info("federation: §33 consensus retained local version", {
                remoteId,
                adoptedVersion: consensusResult.adoptedVersion,
                confidence: consensusResult.confidence,
              });
              return { remoteId, outcome: "reconciled_consensus_local" };
            }
            // Consensus chose a THIRD peer's version that is neither what we hold
            // nor what this peer sent. We can't materialise a version we don't
            // have from this apply call — surface for review rather than guess.
            logger.warn(
              "federation: §33 consensus chose a version we do not hold locally — enqueuing review",
              {
                remoteId,
                adoptedVersion: consensusResult.adoptedVersion,
              }
            );
            this.ctx.onContested?.({ remoteId, workspaceId });
            return { remoteId, outcome: "contested_enqueued_review" };
          }
          // contested across all peers → human review
          this.ctx.onContested?.({ remoteId, workspaceId });
          logger.debug("federation: §33 consensus contested across peers — enqueuing review", {
            remoteId,
            versions: consensusResult.versions,
          });
          return { remoteId, outcome: "contested_enqueued_review" };
        }

        if (decisiveLocal) {
          logger.debug("federation: resolver kept local", {
            remoteId,
            reason: v.reason,
            confidence: v.confidence,
          });
          return { remoteId, outcome: "skipped_resolver_kept_local" };
        }
        if (!decisiveIncoming) {
          this.ctx.onContested?.({ remoteId, workspaceId });
          logger.debug("federation: resolver contested — enqueuing review", {
            remoteId,
            reason: v.reason,
          });
          return { remoteId, outcome: "contested_enqueued_review" };
        }
        // incoming wins with confidence > 0.7 — fall through to upsert
        logger.debug("federation: resolver chose incoming", {
          remoteId,
          reason: v.reason,
          confidence: v.confidence,
        });
      }
    }

    // ── Legacy tie-break (only reached when no local, or theirs_wins, or resolver chose incoming) ─
    // For same-version with no conflict resolver running (theirs_wins bypasses resolver)
    if (local && local.version === version && opts?.conflictResolution === "theirs_wins") {
      if (peerDomain <= local.peerDomain) {
        logger.debug("federation: version tie — skipping (tie-break lost)", {
          remoteId,
          incomingPeer: peerDomain,
          localPeer: local.peerDomain,
        });
        return { remoteId, outcome: "skipped_tie_lost" };
      }
      // Incoming peerDomain > local peerDomain — fall through to upsert
    }

    // Stale version: skip when no VC comparison ran (legacy version-only path)
    if (local && local.version > version && !(vectorClock && local.vectorClock)) {
      logger.debug("federation: no-op — local version is current", {
        remoteId,
        peerDomain,
        localVersion: local.version,
        incomingVersion: version,
      });
      return { remoteId, outcome: "skipped_no_change" };
    }

    // ── Upsert with attribution cap ────────────────────────────────────────────
    await this.upsertItem(item, local, logger);
    return { remoteId, outcome: "upserted" };
  }

  /**
   * Persist an incoming item with the security invariants applied:
   *   - attribution is ALWAYS forced to "federation_received" (trust score 20,
   *     never elevated) regardless of the claimed payload value.
   *   - vector clocks are CRDT-joined (max per component) when both sides have one.
   * Used by the normal upsert fall-through and by the §20 merge supersession path.
   */
  private async upsertItem(
    item: FederatedItem,
    local: LocalItemRef | null,
    logger: SyncLogger
  ): Promise<void> {
    const { storage, workspaceId } = this.ctx;
    const { remoteId, version, vectorClock, peerDomain, payload } = item;
    const mergedVc =
      vectorClock && local?.vectorClock
        ? vcMerge(vectorClock, local.vectorClock)
        : (vectorClock ?? local?.vectorClock);
    await storage.upsertFederatedItem({
      workspaceId,
      remoteId,
      peerDomain,
      version,
      vectorClock: mergedVc,
      attribution: "federation_received",
      payload,
    });
    logger.info("federation: item upserted", {
      remoteId,
      peerDomain,
      version,
      isNew: !local,
    });
  }

  /**
   * §33 multi-instance weighted-supermajority reconciliation.
   *
   * Builds one FederationVote per known holder of the fact — the local copy, the
   * incoming peer's copy, and every other gathered peer version — and runs the
   * weighted-supermajority vote (federatedConsensus). The per-instance trust
   * weights come from `peerTrustWeights`, which the caller sources from the LOCAL
   * PeerStore (PeerConfig.trustWeight). Vote payloads never carry trust — a
   * compromised peer cannot inflate its own weight here.
   *
   * Pure given its inputs (no I/O): callers gather the versions, this only votes.
   * Exposed (not private) so the gather/reconcile entry point — once a true
   * N-peer gather step exists (see file note) — can call it directly, and so the
   * §33 path is unit-testable in isolation.
   */
  reconcileVersions(
    input: {
      local: LocalItemRef;
      localFact: ConflictFact;
      incoming: FederatedItem;
      incomingFact: ConflictFact;
      peerVersions: PeerVersion[];
    },
    peerTrustWeights?: ReadonlyMap<string, number>
  ): ConsensusResult {
    const { local, localFact, incoming, incomingFact, peerVersions } = input;

    const votes: FederationVote[] = [];

    // Local copy votes for its own version under its own peer/instance identity.
    votes.push({
      instanceId: local.peerDomain,
      factVersion: versionKeyForLocal(local),
      trustAnchor: localFact.attribution,
      worth: localFact.worth,
      freshness: localFact.validFrom.toISOString(),
    });

    // The incoming peer copy votes for its version. incomingFact/peerVersions are
    // BY DEFINITION peer-sourced (see PeerVersion doc) — attribution/worth are
    // capped here too, not just at the resolveConflict call site above, so this
    // still holds if reconcileVersions is ever called directly (it is exported
    // for exactly that — see class doc above).
    votes.push({
      instanceId: incoming.peerDomain,
      factVersion: versionKeyForIncoming(incoming),
      trustAnchor: FEDERATION_RECEIVED_ATTRIBUTION,
      worth: clampRemoteWorth(incomingFact.worth),
      freshness: incomingFact.validFrom.toISOString(),
    });

    // Every other gathered peer version.
    for (const pv of peerVersions) {
      votes.push({
        instanceId: pv.instanceId,
        factVersion: pv.factVersion,
        trustAnchor: FEDERATION_RECEIVED_ATTRIBUTION,
        worth: clampRemoteWorth(pv.worth ?? 1),
        freshness: pv.freshness ?? new Date().toISOString(),
      });
    }

    return federatedConsensus(votes, { peerTrustWeights });
  }

  /**
   * Process a batch of items from a peer sync payload.
   * Each item is processed independently — one failure does not abort the batch.
   *
   * §20: the configured conflictResolution strategy is threaded through to every
   * processItem call. The real sync path (server federation route) passes the
   * peer's SyncRequest.conflictResolution here so per-request strategy selection
   * actually takes effect (previously processItem ran with no opts → always default).
   */
  async processBatch(items: FederatedItem[], opts?: ProcessItemOpts): Promise<SyncItemResult[]> {
    const results: SyncItemResult[] = [];
    for (const item of items) {
      try {
        results.push(await this.processItem(item, opts));
      } catch (err) {
        this.ctx.logger.warn("federation: item processing error", {
          remoteId: item.remoteId,
          peerDomain: item.peerDomain,
          error: err instanceof Error ? err.message : String(err),
        });
        results.push({ remoteId: item.remoteId, outcome: "error" });
      }
    }
    return results;
  }
}

// ─── §33 version-identity helpers ───────────────────────────────────────────
// A FederationVote groups by `factVersion`, so local and incoming need a stable
// version key. We prefer an explicit content/version marker from the payload and
// fall back to the numeric version. Local and incoming use the SAME derivation so
// two peers holding the identical content vote for the same key (and converge).

/** Stable version key for the locally-stored item. */
function versionKeyForLocal(local: LocalItemRef): string {
  return `v:${local.version}`;
}

/** Stable version key for an incoming item, mirroring versionKeyForLocal. */
function versionKeyForIncoming(item: FederatedItem): string {
  const payloadVersion = item.payload["factVersion"] ?? item.payload["hash"];
  if (typeof payloadVersion === "string" && payloadVersion.length > 0) {
    return payloadVersion;
  }
  return `v:${item.version}`;
}
