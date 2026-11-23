export { FederationMesh } from "./mesh.js";
export type { AnnounceMessage, MeshPeer } from "./mesh.js";
export {
  signPayload,
  verifyPayload,
  sealItem,
  openItem,
  parseEd25519PrivateKey,
  parseEd25519PublicKey,
  parseSymmetricKey,
} from "./crypto.js";
export type { SealedItem } from "./crypto.js";
export {
  buildSecureItemsEnvelope,
  openSecureItemsEnvelope,
  canonicalizeSealedItems,
  isSecureEnvelope,
  FederationVerifyError,
  FederationDecryptError,
  FEDERATION_ENVELOPE_ALG,
} from "./secureEnvelope.js";
export type {
  SealedFederatedItem,
  SecureItemsEnvelope,
  ServeCryptoKeys,
  PullCryptoKeys,
} from "./secureEnvelope.js";
export { filterByScope, nextCursor, projectForPeer } from "./syncProtocol.js";
export type {
  SyncRequest,
  SyncableRecord,
  SyncPayload,
  FactForPeer,
  FactMetadata,
} from "./syncProtocol.js";
export { SyncEngine } from "./SyncEngine.js";
export type {
  FederatedItem,
  LocalItemRef,
  SyncStorage,
  SyncLogger,
  SyncEngineContext,
  SyncOutcome,
  SyncItemResult,
  ConflictResolution,
  ProcessItemOpts,
} from "./SyncEngine.js";
export { MtlsAuthAdapter } from "./MtlsAuthAdapter.js";
export type { PeerConfig, PeerStore, MtlsAuthResult, AnnouncePayload } from "./MtlsAuthAdapter.js";
export { InMemoryPeerStore } from "./InMemoryPeerStore.js";
export { InMemorySyncStorage } from "./InMemorySyncStorage.js";
export { pullFromPeer } from "./PullClient.js";
export type { PullOptions, PullResult, PullLogger, PullTls } from "./PullClient.js";
export { TRUST_ANCHORS, baseWeightFor, effectiveWeight } from "./trust.js";
export { resolveConsensus } from "./consensus.js";
export type { FederationClaim, ConsensusOutcome, ConsensusOpts } from "./consensus.js";
export { resolveConflict } from "./resolveConflict.js";
export type { ConflictFact, ConflictVerdict } from "./resolveConflict.js";
export { ATTRIBUTION_TRUST_MAP, trustScoreForAttribution } from "./trust.js";
export { federatedConsensus } from "./federatedConsensus.js";
export type {
  FederationVote,
  ConsensusResult,
  FederatedConsensusOpts,
} from "./federatedConsensus.js";
export { assertFederationBinding } from "./binding.js";
export type { FederationBindingInput, FederationBindingResult } from "./binding.js";
export { constantTimeEqual } from "./constantTimeEqual.js";
