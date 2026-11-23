/**
 * SEC-8 — the P119 residue: separator-shaped patterns that redact structured
 * non-PII, irreversibly.
 *
 * Redaction happens at WRITE time (remember() rewrites the content before the
 * embed call and the INSERT), so a false positive destroys the original. P119
 * fixed bare digit runs being read as phones; the eval then measured three
 * shapes that still mis-fire:
 *
 *   ledger batch 2026101712345678 → [REDACTED-credit_card]  (fails Luhn)
 *   release 3.12.1.4              → [REDACTED-ip_address]   (a version)
 *   part 555-12-3456              → [REDACTED-ssn]          (a part number)
 *
 * The fix validates what a shape cannot: the card checksum, octet ranges and
 * SSN structure, plus an explicit label in front ("release", "part", …) for
 * the shapes that stay ambiguous. Real cards, SSNs and IPs must still go.
 */
import { describe, it, expect } from "vitest";
import { redactPIIWithCategories } from "../redact.js";
import { detectPII } from "../detect.js";

function redacts(text: string): boolean {
  return redactPIIWithCategories(text).redacted !== text;
}

describe("SEC-8 — structured non-PII is no longer redacted", () => {
  for (const [label, text] of [
    ["a 16-digit ledger batch that fails Luhn", "ledger batch 2026101712345678"],
    ["a spaced 16-digit reference that fails Luhn", "ref 2026 1017 1234 5678 closed"],
    ["a four-part release number", "upgraded to release 3.12.1.4 yesterday"],
    ["a version label", "pinned version 10.0.0.1 of the chart"],
    ["a build label", "build 4.2.0.17 is green"],
    ["a dotted quad with an octet over 255", "sequence 300.12.1.4 replayed"],
    ["a five-part dotted version", "firmware 1.2.3.4.5 shipped"],
    ["a labelled part number", "part 555-12-3456 is back in stock"],
    ["a labelled SKU", "SKU: 555-12-3456"],
    ["an SSN shape with an impossible area (000)", "code 000-12-3456"],
    ["an SSN shape with an impossible area (9xx)", "case 912-34-5678 reopened"],
  ] as const) {
    it(`leaves ${label} intact`, () => {
      expect(redactPIIWithCategories(text).redacted).toBe(text);
      expect(detectPII(text).detected).toBe(false);
    });
  }
});

describe("SEC-8 — real PII of the same shapes is still redacted", () => {
  for (const [label, text, category] of [
    ["a Luhn-valid card, bare", "card 4111111111111111 on file", "credit_card"],
    ["a Luhn-valid card, spaced", "tarjeta 5555 5555 5555 4444", "credit_card"],
    ["a Luhn-valid card, dashed", "use 4111-1111-1111-1111 for the test", "credit_card"],
    ["an SSN", "ssn 123-45-6789", "ssn"],
    ["an unlabelled SSN", "his number is 123-45-6789 per HR", "ssn"],
    ["a private IP", "the db listens on 10.0.0.12", "ip_address"],
    ["a public IP", "blocked 203.0.113.7 at the edge", "ip_address"],
  ] as const) {
    it(`redacts ${label}`, () => {
      const { redacted, categories } = redactPIIWithCategories(text);
      expect(redacted).toContain(`[REDACTED-${category}]`);
      expect(categories).toContain(category);
      expect(detectPII(text).categories).toContain(category);
    });
  }

  it("a kept non-card run is not then half-claimed by the phone pattern", () => {
    // `2026 1017 1234 5678` fails Luhn; the 2-4/4/4 phone alternative would
    // otherwise eat its first three groups and leave "[REDACTED-phone] 5678".
    expect(redacts("ref 2026 1017 1234 5678 closed")).toBe(false);
  });

  it("validated and unvalidated matches in one string are handled independently", () => {
    const { redacted, categories } = redactPIIWithCategories(
      "batch 2026101712345678 paid with 4111111111111111 from 10.0.0.12 on release 3.12.1.4"
    );
    expect(redacted).toBe(
      "batch 2026101712345678 paid with [REDACTED-credit_card] from [REDACTED-ip_address] on release 3.12.1.4"
    );
    expect(categories.sort()).toEqual(["credit_card", "ip_address"]);
  });
});

describe("SEC-8 review — redaction never rewrites text it did not match", () => {
  const LITERAL = " and ";

  it("REGRESSION: private-use characters already in the text survive next to a kept candidate", () => {
    const text = `${LITERAL} ledger 2026101712345678`;
    expect(redactPIIWithCategories(text).redacted).toBe(text);
  });

  it("private-use characters survive next to a redacted match", () => {
    const { redacted } = redactPIIWithCategories(`${LITERAL} card 4111111111111111`);
    expect(redacted).toBe(`${LITERAL} card [REDACTED-credit_card]`);
  });
});
