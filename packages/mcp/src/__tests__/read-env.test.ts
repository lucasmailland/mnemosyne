import { afterEach, describe, expect, it, vi } from "vitest";
import { collapseTimeoutMs, mcpTimeoutMs, readEnv } from "../env.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * M3 — MNEMO_WORKSPACE_ID env wiring. Unit tests for `readEnv()` only
 * (not `main()`, which constructs a real MnemosyneClient/McpServer and
 * calls process.exit — out of scope for a fast unit test).
 */
describe("readEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when MNEMO_URL or MNEMO_KEY is missing", () => {
    vi.stubEnv("MNEMO_URL", "");
    vi.stubEnv("MNEMO_KEY", "");
    expect(readEnv()).toBeNull();
  });

  it("omits workspaceId when MNEMO_WORKSPACE_ID is unset", () => {
    vi.stubEnv("MNEMO_URL", "https://memory.example.com");
    vi.stubEnv("MNEMO_KEY", "uk_live_abc");
    vi.stubEnv("MNEMO_WORKSPACE_ID", "");
    const env = readEnv();
    expect(env).toEqual({ url: "https://memory.example.com", key: "uk_live_abc" });
    expect(env).not.toHaveProperty("workspaceId");
  });

  it("includes workspaceId when MNEMO_WORKSPACE_ID is set", () => {
    vi.stubEnv("MNEMO_URL", "https://memory.example.com");
    vi.stubEnv("MNEMO_KEY", "uk_live_abc");
    vi.stubEnv("MNEMO_WORKSPACE_ID", "ws_123");
    const env = readEnv();
    expect(env).toEqual({
      url: "https://memory.example.com",
      key: "uk_live_abc",
      workspaceId: "ws_123",
    });
  });

  it("trims whitespace around MNEMO_WORKSPACE_ID", () => {
    vi.stubEnv("MNEMO_URL", "https://memory.example.com");
    vi.stubEnv("MNEMO_KEY", "uk_live_abc");
    vi.stubEnv("MNEMO_WORKSPACE_ID", "  ws_123  ");
    expect(readEnv()?.workspaceId).toBe("ws_123");
  });

  it("uses the nearest repo .mnemo.json workspace when no environment override exists", () => {
    const root = mkdtempSync(join(tmpdir(), "mnemo-mcp-env-"));
    const previous = process.cwd();
    try {
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, ".mnemo.json"), JSON.stringify({ workspaceId: "ws_repo" }));
      process.chdir(join(root, "nested"));
      vi.stubEnv("MNEMO_URL", "http://localhost:3939");
      vi.stubEnv("MNEMO_KEY", "uk_test");
      vi.stubEnv("MNEMO_WORKSPACE_ID", "");
      expect(readEnv()?.workspaceId).toBe("ws_repo");
      vi.stubEnv("MNEMO_WORKSPACE_ID", "ws_override");
      expect(readEnv()?.workspaceId).toBe("ws_override");
    } finally {
      process.chdir(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** APP-014: the call budget is configurable, bounded, and collapse never gets less than 120 s. */
describe("mcpTimeoutMs / collapseTimeoutMs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 15 s and 120 s for a collapse", () => {
    vi.stubEnv("MNEMO_MCP_TIMEOUT_MS", "");
    expect(mcpTimeoutMs()).toEqual({ ms: 15_000 });
    expect(collapseTimeoutMs()).toBe(120_000);
  });

  it("takes a valid MNEMO_MCP_TIMEOUT_MS, and a collapse never gets less", () => {
    vi.stubEnv("MNEMO_MCP_TIMEOUT_MS", "30000");
    expect(mcpTimeoutMs()).toEqual({ ms: 30_000 });
    expect(collapseTimeoutMs()).toBe(120_000);
    vi.stubEnv("MNEMO_MCP_TIMEOUT_MS", "300000");
    expect(collapseTimeoutMs()).toBe(300_000);
  });

  it.each(["abc", "15.5", "0", "999", "600001", "-5"])(
    "falls back to the default and reports %s as invalid",
    (raw) => {
      expect(mcpTimeoutMs(raw)).toEqual({ ms: 15_000, invalid: raw });
    }
  );
});
