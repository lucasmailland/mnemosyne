/**
 * Unit tests for BedrockProvider.
 * Tests use API Key mode (fetch-based) which is fully mockable.
 * IAM credentials mode uses dynamic import (new Function) which vitest cannot mock —
 * that path is covered by integration tests with real AWS credentials.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { BedrockProvider, LLMProviderError } from "@mnemo-ai/llm-providers";

const API_KEY = "ABSKQmVkcm9ja0FQSUtleXRlc3Q="; // fake base64 key for tests

const makeMockFetch = (responseData: unknown, ok = true) =>
  vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 403,
    json: async () => responseData,
    text: async () => JSON.stringify(responseData),
    statusText: ok ? "OK" : "Forbidden",
  });

describe("BedrockProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("throws LLMProviderError when no credentials provided", () => {
    expect(() => new BedrockProvider({})).toThrow(LLMProviderError);
  });

  it("accepts apiKey (Bedrock API Key mode)", () => {
    expect(() => new BedrockProvider({ apiKey: API_KEY })).not.toThrow();
  });

  it("reports capabilities: embed=true, complete=true", () => {
    const provider = new BedrockProvider({ apiKey: API_KEY });
    expect(provider.capabilities.embed).toBe(true);
    expect(provider.capabilities.complete).toBe(true);
  });

  it("throws LLMProviderError on unsupported model", async () => {
    vi.stubGlobal("fetch", makeMockFetch({}));
    const provider = new BedrockProvider({ apiKey: API_KEY });
    await expect(
      provider.embed!({ texts: ["test"], model: "unsupported-model-xyz" })
    ).rejects.toThrow(LLMProviderError);
  });

  describe("Titan embed (amazon.titan-embed-text-v2:0)", () => {
    it("chunks an oversized input and returns one normalized vector", async () => {
      const mockFetch = makeMockFetch({ embedding: [3, 4], inputTextTokenCount: 2 });
      vi.stubGlobal("fetch", mockFetch);
      const provider = new BedrockProvider({ apiKey: API_KEY });
      const result = await provider.embed!({ texts: ["word ".repeat(10_362) + "xx"] });
      const bodies = mockFetch.mock.calls.map((call) =>
        JSON.parse((call[1] as RequestInit).body as string)
      );
      expect(bodies.length).toBeGreaterThan(1);
      expect(bodies.every((body) => body.inputText.length <= 20_000)).toBe(true);
      expect(result.vectors).toEqual([[0.6, 0.8]]);
      expect(result.tokensUsed).toBe(bodies.length * 2);
    });

    it("sends the chunks of one input concurrently, at most eight at a time", async () => {
      let inFlight = 0;
      let peak = 0;
      const mockFetch = vi.fn(async (_url: string, _init: RequestInit) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { ok: true, json: async () => ({ embedding: [3, 4], inputTextTokenCount: 1 }) };
      });
      vi.stubGlobal("fetch", mockFetch);
      const provider = new BedrockProvider({ apiKey: API_KEY });
      const result = await provider.embed!({ texts: ["word ".repeat(40_000)] });
      expect(mockFetch.mock.calls.length).toBe(10);
      expect(peak).toBe(8);
      expect(result.vectors).toEqual([[0.6, 0.8]]);
      expect(result.tokensUsed).toBe(10);
    });

    it("preserves order and count for mixed short and long inputs", async () => {
      let call = 0;
      const mockFetch = vi.fn(async (_url: string, _init: RequestInit) => ({
        ok: true,
        json: async () => ({ embedding: [++call, 0] }),
      }));
      vi.stubGlobal("fetch", mockFetch);
      const provider = new BedrockProvider({ apiKey: API_KEY });
      const result = await provider.embed!({ texts: ["first", "x".repeat(51_812), "last"] });
      expect(result.vectors).toHaveLength(3);
      expect(result.vectors[0]).toEqual([1, 0]);
      expect(result.vectors[1]).toEqual([1, 0]);
      expect(result.vectors[2]).toEqual([mockFetch.mock.calls.length, 0]);
      expect(
        mockFetch.mock.calls
          .map((call) => JSON.parse((call[1] as RequestInit).body as string).inputText)
          .join("")
      ).toBe("first" + "x".repeat(51_812) + "last");
    });

    it("sends a short input once with its original body", async () => {
      const mockFetch = makeMockFetch({ embedding: [3, 4], inputTextTokenCount: 1 });
      vi.stubGlobal("fetch", mockFetch);
      const provider = new BedrockProvider({ apiKey: API_KEY });
      const result = await provider.embed!({ texts: ["short text"] });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect((mockFetch.mock.calls[0]![1] as RequestInit).body).toBe(
        JSON.stringify({ inputText: "short text", dimensions: 1024, normalize: true })
      );
      expect(result.vectors).toEqual([[3, 4]]);
    });
    it("returns embedding for single text", async () => {
      const mockEmbedding = Array.from({ length: 1024 }, (_, i) => i / 1024);
      vi.stubGlobal("fetch", makeMockFetch({ embedding: mockEmbedding, inputTextTokenCount: 5 }));

      const provider = new BedrockProvider({ apiKey: API_KEY, awsRegion: "us-east-1" });
      const result = await provider.embed!({
        texts: ["hello world"],
        model: "amazon.titan-embed-text-v2:0",
      });

      expect(result.vectors).toHaveLength(1);
      expect(result.vectors[0]).toHaveLength(1024);
      expect(result.tokensUsed).toBe(5);
      expect(result.provider).toBe("bedrock");
      expect(result.model).toBe("amazon.titan-embed-text-v2:0");
    });

    it("calls fetch once per text for Titan (no batching)", async () => {
      const mockEmbedding = Array.from({ length: 1024 }, () => 0.1);
      const mockFetch = makeMockFetch({ embedding: mockEmbedding, inputTextTokenCount: 3 });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new BedrockProvider({ apiKey: API_KEY });
      await provider.embed!({
        texts: ["text one", "text two"],
        model: "amazon.titan-embed-text-v2:0",
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("uses default model amazon.titan-embed-text-v2:0 when no model specified", async () => {
      const mockEmbedding = Array.from({ length: 1024 }, () => 0.5);
      vi.stubGlobal("fetch", makeMockFetch({ embedding: mockEmbedding, inputTextTokenCount: 2 }));

      const provider = new BedrockProvider({ apiKey: API_KEY });
      const result = await provider.embed!({ texts: ["test"] });

      expect(result.model).toBe("amazon.titan-embed-text-v2:0");
    });
  });

  describe("Cohere embed (cohere.embed-english-v3)", () => {
    it("returns batched embeddings in a single fetch call", async () => {
      const mockEmbeddings = [
        Array.from({ length: 1024 }, () => 0.1),
        Array.from({ length: 1024 }, () => 0.2),
      ];
      const mockFetch = makeMockFetch({ embeddings: mockEmbeddings });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new BedrockProvider({ apiKey: API_KEY });
      const result = await provider.embed!({
        texts: ["text one", "text two"],
        model: "cohere.embed-english-v3",
      });

      expect(result.vectors).toHaveLength(2);
      expect(result.vectors[0]).toHaveLength(1024);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("complete() — Claude via Bedrock API Key", () => {
    it("calls Claude model and returns text", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: "Hello! How can I help?" }],
          usage: { input_tokens: 10, output_tokens: 8 },
          stop_reason: "end_turn",
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new BedrockProvider({ apiKey: API_KEY, awsRegion: "us-east-1" });
      const result = await provider.complete!({
        prompt: "Say hello",
        maxTokens: 50,
      });

      expect(result.text).toBe("Hello! How can I help?");
      expect(result.tokensIn).toBe(10);
      expect(result.tokensOut).toBe(8);
      expect(result.provider).toBe("bedrock");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("claude-haiku"),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: `Bearer ${API_KEY}` }),
        })
      );
    });

    it("includes system prompt when provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: "ok" }],
          usage: { input_tokens: 5, output_tokens: 1 },
          stop_reason: "end_turn",
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new BedrockProvider({ apiKey: API_KEY });
      await provider.complete!({ prompt: "hi", system: "You are a helpful assistant." });

      const callBody = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
      expect(callBody.system).toBe("You are a helpful assistant.");
    });

    it("throws LLMProviderError on HTTP error", async () => {
      vi.stubGlobal("fetch", makeMockFetch({ message: "Model not found" }, false));
      const provider = new BedrockProvider({ apiKey: API_KEY });
      await expect(provider.complete!({ prompt: "hi" })).rejects.toThrow(LLMProviderError);
    });
  });

  describe("API Key auth format", () => {
    it("sends Bearer token in Authorization header", async () => {
      const mockFetch = makeMockFetch({
        embedding: new Array(1024).fill(0.1),
        inputTextTokenCount: 1,
      });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new BedrockProvider({ apiKey: API_KEY, awsRegion: "eu-west-1" });
      await provider.embed!({ texts: ["test"], model: "amazon.titan-embed-text-v2:0" });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("bedrock-runtime.eu-west-1.amazonaws.com"),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: `Bearer ${API_KEY}` }),
        })
      );
    });

    it("throws LLMProviderError on HTTP 403", async () => {
      vi.stubGlobal("fetch", makeMockFetch({ message: "Invalid key" }, false));
      const provider = new BedrockProvider({ apiKey: "bad-key" });
      await expect(
        provider.embed!({ texts: ["test"], model: "amazon.titan-embed-text-v2:0" })
      ).rejects.toThrow(LLMProviderError);
    });
  });

  describe("Bedrock API Key mode (no AWS SDK needed)", () => {
    const API_KEY = "ABSKQmVkcm9ja0FQSUtleXRlc3Q="; // fake key for tests

    it("accepts apiKey instead of IAM credentials", () => {
      expect(() => new BedrockProvider({ apiKey: API_KEY })).not.toThrow();
    });

    it("uses fetch with Bearer token for Titan embed", async () => {
      const mockEmbedding = Array.from({ length: 1024 }, () => 0.1);
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ embedding: mockEmbedding, inputTextTokenCount: 3 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new BedrockProvider({ apiKey: API_KEY, awsRegion: "us-east-1" });
      const result = await provider.embed!({
        texts: ["hello"],
        model: "amazon.titan-embed-text-v2:0",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("bedrock-runtime.us-east-1.amazonaws.com"),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: `Bearer ${API_KEY}` }),
        })
      );
      expect(result.vectors[0]).toHaveLength(1024);
      vi.unstubAllGlobals();
    });

    it("throws on HTTP error from Bedrock", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => "Invalid API Key format",
        statusText: "Forbidden",
      });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new BedrockProvider({ apiKey: "invalid-key" });
      await expect(
        provider.embed!({ texts: ["test"], model: "amazon.titan-embed-text-v2:0" })
      ).rejects.toThrow(LLMProviderError);
      vi.unstubAllGlobals();
    });
  });
});
