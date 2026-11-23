// §33 multi-instance weighted-consensus integration into the SyncEngine apply path.
//
// Proves federatedConsensus is now REACHABLE from SyncEngine:
//   1. directly via SyncEngine.reconcileVersions() (the gather/vote entry point), and
//   2. end-to-end through processItem() when a fact has versions from MULTIPLE peers
//      (opts.knownPeerVersions) and the pairwise resolveConflict is not decisive.
//
// It also pins the two non-regression invariants:
//   - the pairwise resolveConflict path is unchanged when no multi-peer votes are
//     supplied (single-peer / fallback behaviour preserved), and
//   - trust weights come from the LOCAL map passed by the caller, never the payload.

import { describe, it, expect, vi } from "vitest";
import {
  SyncEngine,
  type FederatedItem,
  type LocalItemRef,
  type PeerVersion,
  type SyncEngineContext,
  type SyncLogger,
  type SyncStorage,
} from "../SyncEngine.js";
import type { ConflictFact } from "../resolveConflict.js";

const WS = "ws-1";
const NOW = new Date("2026-01-15T00:00:00Z").toISOString();

function silentLogger(): SyncLogger {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

/**
 * Minimal SyncStorage stub. Only the methods processItem touches are wired; a
 * pre-seeded `local` is returned from findByRemoteId so the resolver path runs.
 */
function makeStorage(local: LocalItemRef | null): {
  storage: SyncStorage;
  upserts: Array<{ remoteId: string; version: number }>;
} {
  const upserts: Array<{ remoteId: string; version: number }> = [];
  const storage: SyncStorage = {
    async findByRemoteId() {
      return local;
    },
    async isInDeletionLog() {
      return false;
    },
    async upsertFederatedItem(opts) {
      upserts.push({ remoteId: opts.remoteId, version: opts.version });
      return { localId: "local-1" };
    },
    async archiveLocalItem() {},
    async insertDeletionLog() {},
  };
  return { storage, upserts };
}

function localRef(over: Partial<LocalItemRef> = {}): LocalItemRef {
  return {
    localId: "local-1",
    remoteId: "fact-1",
    version: 1,
    workspaceId: WS,
    peerDomain: "peer-local",
    attribution: "agent_inferred", // tie with incoming so the pairwise verdict is NOT decisive
    worth: 1,
    validFrom: NOW,
    ...over,
  };
}

function incoming(over: Partial<FederatedItem> = {}): FederatedItem {
  return {
    remoteId: "fact-1",
    version: 1,
    peerDomain: "peer-b",
    payload: { attribution: "agent_inferred", worth: 1, validFrom: NOW, factVersion: "vB" },
    ...over,
  };
}

describe("SyncEngine §33 — federatedConsensus reachable from the apply path", () => {
  it("reconcileVersions() runs the weighted-supermajority vote over local + incoming + peer versions", () => {
    const ctx: SyncEngineContext = {
      storage: makeStorage(localRef()).storage,
      logger: silentLogger(),
      workspaceId: WS,
    };
    const engine = new SyncEngine(ctx);

    const local = localRef();
    const localFact: ConflictFact = {
      attribution: "agent_inferred",
      worth: 1,
      validFrom: new Date(NOW),
    };
    const incomingFact: ConflictFact = {
      attribution: "agent_inferred",
      worth: 1,
      validFrom: new Date(NOW),
    };

    // Two further peers also hold "vB" → 3 of 4 instances vote vB → supermajority.
    // attribution on peerVersions/incomingFact is illustrative only — reconcileVersions
    // always caps peer-sourced attribution to federation_received (S7), so what
    // actually decides the vote here is the LOCAL peerTrustWeights map below, not
    // the "user_stated" claims. Weighted up (3x) so 3 federation_received (20)
    // votes still clear the supermajority bar against local's real attribution (40).
    const peerVersions: PeerVersion[] = [
      { instanceId: "peer-c", factVersion: "vB", attribution: "user_stated", freshness: NOW },
      { instanceId: "peer-d", factVersion: "vB", attribution: "user_stated", freshness: NOW },
    ];

    const result = engine.reconcileVersions(
      { local, localFact, incoming: incoming(), incomingFact, peerVersions },
      new Map([
        ["peer-local", 1],
        ["peer-b", 3],
        ["peer-c", 3],
        ["peer-d", 3],
      ])
    );

    expect(result.status).toBe("consensus");
    if (result.status === "consensus") {
      expect(result.adoptedVersion).toBe("vB");
      expect(result.confidence).toBeGreaterThan(0.66);
    }
  });

  it("processItem() escalates to §33 consensus and upserts the incoming version when peers agree", async () => {
    const { storage, upserts } = makeStorage(localRef());
    const onContested = vi.fn();
    const engine = new SyncEngine({
      storage,
      logger: silentLogger(),
      workspaceId: WS,
      onContested,
    });

    const res = await engine.processItem(incoming(), {
      knownPeerVersions: [
        { instanceId: "peer-c", factVersion: "vB", attribution: "user_stated", freshness: NOW },
        { instanceId: "peer-d", factVersion: "vB", attribution: "user_stated", freshness: NOW },
      ],
      // Weighted up (3x) — see comment on the reconcileVersions() test above: the
      // "user_stated" claims are always capped to federation_received, so the
      // supermajority here comes from LOCAL trust config, not the peers' claims.
      peerTrustWeights: new Map([
        ["peer-local", 1],
        ["peer-b", 3],
        ["peer-c", 3],
        ["peer-d", 3],
      ]),
    });

    expect(res.outcome).toBe("reconciled_consensus_incoming");
    expect(upserts).toHaveLength(1);
    expect(onContested).not.toHaveBeenCalled();
  });

  it("processItem() retains the local version when the supermajority backs local", async () => {
    // Local holds version 1 → key "v:1"; make 3 of 4 instances vote that key.
    const { storage, upserts } = makeStorage(localRef());
    const onContested = vi.fn();
    const engine = new SyncEngine({
      storage,
      logger: silentLogger(),
      workspaceId: WS,
      onContested,
    });

    const res = await engine.processItem(incoming(), {
      knownPeerVersions: [
        { instanceId: "peer-c", factVersion: "v:1", attribution: "user_stated", freshness: NOW },
        { instanceId: "peer-d", factVersion: "v:1", attribution: "user_stated", freshness: NOW },
      ],
      peerTrustWeights: new Map([
        ["peer-local", 1],
        ["peer-b", 1],
        ["peer-c", 1],
        ["peer-d", 1],
      ]),
    });

    expect(res.outcome).toBe("reconciled_consensus_local");
    expect(upserts).toHaveLength(0);
  });

  it("processItem() enqueues review when peers are split (no supermajority)", async () => {
    const { storage } = makeStorage(localRef());
    const onContested = vi.fn();
    const engine = new SyncEngine({
      storage,
      logger: silentLogger(),
      workspaceId: WS,
      onContested,
    });

    const res = await engine.processItem(incoming(), {
      knownPeerVersions: [
        { instanceId: "peer-c", factVersion: "vC", attribution: "user_stated", freshness: NOW },
      ],
      peerTrustWeights: new Map([
        ["peer-local", 1],
        ["peer-b", 1],
        ["peer-c", 1],
      ]),
    });

    // local→v:1, incoming→vB, peer-c→vC : 3-way split, no version > 66%.
    expect(res.outcome).toBe("contested_enqueued_review");
    expect(onContested).toHaveBeenCalledOnce();
  });

  it("local PeerStore trust weights (not payload) drive the vote — a heavy local peer flips the outcome", async () => {
    // Two peers vote vB, but the LOCAL trust weight for peer-b dwarfs them, so the
    // single incoming vB-holder's weight alone clears the bar. Proves the weight
    // is read from the caller's map, not the vote payload.
    const { storage, upserts } = makeStorage(localRef());
    const engine = new SyncEngine({
      storage,
      logger: silentLogger(),
      workspaceId: WS,
      onContested: vi.fn(),
    });

    const res = await engine.processItem(incoming(), {
      knownPeerVersions: [
        { instanceId: "peer-c", factVersion: "v:1", attribution: "user_stated", freshness: NOW },
      ],
      peerTrustWeights: new Map([
        ["peer-local", 0.01],
        ["peer-b", 100],
        ["peer-c", 0.01],
      ]),
    });

    expect(res.outcome).toBe("reconciled_consensus_incoming");
    expect(upserts).toHaveLength(1);
  });

  it("NON-REGRESSION + SECURITY: with no knownPeerVersions, the pairwise resolveConflict path is used, and a spoofed 'user_stated' claim from the peer does NOT win — local (real attribution) is kept", async () => {
    // Before the S7 fix, incoming's self-claimed attribution ("user_stated", 90)
    // would decisively beat local's real "agent_inferred" (40). Now incoming is
    // always scored at federation_received (20), so local decisively wins instead —
    // no consensus escalation needed since resolveConflict alone is decisive.
    const { storage, upserts } = makeStorage(localRef({ attribution: "agent_inferred" }));
    const onContested = vi.fn();
    const engine = new SyncEngine({
      storage,
      logger: silentLogger(),
      workspaceId: WS,
      onContested,
    });

    const res = await engine.processItem(
      incoming({ payload: { attribution: "user_stated", worth: 1, validFrom: NOW } }),
      {} // no knownPeerVersions
    );

    expect(res.outcome).toBe("skipped_resolver_kept_local");
    expect(upserts).toHaveLength(0);
    expect(onContested).not.toHaveBeenCalled();
  });
});
