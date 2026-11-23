import { describe, it, expect, vi } from "vitest";
import { LlmProviderAdapter, createLlmAdapter } from "../index.js";
import type { CreatedProvider } from "@mnemo-ai/llm-providers";
import type { LLMInput } from "@mnemo-ai/types";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<CreatedProvider> = {}): CreatedProvider {
  return {
    name: "mock-provider",
    capabilities: {
      embed: false,
      complete: true,
      streaming: false,
      jsonMode: false,
    },
    async embed(_text: string, _model: string): Promise<number[]> {
      return [0.1, 0.2, 0.3];
    },
    async embedWithUsage(_text: string, _model: string) {
      return {
        vector: [0.1, 0.2, 0.3],
        tokensUsed: 1,
        costUSD: 0.0001,
        model: "mock",
        provider: "mock",
      };
    },
    embedBatch: async (_req) => ({
      vectors: [[0.1]],
      tokensUsed: 1,
      model: "mock",
      provider: "mock",
    }),
    async complete(req) {
      return {
        text: `echo: ${req.prompt}`,
        tokensIn: 10,
        tokensOut: 5,
        model: req.model ?? "mock-model",
        provider: "mock",
        finishReason: "stop",
      };
    },
    ...overrides,
  };
}

const baseInput: LLMInput = {
  messages: [{ role: "user", content: "Hello, world!" }],
};

// ─── generate() ───────────────────────────────────────────────────────────────

describe("LlmProviderAdapter — generate()", () => {
  it("returns mapped LLMOutput for a simple user message", async () => {
    const provider = makeProvider();
    const adapter = new LlmProviderAdapter(provider, { model: "mock-model" });

    const result = await adapter.generate(baseInput);

    expect(result.content).toContain("user: Hello, world!");
    expect(result.tokensUsed).toEqual({ input: 10, output: 5 });
    expect(result.model).toBe("mock-model");
    expect(result.finishReason).toBe("stop");
  });

  it("prepends the system message to the prompt", async () => {
    const completeSpy = vi.fn().mockResolvedValue({
      text: "ok",
      tokensIn: 3,
      tokensOut: 2,
      model: "mock-model",
      provider: "mock",
      finishReason: "stop",
    });
    const provider = makeProvider({ complete: completeSpy });
    const adapter = new LlmProviderAdapter(provider, { model: "mock-model" });

    await adapter.generate({
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Hi" }],
    });

    const calledWith = completeSpy.mock.calls[0]?.[0];
    expect(calledWith?.prompt).toContain("You are a helpful assistant.");
    expect(calledWith?.prompt).toContain("user: Hi");
    expect(calledWith?.system).toBe("You are a helpful assistant.");
  });

  it("forwards the task so a router can pick the provider", async () => {
    const completeSpy = vi.fn().mockResolvedValue({
      text: "{}",
      tokensIn: 1,
      tokensOut: 1,
      model: "mock-model",
      provider: "mock",
    });
    const adapter = new LlmProviderAdapter(makeProvider({ complete: completeSpy }), {
      model: "mock-model",
    });

    await adapter.generate({ ...baseInput, task: "judge" });
    await adapter.generateStructured({ ...baseInput, task: "summary" }, { parse: (d) => d });

    expect(completeSpy.mock.calls.map(([req]) => req.task)).toEqual(["judge", "summary"]);
  });

  it("joins multiple messages in order", async () => {
    const completeSpy = vi.fn().mockResolvedValue({
      text: "done",
      tokensIn: 5,
      tokensOut: 1,
      model: "mock-model",
      provider: "mock",
      finishReason: "stop",
    });
    const provider = makeProvider({ complete: completeSpy });
    const adapter = new LlmProviderAdapter(provider, { model: "mock-model" });

    await adapter.generate({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
    });

    const prompt: string = completeSpy.mock.calls[0]?.[0]?.prompt ?? "";
    const lines = prompt.split("\n");
    expect(lines[0]).toBe("user: first");
    expect(lines[1]).toBe("assistant: second");
    expect(lines[2]).toBe("user: third");
  });

  it("maps vendor finishReason 'length' correctly", async () => {
    const provider = makeProvider({
      complete: vi.fn().mockResolvedValue({
        text: "truncated",
        tokensIn: 1,
        tokensOut: 1,
        model: "m",
        provider: "p",
        finishReason: "length",
      }),
    });
    const adapter = new LlmProviderAdapter(provider, { model: "m" });
    const result = await adapter.generate(baseInput);
    expect(result.finishReason).toBe("length");
  });

  it("defaults finishReason to 'stop' for unknown vendor values", async () => {
    const provider = makeProvider({
      complete: vi.fn().mockResolvedValue({
        text: "ok",
        tokensIn: 1,
        tokensOut: 1,
        model: "m",
        provider: "p",
        finishReason: "content_filter",
      }),
    });
    const adapter = new LlmProviderAdapter(provider, { model: "m" });
    const result = await adapter.generate(baseInput);
    expect(result.finishReason).toBe("stop");
  });

  it("throws when provider.complete is undefined", async () => {
    const provider = makeProvider({ complete: undefined });
    const adapter = new LlmProviderAdapter(provider, { model: "m" });
    await expect(adapter.generate(baseInput)).rejects.toThrow(/does not support completions/);
  });

  it("forwards maxTokens and temperature to provider", async () => {
    const completeSpy = vi.fn().mockResolvedValue({
      text: "ok",
      tokensIn: 1,
      tokensOut: 1,
      model: "m",
      provider: "p",
      finishReason: "stop",
    });
    const provider = makeProvider({ complete: completeSpy });
    const adapter = new LlmProviderAdapter(provider, { model: "m" });

    await adapter.generate({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 42,
      temperature: 0.7,
    });

    expect(completeSpy.mock.calls[0]?.[0]?.maxTokens).toBe(42);
    expect(completeSpy.mock.calls[0]?.[0]?.temperature).toBe(0.7);
  });
});

