import { describe, expect, it } from "vitest";
import { HttpClient } from "../http.js";
import { MnemosyneClient } from "../index.js";

function spyFetch() {
  const seen: Array<Record<string, string>> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    seen.push({ ...(init?.headers as Record<string, string>) });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const cfg = (fetchImpl: typeof fetch, locale?: string) => ({
  baseUrl: "https://memory.test",
  apiKey: "k",
  fetchImpl,
  timeoutMs: 1000,
  retry: {},
  userAgent: "t",
  ...(locale ? { locale } : {}),
});

describe("client locale -> Accept-Language", () => {
  it("sends Accept-Language when locale is set", async () => {
    const { seen, fetchImpl } = spyFetch();
    await new HttpClient(cfg(fetchImpl, "es-419")).request({ method: "GET", path: "/x" });
    expect(seen[0]?.["Accept-Language"]).toBe("es-419");
  });

  it("sends no header without the option", async () => {
    const { seen, fetchImpl } = spyFetch();
    await new HttpClient(cfg(fetchImpl)).request({ method: "GET", path: "/x" });
    expect(seen[0]).not.toHaveProperty("Accept-Language");
  });

  it("withWorkspace() keeps the locale", async () => {
    const { seen, fetchImpl } = spyFetch();
    await new HttpClient(cfg(fetchImpl, "es-419"))
      .withWorkspace("ws_1")
      .request({ method: "GET", path: "/x" });
    expect(seen[0]?.["Accept-Language"]).toBe("es-419");
  });

  it("an explicit extraHeaders Accept-Language wins", async () => {
    const { seen, fetchImpl } = spyFetch();
    await new HttpClient(cfg(fetchImpl, "es-419")).request({
      method: "GET",
      path: "/x",
      extraHeaders: { "Accept-Language": "en-US" },
    });
    expect(seen[0]?.["Accept-Language"]).toBe("en-US");
  });

  it("MnemosyneClient passes the option through, and forWorkspace keeps it", async () => {
    const { seen, fetchImpl } = spyFetch();
    const c = new MnemosyneClient({
      url: "https://memory.test",
      apiKey: "k",
      fetch: fetchImpl,
      locale: "es-419",
      retry: { attempts: 1 },
    });
    await c
      .forWorkspace("ws_2")
      .recall({ query: "q" })
      .catch(() => undefined);
    expect(seen[0]?.["Accept-Language"]).toBe("es-419");
  });
});
