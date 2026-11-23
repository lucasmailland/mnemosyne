// LLM-powered PII detection (Phase 5.3).
// Optional — requires an LLM adapter. Falls back gracefully on error.

import type { PIIDetectionResult } from "./detect.js";
import type { PIICategory } from "./patterns.js";
import { parseJsonReply } from "../llm/parse-json-reply.js";

export interface PIILLMAdapter {
  generate(prompt: string): Promise<{ content: string }>;
}

const DETECTION_PROMPT = (text: string) =>
  `Analyze the following text for personally identifiable information (PII).

Text: """${text.slice(0, 4000)}"""

Respond with a JSON array of detected PII items. Each item must have:
- "category": one of "person_name", "email", "phone", "ssn", "credit_card", "passport_number", "date_of_birth", "street_address", "api_key", "ip_address"
- "match": the verbatim text that is PII
- "risk_score": number 0.0–1.0

If no PII found, respond with: []
Respond ONLY with valid JSON. No explanation.`;

export async function detectPIIWithLLM(
  text: string,
  llm: PIILLMAdapter
): Promise<PIIDetectionResult> {
  try {
    const response = await llm.generate(DETECTION_PROMPT(text));
    // P124: a fenced reply here means the LLM PII layer detects nothing.
    const parsed = parseJsonReply<
      Array<{
        category: string;
        match: string;
        risk_score?: number;
      }>
    >(response.content, "pii.detect");

    const matches = parsed
      .filter((item) => item.category && item.match)
      .map((item) => ({ category: item.category as PIICategory, match: item.match }));

    const categories = [...new Set(matches.map((m) => m.category))];
    const risk_score = parsed.reduce(
      (max, item) => Math.max(max, typeof item.risk_score === "number" ? item.risk_score : 0),
      0
    );

    return { detected: matches.length > 0, categories, risk_score, matches };
  } catch {
    // LLM errors degrade gracefully — never block the calling code
    return { detected: false, categories: [], risk_score: 0, matches: [] };
  }
}
