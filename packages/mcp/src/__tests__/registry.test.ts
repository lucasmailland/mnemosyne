import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DoctorReport, MnemosyneClient } from "@mnemo-ai/client-ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_TOOL_COUNT, registerAllTools } from "../registry.js";
import { EXPECTED_TOOL_NAMES } from "./tool-names.js";

function healthyDoctorReport(): DoctorReport {
  return { status: "ok", timestamp: new Date(0).toISOString(), checks: [] };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("unified MCP tool registry", () => {
  it("advertises accurate read and destructive annotations", () => {
    const server = new McpServer({ name: "annotations", version: "0" });
    const configs = new Map<string, Record<string, unknown>>();
    const original = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation((name, config, handler) => {
      configs.set(name, config as Record<string, unknown>);
      return original(name, config, handler);
    });
    registerAllTools(server, {} as MnemosyneClient);
    expect(configs.get("memory_fact")?.annotations).toMatchObject({ readOnlyHint: true });
    expect(configs.get("memory_purge")?.annotations).toMatchObject({ destructiveHint: true });
    expect(configs.get("memory_recall")?.annotations).not.toMatchObject({ readOnlyHint: true });
    expect(configs.get("memory_relate")?.annotations).not.toMatchObject({ readOnlyHint: true });
  });

  it("keeps tools/list descriptions concise and in English", () => {
    const server = new McpServer({ name: "budget", version: "0" });
    const descriptions: string[] = [];
    const original = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation((name, config, handler) => {
      descriptions.push((config as unknown as { description?: string }).description ?? "");
      return original(name, config, handler);
    });
    registerAllTools(server, {} as MnemosyneClient);
    expect(descriptions).toHaveLength(MCP_TOOL_COUNT);
    expect(descriptions.every((description) => description.length <= 250)).toBe(true);
    expect(descriptions.join(" ").length).toBeLessThan(6_000);
    expect(
      descriptions.some((description) => /\b(usá|devuelve|hechos|ámbito)\b/i.test(description))
    ).toBe(false);
  });
  it("registers the exact ordered 36-tool contract once", () => {
    const server = new McpServer({ name: "registry-test", version: "0.0.0" });
    const names: string[] = [];
    const original = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation((name, config, handler) => {
      names.push(name);
      return original(name, config, handler);
    });

    registerAllTools(server, {} as MnemosyneClient);

    expect(MCP_TOOL_COUNT).toBe(37); // P72 added memory_relocate
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
    expect(new Set(names).size).toBe(MCP_TOOL_COUNT);
    expect(names.every((name) => /^memory_[a-z_]+$/.test(name))).toBe(true);
  });

  it("injects the derived registry count into memory_doctor", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_test_registry");
    const server = new McpServer({ name: "registry-test", version: "0.0.0" });
    const client = {
      doctor: vi.fn(async () => healthyDoctorReport()),
    } as unknown as MnemosyneClient;
    let doctorHandler: (() => Promise<unknown>) | undefined;
    const original = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation((name, config, handler) => {
      if (name === "memory_doctor") doctorHandler = handler as () => Promise<unknown>;
      return original(name, config, handler);
    });

    registerAllTools(server, client);
    if (!doctorHandler) throw new Error("memory_doctor was not registered");

    const result = (await doctorHandler()) as { structuredContent: unknown };
    const structured = result.structuredContent as {
      checks: Array<{ name: string; detail?: { toolCount?: number } }>;
    };
    const mcpCheck = structured.checks.find((check) => check.name === "mcp_tools");

    expect(mcpCheck?.detail?.toolCount).toBe(MCP_TOOL_COUNT);
  });
});
