// Write-time ingest safety gate (CORE-1, SEC-2). PURE MODULE — no host imports.
//
// Every path that writes memory-bearing text runs this before the text reaches
// the embed provider or the database. It used to live inline in
// cognitive/remember.ts, so POST /import — a write path for the same rows —
// stored injection payloads and raw PII that remember() refuses (SEC-2).
//
// Order matters: the poisoning scan runs on the ORIGINAL text, before PII
// redaction, since a delimiter-injection payload that gets PII-redacted is
// still a delimiter injection. Poisoning is a hard reject; PII is
// redacted-and-stored.

import { scanForPoisoning } from "./poisoning/detect.js";
import { PoisoningRejectedError } from "./poisoning/error.js";
import { redactPIIWithCategories } from "./pii/redact.js";
import type { PIICategory } from "./pii/patterns.js";

export interface IngestSafetyResult {
  /** The text to store: PII redacted, otherwise the input unchanged. */
  content: string;
  /** The PII categories that were redacted; empty when nothing changed. */
  piiCategories: PIICategory[];
}

/** @throws PoisoningRejectedError when the text fails the poisoning gate. */
export function applyIngestSafety(text: string): IngestSafetyResult {
  const poisonScan = scanForPoisoning(text);
  if (!poisonScan.ok) {
    throw new PoisoningRejectedError(poisonScan);
  }
  const pii = redactPIIWithCategories(text);
  return { content: pii.redacted, piiCategories: pii.categories };
}

/**
 * The `metadata.pii` marker a redacted row carries. Categories only — never
 * the redacted text.
 */
export function piiMetadata(categories: readonly PIICategory[]): {
  categories: PIICategory[];
  detected_at: string;
} {
  return { categories: [...categories], detected_at: new Date().toISOString() };
}
