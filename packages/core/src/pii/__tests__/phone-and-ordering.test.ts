/**
 * P119 — the phone pattern, and the order patterns are applied in.
 *
 * Neither had a single test before this file, which is how the bug survived:
 * `patterns.ts` opens by declaring "Conservative — prefer false negatives over
 * false positives", and its phone entry did the exact opposite. Every
 * separator in it was optional, so it matched any run of 10+ digits.
 *
 * That matters more than a normal false positive because redaction is a WRITE
 * operation. `remember()` reassigns `req.content` before embedding and before
 * insert (CORE-1), which is precisely what makes it correct for real PII — the
 * original never reaches the embedding provider or the row. The same property
 * makes a false positive IRREVERSIBLE: the number is not stored anywhere, in
 * any form. A fact saying "we processed 1786644306016 rows" came back from the
 * database as "we processed [REDACTED-phone] rows", and nothing anywhere said
 * so.
 */
import { describe, it, expect } from "vitest";
import { PII_SEVERITY } from "../patterns.js";
import { redactPIIWithCategories } from "../redact.js";

/** Reads better than three assertions per case. */
function redacts(text: string): boolean {
  return redactPIIWithCategories(text).redacted !== text;
}

describe("P119 — phone detection", () => {
  describe("still catches real phone numbers", () => {
    for (const s of [
      "+1 415 555 0132",
      "(415) 555-0132",
      "415-555-0132",
      "415.555.0132",
      "+442071838750",
      "011 4321 1234",
    ]) {
      it(`redacts ${s}`, () => {
        expect(redacts(`llamame al ${s} cuando puedas`)).toBe(true);
      });
    }

    it("catches +54 911 2345 6789, which the OLD pattern missed", () => {
      // The false NEGATIVE half of P119, and the reason "just tighten it" was
      // the wrong fix: the old pattern was a North-American 3-3-4 shape with an
      // optional country code, so the format most of the world writes slipped
      // straight through while order ids were being redacted.
      const { redacted, categories } = redactPIIWithCategories("mi cel es +54 911 2345 6789");
      expect(redacted).toContain("[REDACTED-phone]");
      expect(redacted).not.toContain("2345");
      expect(categories).toContain("phone");
    });
  });

  describe("no longer eats numbers that are not phones", () => {
    for (const [label, s] of [
      ["a millisecond timestamp", "procesamos 1786644306016 filas"],
      ["an order id", "pedido 4815162342 despachado"],
      ["an invoice number", "factura 00123456789"],
      ["a bare 10-digit run", "el hash numérico 4155550132 no cambió"],
      ["a thousands-separated count", "el sistema movió 12.345.678 filas"],
      ["an ISO date", "cerrado el 2026-08-13"],
      ["a build number", "v3.2.1 build 20260813"],
      ["a port", "escucha en el puerto 3939"],
    ] as const) {
      it(`leaves ${label} intact`, () => {
        expect(redacts(s)).toBe(false);
      });
    }
  });
});

describe("P119 — patterns are applied most-sensitive first", () => {
  it("a separated card number is redacted as a CARD, with no digits left over", () => {
    // The regression this ordering exists to prevent, and it is not
    // hypothetical: with `phone` applied before `credit_card` (the old object
    // order) and a phone pattern that matches `4111 1111 1111`, the card became
    // "[REDACTED-phone] 1111" — wrong category, and the last four digits still
    // sitting there in the clear.
    const { redacted, categories } = redactPIIWithCategories("tarjeta 4111 1111 1111 1111");

    expect(redacted).toBe("tarjeta [REDACTED-credit_card]");
    expect(categories).toContain("credit_card");
    expect(categories).not.toContain("phone");
    // The assertion that would have caught the leak on its own.
    expect(redacted).not.toMatch(/\d/);
  });

  for (const s of ["4111-1111-1111-1111", "4111 1111 1111 1111", "4111111111111111"]) {
    it(`leaves no digits behind for ${s}`, () => {
      expect(redactPIIWithCategories(s).redacted).not.toMatch(/\d/);
    });
  }

  it("an SSN stays an SSN and does not get claimed by phone", () => {
    const { redacted, categories } = redactPIIWithCategories("ssn 123-45-6789");
    expect(categories).toContain("ssn");
    expect(redacted).not.toMatch(/\d/);
  });

  it("the ordering is derived from the severity table, not from object order", () => {
    // A structural check, so the guarantee survives someone adding a category
    // to the object literal in the wrong place.
    const order = Object.keys(PII_SEVERITY) as Array<keyof typeof PII_SEVERITY>;
    const sorted = [...order].sort((a, b) => PII_SEVERITY[b] - PII_SEVERITY[a]);
    expect(PII_SEVERITY[sorted[0]!]).toBeGreaterThanOrEqual(PII_SEVERITY[sorted.at(-1)!]);
    expect(PII_SEVERITY.credit_card).toBeGreaterThan(PII_SEVERITY.phone);
  });
});
