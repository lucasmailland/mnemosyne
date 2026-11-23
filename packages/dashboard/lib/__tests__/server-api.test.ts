/**
 * TEST-2 — API-bridge test for lib/server-api.ts (packages/dashboard had
 * zero test coverage before this). Proves the session cookie is forwarded
 * as a `Cookie` header and the right MNEMO_SERVER_URL-based URL is built,
 * without needing a live server — mocks next/headers' cookies() and
 * global fetch. See app/login/__tests__/page.test.tsx for the companion
 * component test.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// "server-only" unconditionally throws when imported outside Next.js's
// webpack server-bundle context (it has no runtime environment check — the
// guard is entirely a webpack-alias trick). Stub it so we can test
// server-api.ts's actual logic under plain Node/vitest.
vi.mock("server-only", () => ({}));

const cookieStore = new Map<string, string>();
const requestHeaders = new Headers();
const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  })
);
vi.mock("next/navigation", () => ({ redirect, notFound: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieStore.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => requestHeaders,
}));

// server-api.ts imports "server-only", which is a no-op outside a webpack
// client-bundle build (Next.js's build-time guard) — safe to import directly
// under vitest/node.
const { getSession, apiGet, apiRead, FETCH_TIMEOUT_MS } = await import("../server-api.js");

describe("server-api", () => {
  afterEach(() => {
    cookieStore.clear();
    requestHeaders.delete("x-mnemo-path");
    redirect.mockClear();
    vi.unstubAllGlobals();
  });

  describe("getSession", () => {
    it("returns null without calling fetch when there is no session cookie", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const session = await getSession();

      expect(session).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("forwards the session cookie and hits MNEMO_SERVER_URL/dashboard/auth/session", async () => {
      cookieStore.set("mnemo_dash_token", "test-token-abc");
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ workspaceId: "ws-1" })));
      vi.stubGlobal("fetch", fetchMock);

      await getSession();

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:3939/dashboard/auth/session",
        expect.objectContaining({
          headers: { cookie: "mnemo_dash_token=test-token-abc" },
          cache: "no-store",
        })
      );
    });

    it("returns null when the server responds non-ok", async () => {
      cookieStore.set("mnemo_dash_token", "test-token-abc");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 401 }))
      );

      expect(await getSession()).toBeNull();
    });
  });

  describe("apiGet", () => {
    it("APP-041 without a session cookie (it expired) sends the reader to the login, back to this page, without calling fetch", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      requestHeaders.set("x-mnemo-path", "/dashboard/browser?type=facts");

      await expect(apiGet("/facts")).rejects.toThrow("NEXT_REDIRECT");
      await expect(apiRead("/facts")).rejects.toThrow("NEXT_REDIRECT");
      expect(redirect).toHaveBeenCalledWith("/login?next=%2Fdashboard%2Fbrowser%3Ftype%3Dfacts");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("builds the /dashboard/api URL and forwards the cookie", async () => {
      cookieStore.set("mnemo_dash_token", "test-token-abc");
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] })));
      vi.stubGlobal("fetch", fetchMock);

      const result = await apiGet<{ items: unknown[] }>("/decisions?limit=25");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:3939/dashboard/api/decisions?limit=25",
        expect.objectContaining({
          headers: { cookie: "mnemo_dash_token=test-token-abc" },
          cache: "no-store",
        })
      );
      expect(result).toEqual({ items: [] });
    });
  });

  describe("apiRead", () => {
    it("keeps the HTTP status next to the data, so a 400 and a 404 can be told apart", async () => {
      cookieStore.set("mnemo_dash_token", "t");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ error: "validation_error" }, { status: 400 }))
      );
      expect(await apiRead("/episodes/bad")).toEqual({ data: null, status: 400 });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ a: 1 }))
      );
      expect(await apiRead("/episodes/ok")).toEqual({ data: { a: 1 }, status: 200 });
    });

    it("a 200 whose body is not JSON keeps its status (an answer came)", async () => {
      cookieStore.set("mnemo_dash_token", "t");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("<html>", { status: 200 }))
      );
      expect(await apiRead("/x")).toEqual({ data: null, status: 200 });
    });

    it("status is null when the server cannot be reached", async () => {
      cookieStore.set("mnemo_dash_token", "t");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("fetch failed");
        })
      );
      expect(await apiRead("/x")).toEqual({ data: null, status: null });
    });

    it("APP-043 every bridge fetch carries a 10 s timeout signal", async () => {
      cookieStore.set("mnemo_dash_token", "t");
      const fetchMock = vi.fn(async () => Response.json({}));
      vi.stubGlobal("fetch", fetchMock);
      await apiRead("/x");
      await getSession();
      expect(FETCH_TIMEOUT_MS).toBe(10_000);
      for (const call of fetchMock.mock.calls as unknown as [string, RequestInit][])
        expect(call[1].signal).toBeInstanceOf(AbortSignal);
    });

    it("APP-043 a timeout is a load failure that says so, not a crash", async () => {
      cookieStore.set("mnemo_dash_token", "t");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new DOMException("The operation timed out.", "TimeoutError");
        })
      );
      expect(await apiRead("/x")).toEqual({ data: null, status: null, timedOut: true });
      expect(await apiGet("/x")).toBeNull();
      expect(await getSession()).toBeNull();
    });

    it("APP-041 a 401 (the session ended) sends the reader to the login, back to this page", async () => {
      cookieStore.set("mnemo_dash_token", "t");
      requestHeaders.set("x-mnemo-path", "/dashboard/sessions/abc?tab=facts");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ error: "no_session" }, { status: 401 }))
      );
      await expect(apiRead("/sessions/abc")).rejects.toThrow("NEXT_REDIRECT");
      expect(redirect).toHaveBeenCalledWith(
        "/login?next=%2Fdashboard%2Fsessions%2Fabc%3Ftab%3Dfacts"
      );
      // without the address (no proxy in front), a plain login
      requestHeaders.delete("x-mnemo-path");
      await expect(apiGet("/sessions/abc")).rejects.toThrow("NEXT_REDIRECT");
      expect(redirect).toHaveBeenLastCalledWith("/login");
    });
  });
});
