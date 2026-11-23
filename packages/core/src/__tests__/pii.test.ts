import { describe, it, expect, vi } from "vitest";
import { detectPII } from "../pii/detect.js";
import { detectPIIWithNER } from "../pii/detect.js";
import { detectNER } from "../pii/ner.js";
import { detectPIIWithLLM } from "../pii/llm.js";

describe("detectPII — regex layer", () => {
  it("detects email", () => {
    const r = detectPII("contact me at alice@example.com");
    expect(r.detected).toBe(true);
    expect(r.categories).toContain("email");
  });

  it("detects credit card", () => {
    const r = detectPII("card: 4111 1111 1111 1111");
    expect(r.detected).toBe(true);
    expect(r.categories).toContain("credit_card");
  });

  it("returns clean for benign text", () => {
    const r = detectPII("The quick brown fox jumps over the lazy dog");
    expect(r.detected).toBe(false);
    expect(r.risk_score).toBe(0);
  });
});

describe("detectNER — NER layer", () => {
  it("detects person name with honorific", () => {
    const matches = detectNER("Please contact Dr. John Smith for details.");
    expect(matches.some((m) => m.category === "person_name")).toBe(true);
  });

  it("detects street address", () => {
    const matches = detectNER("I live at 123 Main St");
    expect(matches.some((m) => m.category === "street_address")).toBe(true);
  });

  it("detects passport number", () => {
    const matches = detectNER("passport: AB1234567");
    expect(matches.some((m) => m.category === "passport_number")).toBe(true);
  });

  it("detects date of birth", () => {
    const matches = detectNER("DOB: 01/05/1990");
    expect(matches.some((m) => m.category === "date_of_birth")).toBe(true);
  });
});

describe("detectPIIWithNER — combined", () => {
  it("combines regex and NER matches", () => {
    const r = detectPIIWithNER("Contact Dr. John Smith at alice@example.com");
    expect(r.categories).toContain("email");
    expect(r.categories).toContain("person_name");
    expect(r.risk_score).toBeGreaterThan(0);
  });
});

describe("detectPIIWithLLM", () => {
  it("parses LLM JSON response", async () => {
    const mockLLM = {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify([
          { category: "email", match: "alice@example.com", risk_score: 0.5 },
        ]),
      }),
    };
    const r = await detectPIIWithLLM("contact alice@example.com", mockLLM);
    expect(r.detected).toBe(true);
    expect(r.categories).toContain("email");
  });

  it("returns empty result on LLM error", async () => {
    const mockLLM = {
      generate: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
    };
    const r = await detectPIIWithLLM("test text", mockLLM);
    expect(r.detected).toBe(false);
    expect(r.risk_score).toBe(0);
  });

  it("returns empty result on invalid JSON", async () => {
    const mockLLM = {
      generate: vi.fn().mockResolvedValue({ content: "not json" }),
    };
    const r = await detectPIIWithLLM("test text", mockLLM);
    expect(r.detected).toBe(false);
  });
});
