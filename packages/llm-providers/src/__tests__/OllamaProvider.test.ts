/**
 * Unit tests for OllamaProvider request bodies.
 * fetch is stubbed, so these assert exactly what goes on the wire.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { OllamaProvider } from "@mnemo-ai/llm-providers";

const makeMockFetch = (responseData: unknown) =>
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(responseData),
  });

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("OllamaProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("needs no API key", () => {
    expect(() => new OllamaProvider({})).not.toThrow();
  });

  // P154: a thinking-capable model (qwen3 and friends) spends the whole
  // num_predict budget on hidden reasoning unless the request turns it off,
  // and extraction gets an empty `response`.
  it("sends think:false on completions and keeps model, options and JSON format", async () => {
    const fetchMock = makeMockFetch({ response: "{}", done: true });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider({ baseURL: "http://ollama.test" });

    await provider.complete({
      prompt: "extract",
      system: "sys",
      model: "qwen3:4b",
      maxTokens: 64,
      temperature: 0.1,
      json: true,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://ollama.test/api/generate");
    const body = sentBody(fetchMock);
    expect(body.think).toBe(false);
    expect(body.model).toBe("qwen3:4b");
    expect(body.stream).toBe(false);
    expect(body.format).toBe("json");
    expect(body.options).toEqual({ num_predict: 64, temperature: 0.1 });
  });

  it("does not send think on embeddings", async () => {
    const fetchMock = makeMockFetch({ embeddings: [[0.1, 0.2]] });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider({ baseURL: "http://ollama.test" });

    await provider.embed({ texts: ["hello"], model: "bge-m3" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://ollama.test/api/embed");
    expect(sentBody(fetchMock)).toEqual({ model: "bge-m3", input: ["hello"] });
  });

  // The local stack sets this: at Ollama's default (every core the VM shows)
  // an embed took seconds and tripped the server's 3s embed deadline.
  it("sends num_thread on embeds and completions only when configured", async () => {
    const embedMock = makeMockFetch({ embeddings: [[0.1]] });
    vi.stubGlobal("fetch", embedMock);
    await new OllamaProvider({ numThread: 4 }).embed({ texts: ["hello"], model: "bge-m3" });
    expect(sentBody(embedMock).options).toEqual({ num_thread: 4 });

    const plainMock = makeMockFetch({ embeddings: [[0.1]] });
    vi.stubGlobal("fetch", plainMock);
    await new OllamaProvider({}).embed({ texts: ["hello"], model: "bge-m3" });
    expect(sentBody(plainMock).options).toBeUndefined();

    const completeMock = makeMockFetch({ response: "ok", done: true });
    vi.stubGlobal("fetch", completeMock);
    await new OllamaProvider({ numThread: 4 }).complete({ prompt: "p", maxTokens: 8 });
    expect(sentBody(completeMock).options).toMatchObject({ num_predict: 8, num_thread: 4 });
  });
});
