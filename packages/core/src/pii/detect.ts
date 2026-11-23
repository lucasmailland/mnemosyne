// packages/mnemosyne/src/pii/detect.ts
//
// PII detection regex layer. NER + LLM layers are optional add-ons
// (Phase 5.2 / Phase 5.3 in spec).

import { PII_SEVERITY, type PIICategory } from "./patterns";
import { scanPII } from "./redact";
import { detectNER, NER_SEVERITY } from "./ner.js";

export interface PIIDetectionResult {
  detected: boolean;
  categories: PIICategory[];
  risk_score: number; // 0..1
  matches: Array<{ category: PIICategory; match: string }>;
}

export function detectPII(text: string): PIIDetectionResult {
  // SEC-8: the same pass redaction runs, so detection and redaction can never
  // disagree about what is PII (validators, severity order, parked matches).
  const { categories, matches } = scanPII(text);
  const maxScore = categories.reduce((max, cat) => Math.max(max, PII_SEVERITY[cat]), 0);
  return {
    detected: matches.length > 0,
    categories,
    risk_score: maxScore,
    matches,
  };
}

export function detectPIIWithNER(text: string): PIIDetectionResult {
  const base = detectPII(text);
  const nerMatches = detectNER(text);

  const categories = new Set(base.categories);
  const allMatches = [...base.matches];
  let maxScore = base.risk_score;

  for (const m of nerMatches) {
    allMatches.push({ category: m.category as PIICategory, match: m.match });
    categories.add(m.category as PIICategory);
    maxScore = Math.max(maxScore, NER_SEVERITY[m.category]);
  }

  return {
    detected: allMatches.length > 0,
    categories: Array.from(categories),
    risk_score: maxScore,
    matches: allMatches,
  };
}
