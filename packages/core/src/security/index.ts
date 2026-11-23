// Wave X — Security module barrel.
// Exports all active-security-detection primitives.

export { scoreInjection, DEFAULT_INJECTION_THRESHOLD } from "./injection.js";
export type { InjectionScore } from "@mnemo-ai/types";
export { scoreAnomaly, DEFAULT_ANOMALY_THRESHOLD, type AnomalyInput } from "./anomaly.js";
export {
  wrapCacheValue,
  unwrapCacheValue,
  CachePoisoningError,
  type TaggedCacheValue,
} from "./cache-tag.js";
export { ipInCidr, ipToBig } from "./cidr.js";
export { deviceFingerprint, hashToken, decideRefresh } from "./session-token.js";
export { workspaceAclUsername, workspaceAclRule } from "./redis-acl.js";

// Wave T2 — Auth hardening
export { detectKeyAnomaly } from "./key-anomaly.js";
export type {
  AnomalyInput as KeyAnomalyInput,
  AnomalyResult as KeyAnomalyResult,
  AnomalyReason as KeyAnomalyReason,
} from "./key-anomaly.js";
export { generateTotp, generateTotpSecret, verifyTotp } from "./totp.js";

// Wave T3 — Encryption at rest
export { addEmbeddingNoise } from "./embedding-noise.js";
export type { EmbeddingNoiseConfig, EmbeddingNoiseMode } from "./embedding-noise.js";