// ─── generateStructured() ─────────────────────────────────────────────────────

describe("LlmProviderAdapter — generateStructured()", () => {
  it("parses JSON response through schema", async () => {
    const payload = { answer: 42 };
    const provider = makeProvider({
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify(payload),
        tokensIn: 5,
        tokensOut: 5,
        model: "m",
        provider: "p",
        finishReason: "stop",
      }),
    });
    const adapter = new LlmProviderAdapter(provider, { model: "m" });

    // Zod-like schema mock
    const schema = { parse: (data: unknown) => data as { answer: number } };
    const result = await adapter.generateStructured(baseInput, schema);
    expect(result.answer).toBe(42);
  });

  it("passes json: true when provider supports jsonMode", async () => {
    const completeSpy = vi.fn().mockResolvedValue({
      text: JSON.stringify({ ok: true }),
      tokensIn: 1,
      tokensOut: 1,
      model: "m",
      provider: "p",
      finishReason: "stop",
    });
    const provider = makeProvider({
      capabilities: { embed: false, complete: true, streaming: false, jsonMode: true },
      complete: completeSpy,
    });
    const adapter = new LlmProviderAdapter(provider, { model: "m" });
    const schema = { parse: (d: unknown) => d as { ok: boolean } };

    await adapter.generateStructured(baseInput, schema);

    expect(completeSpy.mock.calls[0]?.[0]?.json).toBe(true);
  });

  it("does NOT pass json: true when provider lacks jsonMode", async () => {
    const completeSpy = vi.fn().mockResolvedValue({
      text: JSON.stringify({ x: 1 }),
      tokensIn: 1,
      tokensOut: 1,
      model: "m",
      provider: "p",
      finishReason: "stop",
    });
    const provider = makeProvider({
      capabilities: { embed: false, complete: true, streaming: false, jsonMode: false },
      complete: completeSpy,
    });
    const adapter = new LlmProviderAdapter(provider, { model: "m" });
    const schema = { parse: (d: unknown) => d as { x: number } };

    await adapter.generateStructured(baseInput, schema);

    expect(completeSpy.mock.calls[0]?.[0]?.json).toBeUndefined();
  });

  it("throws a descriptive error on non-JSON response", async () => {
    const provider = makeProvider({
      complete: vi.fn().mockResolvedValue({
        text: "not json at all",
        tokensIn: 1,
        tokensOut: 1,
        model: "m",
        provider: "p",
        finishReason: "stop",
      }),
    });
    const adapter = new LlmProviderAdapter(provider, { model: "m" });
    const schema = { parse: (d: unknown) => d };

    await expect(adapter.generateStructured(baseInput, schema)).rejects.toThrow(/non-JSON content/);
  });

  it("throws a descriptive error when schema.parse fails", async () => {
    const provider = makeProvider({
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({ wrong: "shape" }),
        tokensIn: 1,
        tokensOut: 1,
        model: "m",
        provider: "p",
        finishReason: "stop",
      }),
    });
    const adapter = new LlmProviderAdapter(provider, { model: "m" });
    const schema = {
      parse(_data: unknown): { required: string } {
        throw new Error("Missing field 'required'");
      },
    };

    await expect(adapter.generateStructured(baseInput, schema)).rejects.toThrow(
      /schema validation failed/
    );
  });

  it("throws when provider.complete is undefined", async () => {
    const provider = makeProvider({ complete: undefined });
    const adapter = new LlmProviderAdapter(provider, { model: "m" });
    const schema = { parse: (d: unknown) => d };
    await expect(adapter.generateStructured(baseInput, schema)).rejects.toThrow(
      /does not support completions/
    );
  });
});

