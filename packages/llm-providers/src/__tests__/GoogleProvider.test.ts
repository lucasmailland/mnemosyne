/**
 * What GoogleProvider puts on the wire (audit 2026-11-22):
 *  - the API key went in the URL query (`?key=`), where HTTP auto-instrumentation
 *    and proxies record it; Google accepts it in the x-goog-api-key header;
 *  - every request carried a hard-coded third-party `Referer`, out of place
 *    in an open-source provider (APP-003).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleProvider } from "@mnemo-ai/llm-providers";

const ok = (data: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(data) });

afterEach(() => vi.unstubAllGlobals());

describe("GoogleProvider", () => {
  it.each([
    ["embed", (p: GoogleProvider) => p.embed({ texts: ["hello"] }), { embeddings: [{ values: [0.1] }] }],
    [
      "complete",
      (p: GoogleProvider) => p.complete({ prompt: "hi", maxTokens: 8 }),
      { candidates: [{ content: { parts: [{ text: "ok" }] } }] },
    ],
  ])("%s sends the key in a header, never in the URL, and no Referer", async (_name, call, response) => {
    const fetchMock = ok(response);
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GoogleProvider({ apiKey: "AIza-test-secret" });
    await call(provider).catch(() => undefined);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(String(url)).not.toContain("AIza-test-secret");
    expect(String(url)).not.toContain("key=");
    const headers = Object.fromEntries(
      Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])
    );
    expect(headers["x-goog-api-key"]).toBe("AIza-test-secret");
    expect(headers).not.toHaveProperty("referer");
  });
});
