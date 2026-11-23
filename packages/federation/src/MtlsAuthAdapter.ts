// Federation mTLS auth adapter with key-continuity rotation (TASK-13002).
// SECURITY.md §11, PLUGINS_AND_FEDERATION.md §13.4, AUDIT_REPORT.md FED-04.
//
// Trust model:
//  - Each peer has a pinned public key (DER-encoded certificate) stored in local config.
//  - Incoming TLS client certificate is verified against the pinned key.
//  - Key rotation requires cross-signature proof OR explicit operator approval.
//
// CRITICAL: NEVER silently update the pinned key from an unauthenticated ANNOUNCE.
// A compromised peer could send an ANNOUNCE with a new key to hijack the channel.
// Only two safe rotation paths:
//   1. Incoming ANNOUNCE is signed by the current pinned key (cross-signature proof)
//   2. Operator explicitly approves via POST /memory/federation/peers/:id/approve-key
//
// Note: This adapter handles key validation logic only. The actual TLS termination
// is done by the Node.js HTTPS server or reverse proxy (e.g., nginx) — this code
// receives the peer certificate as bytes after TLS handshake.

import { createVerify, createPublicKey } from "node:crypto";
import { constantTimeEqual } from "./constantTimeEqual.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PeerConfig {
  /** Peer identifier (domain or UUID). */
  peerId: string;
  /** DER-encoded pinned certificate. */
  pinnedCertDer: Uint8Array;
  /** Trust weight 0–1 for voting (from LOCAL config — never from peer payload). */
  trustWeight: number;
  /** ISO timestamp when this key was approved. */
  approvedAt: string;
  /** Whether this peer is currently allowed to sync. */
  enabled: boolean;
  /** Base URL of this peer's Mnemosyne server (e.g. "https://peer.example.com"). */
  url?: string;
  /** Bearer API key to authenticate pull requests to this peer's /memory/federation/items endpoint. */
  apiKey?: string;
  /**
   * P0-1 app-layer crypto (§20): this peer's Ed25519 signing PUBLIC key, used to
   * verify the signature on items it serves us. Config-provided (PEM or base64-DER)
   * — peers are config, so this needs no DB migration. When set together with
   * `symmetricKey`, the pull path ENFORCES verify+decrypt; when absent the pull
   * path falls back to plaintext with a logged warning (backward compat).
   */
  signingPublicKey?: string;
  /**
   * P0-1 app-layer crypto (§20): shared/derived 32-byte symmetric key (base64) used
   * to seal/open item payloads exchanged with this peer (AES-256-GCM). Config-provided.
   */
  symmetricKey?: string;
}

export interface PeerStore {
  get(peerId: string): Promise<PeerConfig | null>;
  /**
   * Provision a new peer. Only the operator path calls this
   * (POST /memory/federation/peers, federation:admin). Resolves false and
   * changes nothing when the peerId already exists.
   */
  addPeer(peer: PeerConfig): Promise<boolean>;
  upsertPinnedCert(peerId: string, certDer: Uint8Array, approvedAt: string): Promise<void>;
  list(): Promise<PeerConfig[]>;
  deletePeer(id: string): Promise<void>;
}

export interface MtlsAuthResult {
  authenticated: boolean;
  peerId?: string;
  trustWeight?: number;
  reason?: string;
}

export interface AnnouncePayload {
  peerId: string;
  /** The new DER-encoded certificate being announced. */
  newCertDer: Uint8Array;
  /** Signature of SHA-256(peerId + newCertDer) using the CURRENT pinned key. */
  crossSignature?: Uint8Array;
  /** ISO timestamp of announcement. */
  issuedAt: string;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class MtlsAuthAdapter {
  constructor(private readonly peers: PeerStore) {}

  /**
   * @deprecated Superseded by
   * `packages/server/src/federation/authenticateFederationRequest.ts`, which is
   * the live incoming-request path (wired through `gateFederationRequest()` in
   * routes/federation.ts for /items, /sync and /resolve) and additionally
   * enforces the mk_fed_ key binding, TLS >= 1.3, service-JWT verification with
   * replay dedup, and workspace_scope. This method checks only the cert pin and
   * has no caller in packages/server. Retained because `processAnnounce()` /
   * `approveKeyRotation()` on this class ARE live (peer approve routes). Do not
   * wire it into new code.
   */
  async authenticate(peerId: string, clientCertDer: Uint8Array): Promise<MtlsAuthResult> {
    const peer = await this.peers.get(peerId);
    if (!peer) {
      return { authenticated: false, reason: "unknown_peer" };
    }
    if (!peer.enabled) {
      return { authenticated: false, reason: "peer_disabled" };
    }

    const matches = constantTimeEqual(peer.pinnedCertDer, clientCertDer);
    if (!matches) {
      return { authenticated: false, reason: "cert_mismatch" };
    }

    return {
      authenticated: true,
      peerId: peer.peerId,
      trustWeight: peer.trustWeight,
    };
  }

  /**
   * Process a key rotation ANNOUNCE from a peer.
   *
   * Rotation is accepted ONLY if:
   *   1. The announce carries a valid cross-signature using the current pinned key, OR
   *   2. An operator has pre-approved the key via approveKeyRotation()
   *
   * Never silently accept an unauthenticated ANNOUNCE (FED-04).
   */
  async processAnnounce(
    announce: AnnouncePayload,
    preApproved = false
  ): Promise<{ accepted: boolean; reason: string }> {
    const peer = await this.peers.get(announce.peerId);
    if (!peer) {
      return { accepted: false, reason: "unknown_peer" };
    }
    if (!peer.enabled) {
      return { accepted: false, reason: "peer_disabled" };
    }

    // Path 2: Operator pre-approval
    if (preApproved) {
      await this.peers.upsertPinnedCert(announce.peerId, announce.newCertDer, announce.issuedAt);
      return { accepted: true, reason: "operator_approved" };
    }

    // Path 1: Cross-signature proof using current pinned key
    if (!announce.crossSignature || announce.crossSignature.length === 0) {
      return { accepted: false, reason: "missing_cross_signature" };
    }

    const signatureValid = verifyCrossSignature(
      peer.pinnedCertDer,
      announce.peerId,
      announce.newCertDer,
      announce.crossSignature
    );

    if (!signatureValid) {
      return { accepted: false, reason: "invalid_cross_signature" };
    }

    await this.peers.upsertPinnedCert(announce.peerId, announce.newCertDer, announce.issuedAt);
    return { accepted: true, reason: "cross_signature_verified" };
  }

  /**
   * Explicit operator approval of a pending key rotation.
   * Call this from the POST /memory/federation/peers/:id/approve-key route handler.
   */
  async approveKeyRotation(
    peerId: string,
    newCertDer: Uint8Array,
    approvedAt: string
  ): Promise<void> {
    await this.peers.upsertPinnedCert(peerId, newCertDer, approvedAt);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Verify that `crossSignature` is SHA-256WithRSAEncryption or ECDSA signature
 * of `SHA-256(peerId || newCertDer)` using the current pinned certificate's public key.
 */
function verifyCrossSignature(
  pinnedCertDer: Uint8Array,
  peerId: string,
  newCertDer: Uint8Array,
  crossSignature: Uint8Array
): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(pinnedCertDer),
      format: "der",
      type: "spki",
    });
    const verifier = createVerify("SHA256");
    verifier.update(Buffer.from(peerId, "utf8"));
    verifier.update(Buffer.from(newCertDer));
    return verifier.verify(publicKey, Buffer.from(crossSignature));
  } catch {
    return false;
  }
}
