// Unit tests for circuit breakers (Wave V §22/§26).
import { describe, it, expect } from "vitest";
import { createCircuitBreakers } from "../../resilience/circuitBreakers.js";

describe("CircuitBreakers", () => {
  it("passes through successful LLM generate calls", async () => {
    const cbs = createCircuitBreakers();
    const result = await cbs.llmGenerate(() => Promise.resolve("hello"));
    expect(result).toBe("hello");
  });

  it("passes through successful LLM embed calls", async () => {
    const cbs = createCircuitBreakers();
    const result = await cbs.llmEmbed(() => Promise.resolve([0.1, 0.2, 0.3]));
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it("passes through successful storage read calls", async () => {
    const cbs = createCircuitBreakers();
    const result = await cbs.storageRead(() => Promise.resolve({ id: "f1" }));
    expect(result).toEqual({ id: "f1" });
  });

  it("passes through successful storage write calls", async () => {
    const cbs = createCircuitBreakers();
    const result = await cbs.storageWrite(() => Promise.resolve(undefined));
    expect(result).toBeUndefined();
  });

  it("propagates errors from wrapped functions", async () => {
    const cbs = createCircuitBreakers();
    await expect(
      cbs.storageRead(() => Promise.reject(new Error("db down"))),
    ).rejects.toThrow("db down");
  });
});
