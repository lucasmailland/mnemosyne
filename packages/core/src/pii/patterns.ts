// packages/mnemosyne/src/pii/patterns.ts
//
// Regex patterns for common PII categories. Conservative — prefer
// false negatives over false positives (downstream LLM layer can
// catch high-confidence cases).

export type PIICategory =
  "email" | "phone" | "credit_card" | "ssn" | "api_key" | "ip_address" | "url_with_token";

export const PII_PATTERNS: Record<PIICategory, RegExp> = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  // P119. The previous pattern was
  //   /(?:\+?\d{1,3}[\s-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/
  // whose separators were all OPTIONAL, so it matched any run of 10+ digits:
  // millisecond timestamps, order ids, invoice numbers, counts. It broke this
  // file's own stated policy in the worst direction — redaction happens at
  // WRITE time (`remember()` reassigns the content before embedding and before
  // insert), so a false positive is irreversible: the original number is not
  // stored anywhere.
  //
  // And it failed in BOTH directions: `+54 911 2345 6789` — a real phone in the
  // format most of the world writes — did NOT match, because the pattern is a
  // North-American 3-3-4 shape wearing an optional country code.
  //
  // Three alternatives, each requiring a signal a bare number cannot fake:
  //   1. An explicit `+` followed by 7–14 more digits. Nothing else in a
  //      sentence carries a leading plus; this is what recovers international
  //      numbers.
  //   2. NANP 3-3-4 with MANDATORY separators. `4155550132` is now ignored;
  //      `415-555-0132` is not.
  //   3. 2-4 / 4 / 4 with mandatory separators, for `011 4321 1234` and the
  //      many locales that group that way.
  // Deliberately NOT matched: bare digit runs of any length. Recovering those
  // would need lexical context ("tel:", "cel:"), which is a separate decision
  // and is what the downstream LLM layer is for.
  phone: new RegExp(
    [
      String.raw`\+\d{1,3}(?:[\s.-]?\d){6,13}`,
      String.raw`\b\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b`,
      String.raw`\b\d{2,4}[\s.-]\d{4}[\s.-]\d{4}\b`,
    ].join("|")
  ),
  credit_card: /\b(?:\d{4}[\s-]?){3}\d{4}\b/,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/,
  api_key: /\b(?:sk-|pk_|api[_-]?key[=:\s]+|Bearer\s+)[A-Za-z0-9_-]{20,}/,
  ip_address: /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  url_with_token: /https?:\/\/[^\s]+[?&](?:token|access_token|api_key|key)=[^\s&]+/,
};

/**
 * SEC-8 — the residue of P119. A regex sees shape only, and three shapes are
 * shared with ordinary structured data the eval measured being destroyed:
 * a 16-digit ledger batch read as a card, `release 3.12.1.4` as an IP, and
 * `part 555-12-3456` as an SSN. Redaction is a write, so each of those lost the
 * original for good.
 *
 * A validator runs on each match the pattern finds, with the text around it,
 * and returns false when the match is NOT PII. It decides what the shape
 * cannot: the card checksum, octet ranges, SSN structure, and an explicit label
 * in front for the shapes that stay ambiguous. Every unlabelled, structurally
 * valid match is still redacted — the conservative default is unchanged.
 */
export type PIIValidator = (match: string, before: string, after: string) => boolean;

/** "part 555-12-3456", "SKU: …", "invoice #…" — an identifier, not a person. */
const IDENTIFIER_LABEL =
  /\b(?:part|p\/n|pn|sku|model|item|order|invoice|ticket|ref|reference|batch|lot|serial|s\/n)\.?\s*(?:no\.?|number|#)?\s*[:#]?\s*$/i;
/** "release 3.12.1.4", "version 10.0.0.1", "build 4.2.0.17" — a version. */
const VERSION_LABEL = /\b(?:version|ver|release|rel|build|firmware|fw)\.?\s*[:#]?\s*$/i;

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export const PII_VALIDATORS: Partial<Record<PIICategory, PIIValidator>> = {
  // Every issued card number passes Luhn; an arbitrary 16-digit id fails it
  // nine times out of ten.
  credit_card: (match) => luhnValid(match.replace(/\D/g, "")),
  // SSA never issues area 000, 666 or 900-999, group 00 or serial 0000.
  ssn: (match, before) => {
    const [area, group, serial] = match.split("-");
    if (area === "000" || area === "666" || area!.startsWith("9")) return false;
    if (group === "00" || serial === "0000") return false;
    return !IDENTIFIER_LABEL.test(before);
  },
  ip_address: (match, before, after) => {
    if (match.split(".").some((octet) => Number(octet) > 255)) return false;
    // Part of a longer dotted run (1.2.3.4.5): a version, not an address.
    if (/\d\.$/.test(before) || /^\.\d/.test(after)) return false;
    return !VERSION_LABEL.test(before);
  },
};

export const PII_SEVERITY: Record<PIICategory, number> = {
  api_key: 1.0,
  credit_card: 0.95,
  ssn: 0.95,
  email: 0.5,
  phone: 0.55,
  ip_address: 0.3,
  url_with_token: 0.85,
};
