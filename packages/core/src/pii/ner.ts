// NER-style PII detection (Phase 5.2).
// Linguistic heuristics — conservative (prefers false negatives).

export type NERCategory =
  | "person_name"
  | "street_address"
  | "passport_number"
  | "date_of_birth";

const NER_PATTERNS: Record<NERCategory, RegExp> = {
  // "Mr. John Smith", "Dr. Jane Doe", "John Smith" in typical contexts
  person_name:
    /(?:(?:Mr|Mrs|Ms|Miss|Dr|Prof|Rev|Capt|Lt|Col|Sgt)\.?\s+)?[A-Z][a-z]{1,20}\s+[A-Z][a-z]{1,20}/,
  // "123 Main St", "456 Broadway Ave"
  street_address:
    /\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St|Ave|Blvd|Dr|Rd|Ln|Way|Ct|Pl)\b\.?/i,
  // Passport-style: one or two letters + 7-9 digits
  passport_number: /\b[A-Z]{1,2}\d{7,9}\b/,
  // "born on 01/05/1990", "DOB: 1990-05-01", "date of birth: May 1 1990"
  date_of_birth:
    /(?:born\s+(?:on\s+)?|dob[:\s]+|date\s+of\s+birth[:\s]+)\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/i,
};

export const NER_SEVERITY: Record<NERCategory, number> = {
  person_name: 0.6,
  street_address: 0.7,
  passport_number: 0.95,
  date_of_birth: 0.85,
};

export interface NERMatch {
  category: NERCategory;
  match: string;
}

export function detectNER(text: string): NERMatch[] {
  const matches: NERMatch[] = [];
  for (const [cat, re] of Object.entries(NER_PATTERNS) as Array<[NERCategory, RegExp]>) {
    const m = text.match(re);
    if (m) {
      matches.push({ category: cat, match: m[0] });
    }
  }
  return matches;
}
