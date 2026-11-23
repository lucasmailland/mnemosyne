import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DoctorReport, MnemosyneClient } from "@mnemo-ai/client-ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CORE_TOOL_NAMES,
  MCP_TOOL_COUNT,
  PROFILE_TOOL_COUNT,
  mcpToolProfile,
  registerAllTools,
} from "../registry.js";
import { EXPECTED_TOOL_NAMES } from "./tool-names.js";

/**
 * Audit 2026-11-22, PLAN 3.3 — MNEMO_MCP_TOOLS = core | full. The owner reversed
 * D4 the same day: full (all 37) by default, core (9) only when asked for.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function registeredNames(profile?: "core" | "full"): string[] {
  const server = new McpServer({ name: "profile", version: "0" });
  const names: string[] = [];
  const original = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation((name, config, handler) => {
    names.push(name);
    return original(name, config, handler);
  });
  registerAllTools(server, {} as MnemosyneClient, undefined, profile);
  return names;
}

describe("MNEMO_MCP_TOOLS", () => {
  it("defaults to full when unset or blank", () => {
    expect(mcpToolProfile(undefined)).toEqual({ profile: "full" });
    expect(mcpToolProfile("  ")).toEqual({ profile: "full" });
  });

  it("accepts core and full, case- and space-insensitively", () => {
    expect(mcpToolProfile("core")).toEqual({ profile: "core" });
    expect(mcpToolProfile(" FULL ")).toEqual({ profile: "full" });
  });

  it("falls back to core on an unknown value and reports it", () => {
    // Security review: an unrecognised value means someone tried to restrict;
    // it fails closed to the 9 core tools, never open to all 37.
    expect(mcpToolProfile("everything")).toEqual({ profile: "core", invalid: "everything" });
  });
});

describe("tool profiles", () => {
  it("core registers exactly the nine core tools, in registry order", () => {
    expect([...CORE_TOOL_NAMES].sort()).toEqual(
      [
        "memory_context",
        "memory_decide",
        "memory_fact",
        "memory_forget",
        "memory_recall",
        "memory_remember",
        "memory_search",
        "memory_status",
        "memory_update",
      ].sort()
    );
    const names = registeredNames("core");
    expect(names).toEqual(EXPECTED_TOOL_NAMES.filter((n) => CORE_TOOL_NAMES.includes(n as never)));
    expect(names).toHaveLength(PROFILE_TOOL_COUNT.core);
    expect(PROFILE_TOOL_COUNT.core).toBe(9);
  });

  it("full registers all 37", () => {
    expect(registeredNames("full")).toEqual(EXPECTED_TOOL_NAMES);
    expect(PROFILE_TOOL_COUNT.full).toBe(MCP_TOOL_COUNT);
    expect(MCP_TOOL_COUNT).toBe(37);
  });

  it("memory_doctor reports the active profile and its expected count", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_test_profile");
    const server = new McpServer({ name: "profile-doctor", version: "0" });
    const report: DoctorReport = { status: "ok", timestamp: new Date(0).toISOString(), checks: [] };
    const client = { doctor: vi.fn(async () => report) } as unknown as MnemosyneClient;
    let doctor: (() => Promise<unknown>) | undefined;
    const original = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation((name, config, handler) => {
      if (name === "memory_doctor") doctor = handler as () => Promise<unknown>;
      return original(name, config, handler);
    });
    registerAllTools(server, client, undefined, "full");
    const result = (await doctor!()) as {
      structuredContent: {
        checks: Array<{ name: string; status: string; message: string; detail?: unknown }>;
      };
    };
    const check = result.structuredContent.checks.find((c) => c.name === "mcp_tools");
    expect(check?.status).toBe("ok");
    expect(check?.detail).toMatchObject({ profile: "full", toolCount: 37, expected: 37 });
    expect(check?.message).toContain("full");
  });
});
