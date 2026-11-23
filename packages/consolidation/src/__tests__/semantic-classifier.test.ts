import { describe, it, expect, vi } from "vitest";
import { classifyFactPair, FactPairClassificationError } from "../SemanticClassifier.js";
import type { ValidatorLLM } from "../ReplayValidator.js";

// ─── LLM stub factory ─────────────────────────────────────────────────────────

function makeLLM(response: string): ValidatorLLM {
  return {
    generate: vi.fn().mockResolvedValue({
      content: response,
      tokensUsed: { input: 10, output: 5 },
    }),
  };
}

function makeLLMThrowing(): ValidatorLLM {
  return {
    generate: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("classifyFactPair", () => {
  describe("classification parsing", () => {
    it("returns DUPLICATE for exact word DUPLICATE", async () => {
      const result = await classifyFactPair(makeLLM("DUPLICATE"), "A", "B");
      expect(result.classification).toBe("DUPLICATE");
      expect(result.confident).toBe(true);
    });

    it("returns CONTRADICTION for exact word CONTRADICTION", async () => {
      const result = await classifyFactPair(makeLLM("CONTRADICTION"), "A", "B");
      expect(result.classification).toBe("CONTRADICTION");
      expect(result.confident).toBe(true);
    });

    it("returns COMPATIBLE for exact word COMPATIBLE", async () => {
      const result = await classifyFactPair(makeLLM("COMPATIBLE"), "A", "B");
      expect(result.classification).toBe("COMPATIBLE");
      expect(result.confident).toBe(true);
    });

    it("normalises lowercase LLM output to uppercase", async () => {
      const result = await classifyFactPair(makeLLM("contradiction"), "A", "B");
      expect(result.classification).toBe("CONTRADICTION");
      expect(result.confident).toBe(true);
    });

    it("normalises mixed-case LLM output", async () => {
      const result = await classifyFactPair(makeLLM("Duplicate"), "A", "B");
      expect(result.classification).toBe("DUPLICATE");
      expect(result.confident).toBe(true);
    });

    it("accepts the label with trailing punctuation or markdown emphasis", async () => {
      for (const reply of ["CONTRADICTION.", "**Duplicate**", "`compatible`", '"CONTRADICTION"']) {
        const result = await classifyFactPair(makeLLM(reply), "A", "B");
        expect(result.confident, reply).toBe(true);
      }
    });

    // WP-7 review — an answer is accepted only when it IS a label. A verdict
    // fished out of prose turned "NOT DUPLICATE" into DUPLICATE, and a
    // DUPLICATE folds the incoming write into an existing fact.
    for (const reply of [
      "COMPATIBLE — these facts are related but do not conflict.",
      "These facts are NOT DUPLICATE",
      "NOT DUPLICATE",
      "Classification: CONTRADICTION",
      "DUPLICATE or CONTRADICTION",
      "CONTRADICTION CONTRADICTION",
    ]) {
      it(`rejects a reply that is not exactly one label: ${JSON.stringify(reply)}`, async () => {
        const err = await classifyFactPair(makeLLM(reply), "A", "B").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(FactPairClassificationError);
        expect((err as FactPairClassificationError).reason).toBe("unrecognised_response");
      });
    }

    it("rejects unrecognised LLM output instead of calling it COMPATIBLE", async () => {
      const err = await classifyFactPair(
        makeLLM("I cannot determine the relationship."),
        "A",
        "B"
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FactPairClassificationError);
      expect((err as FactPairClassificationError).reason).toBe("unrecognised_response");
    });

    it("rejects an empty LLM response", async () => {
      const err = await classifyFactPair(makeLLM(""), "A", "B").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FactPairClassificationError);
      expect((err as FactPairClassificationError).reason).toBe("unrecognised_response");
    });

    it("ignores a reasoning block before the answer", async () => {
      const result = await classifyFactPair(
        makeLLM(
          "<think>A says DUPLICATE-ish things, but B changes the value.</think>\nCONTRADICTION"
        ),
        "A",
        "B"
      );
      expect(result.classification).toBe("CONTRADICTION");
    });
  });

  describe("LLM unavailability", () => {
    it("rejects with llm_error when the LLM throws (never a silent COMPATIBLE)", async () => {
      const err = await classifyFactPair(makeLLMThrowing(), "A", "B").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FactPairClassificationError);
      expect((err as FactPairClassificationError).reason).toBe("llm_error");
      expect((err as FactPairClassificationError).message).toContain("LLM unavailable");
    });
  });

  describe("LLM call parameters", () => {
    it("calls LLM with maxTokens=50 and temperature=0", async () => {
      const llm = makeLLM("DUPLICATE");
      await classifyFactPair(llm, "Pablo uses PostgreSQL", "Pablo uses PostgreSQL for storage");
      expect(llm.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          maxTokens: 50,
          temperature: 0,
        })
      );
    });

    it("includes both fact statements in the prompt", async () => {
      const llm = makeLLM("CONTRADICTION");
      await classifyFactPair(llm, "Pablo uses PostgreSQL", "The team chose MySQL");
      const call = vi.mocked(llm.generate).mock.calls[0]![0];
      const promptContent = call.messages[0]!.content;
      expect(promptContent).toContain("Pablo uses PostgreSQL");
      expect(promptContent).toContain("The team chose MySQL");
    });
  });

  describe("rawResponse field", () => {
    it("exposes the trimmed LLM response", async () => {
      const result = await classifyFactPair(makeLLM("  DUPLICATE  "), "A", "B");
      expect(result.rawResponse).toBe("DUPLICATE");
    });

    it("exposes the unrecognised raw response on the error", async () => {
      const err = await classifyFactPair(makeLLM("MAYBE"), "A", "B").catch((e: unknown) => e);
      expect((err as FactPairClassificationError).rawResponse).toBe("MAYBE");
    });
  });
});