// ─── healthCheck() ────────────────────────────────────────────────────────────

describe("LlmProviderAdapter — healthCheck()", () => {
  it('returns status "ok" when complete succeeds', async () => {
    const provider = makeProvider();
    const adapter = new LlmProviderAdapter(provider, { model: "m" });

    const result = await adapter.healthCheck();

    expect(result.status).toBe("ok");
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns status "degraded" when complete throws', async () => {
    const provider = makeProvider({
      complete: vi.fn().mockRejectedValue(new Error("Connection refused")),
    });
    const adapter = new LlmProviderAdapter(provider, { model: "m" });

    const result = await adapter.healthCheck();

    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("Connection refused");
  });

  it('returns status "degraded" when provider.complete is undefined', async () => {
    const provider = makeProvider({ complete: undefined });
    const adapter = new LlmProviderAdapter(provider, { model: "m" });

    const result = await adapter.healthCheck();

    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("complete not supported");
  });
});

// ─── id / model properties ────────────────────────────────────────────────────

describe("LlmProviderAdapter — id / model", () => {
  it("defaults id to provider.name", () => {
    const provider = makeProvider();
    const adapter = new LlmProviderAdapter(provider, { model: "gpt-4o" });
    expect(adapter.id).toBe("mock-provider");
  });

  it("uses explicit id when provided", () => {
    const provider = makeProvider();
    const adapter = new LlmProviderAdapter(provider, { id: "my-adapter", model: "gpt-4o" });
    expect(adapter.id).toBe("my-adapter");
  });

  it("exposes the model option", () => {
    const provider = makeProvider();
    const adapter = new LlmProviderAdapter(provider, { model: "claude-3-5-sonnet-20241022" });
    expect(adapter.model).toBe("claude-3-5-sonnet-20241022");
  });
});

// ─── createLlmAdapter factory ─────────────────────────────────────────────────

describe("createLlmAdapter factory", () => {
  it("returns an LLMAdapter-shaped object", () => {
    const provider = makeProvider();
    const adapter = createLlmAdapter(provider, { model: "m" });

    expect(typeof adapter.generate).toBe("function");
    expect(typeof adapter.generateStructured).toBe("function");
    expect(typeof adapter.healthCheck).toBe("function");
    expect(typeof adapter.id).toBe("string");
    expect(typeof adapter.model).toBe("string");
  });
});
