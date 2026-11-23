/**
 * §3 / §22 — canonical operational error-code registry (spec lines 1965–1974).
 *
 * These `MNEMO_0NN` codes are DEGRADATION/operational signals, distinct from the
 * HttpError snake_case `code` (which is the stable client-facing contract). They
 * are surfaced to clients in the error body's `details.code` and logged at the
 * operational site so dashboards + runbooks can branch on a stable identifier.
 * This module is the single source of truth — every degradation path imports it.
 */
import { ServiceUnavailableError, type HttpError } from "./errors.js";

export const MNEMO_CODES = {
  MNEMO_001: "Redis connection failed — degrading to in-memory",
  MNEMO_002: "PG pool exhausted — shedding low-priority jobs",
  MNEMO_003: "Embedding provider timeout — falling back to FTS-only",
  MNEMO_004: "Session collapse LLM failed — session preserved for retry",
  MNEMO_005: "Federation peer unreachable — sync deferred",
  MNEMO_006: "Worth propagation cycle detected — breaking at depth 5",
  MNEMO_007: "Consolidation rollback triggered — recall quality degraded",
  MNEMO_008: "Merkle chain verification failed — audit integrity alert",
  MNEMO_009: "Hot tier Redis full — evicting by LRU activation",
  MNEMO_010: "Plugin execution timeout — plugin disabled",
} as const;

export type MnemoCode = keyof typeof MNEMO_CODES;

/** Human-readable canonical message for an operational code. */
export function mnemoMessage(code: MnemoCode): string {
  return MNEMO_CODES[code];
}

/**
 * Build a 503 carrying the operational code in `details.code` (per the spec's
 * `code?: "MNEMO_001"` error shape). Use at degradation sites that surface an
 * HTTP error (e.g. Redis unavailable). `message` defaults to the canonical text.
 */
export function mnemoDegraded(
  code: MnemoCode,
  message?: string,
  extra?: Record<string, unknown>,
): HttpError {
  return new ServiceUnavailableError(message ?? MNEMO_CODES[code], {
    code,
    reason: MNEMO_CODES[code],
    ...(extra ?? {}),
  });
}
