/**
 * Unit tests for the setup wizard banner printed by `mnemo init --docker`.
 *
 * Tests: fetchAndPrintSetupBanner
 *  - GET /setup/token HTTP 200 → banner printed to stdout
 *  - GET /setup/token HTTP 404 → no banner printed
 *  - fetch throws (network error) → no banner, no crash
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAndPrintSetupBanner } from "../commands.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(console, "log").mockImplementation(() => { /* no-op */ });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchAndPrintSetupBanner", () => {
  it("prints the banner when /setup/token returns 200", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        token: "test-token-uuid",
        setupUrl: "http://localhost:3939/setup?token=test-token-uuid",
        expiresAt: "2026-01-01T12:15:00.000Z",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchAndPrintSetupBanner(3939);

    // console.log should have been called multiple times (box drawing lines)
    expect(console.log).toHaveBeenCalled();
    const allCalls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(allCalls).toContain("SETUP WIZARD");
    expect(allCalls).toContain("http://localhost:3939/setup?token=test-token-uuid");
  });

  it("does not print the banner when /setup/token returns 404", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "not_found" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchAndPrintSetupBanner(3939);

    expect(console.log).not.toHaveBeenCalled();
  });

  it("does not crash when fetch throws a network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", mockFetch);

    // Should not throw
    await expect(fetchAndPrintSetupBanner(3939)).resolves.toBeUndefined();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("constructs setupUrl from token when setupUrl is absent in response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        token: "fallback-token",
        // no setupUrl field
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchAndPrintSetupBanner(3940);

    const allCalls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(allCalls).toContain("fallback-token");
    expect(allCalls).toContain("3940");
  });
});
