/**
 * Unit tests for the memory_doctor MCP tool.
 *
 * Tests cover:
 *  - env_config check (MNEMO_URL / MNEMO_KEY missing variants)
 *  - mcp_tools check threshold logic
 *  - Merging server-side checks with client-side checks
 *  - Overall worst-of status computation
 *  - Server unreachable path (client.doctor() throws)
 *  - Response shape validation
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { MnemosyneClient, DoctorReport } from "@mnemo-ai/client-ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_TOOL_COUNT, registerAllTools } from "../registry.js";
import { registerDoctor } from "../tools/doctor.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClientStub(partial: Partial<Pick<MnemosyneClient, "doctor">>): MnemosyneClient {
  return partial as unknown as MnemosyneClient;
}

function registerAndCapture(
  client: MnemosyneClient,
  toolCount: number
): { handler: (args: Record<string, unknown>) => Promise<unknown> } {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (
      toolName: string,
      schema: unknown,
      cb: (args: Record<string, unknown>) => Promise<unknown>
    ) => {
      if (toolName === "memory_doctor") handler = cb;
      return orig(toolName, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerDoctor(server, client, toolCount);
  if (!handler) throw new Error("memory_doctor was not registered");
  return { handler };
}

function makeHealthyServerReport(): DoctorReport {
  return {
    status: "ok",
    timestamp: new Date().toISOString(), // determinism-ok: mock fixture, value not asserted,
    checks: [
      { name: "connectivity", status: "ok", message: "ok" },
      { name: "app_user_grants", status: "ok", message: "ok" },
      { name: "schema_shadows", status: "ok", message: "ok" },
      { name: "migration_version", status: "ok", message: "ok" },
      { name: "embedding_backlog", status: "ok", message: "ok" },
      { name: "workspace_id_valid", status: "ok", message: "ok" },
    ],
  };
}

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: unknown;
};

// ─── Tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("memory_doctor — env_config check", () => {
  it("passes when both MNEMO_URL and MNEMO_KEY are set", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_testkey12345678901234");
    const client = makeClientStub({ doctor: vi.fn(async () => makeHealthyServerReport()) });
    const { handler } = registerAndCapture(client, MCP_TOOL_COUNT);
    const out = (await handler({})) as ToolResult;
    const result = JSON.parse(out.content[0]!.text) as {
      checks: Array<{ name: string; status: string }>;
    };
    const env = result.checks.find((c) => c.name === "env_config");
    expect(env?.status).toBe("ok");
  });

  it("errors when MNEMO_URL is missing", async () => {
    vi.stubEnv("MNEMO_URL", "");
    vi.stubEnv("MNEMO_KEY", "mns_live_testkey12345678901234");
    const client = makeClientStub({ doctor: vi.fn(async () => makeHealthyServerReport()) });
    const { handler } = registerAndCapture(client, MCP_TOOL_COUNT);
    const out = (await handler({})) as ToolResult;
    const result = JSON.parse(out.content[0]!.text) as {
      status: string;
      checks: Array<{ name: string; status: string; message: string }>;
    };
    const env = result.checks.find((c) => c.name === "env_config");
    expect(env?.status).toBe("error");
    expect(env?.message).toContain("MNEMO_URL");
  });

  it("errors when MNEMO_KEY is missing", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "");
    const client = makeClientStub({ doctor: vi.fn(async () => makeHealthyServerReport()) });
    const { handler } = registerAndCapture(client, MCP_TOOL_COUNT);
    const out = (await handler({})) as ToolResult;
    const result = JSON.parse(out.content[0]!.text) as {
      status: string;
      checks: Array<{ name: string; status: string; message: string }>;
    };
    const env = result.checks.find((c) => c.name === "env_config");
    expect(env?.status).toBe("error");
    expect(env?.message).toContain("MNEMO_KEY");
  });

  it("errors with both vars missing", async () => {
    vi.stubEnv("MNEMO_URL", "");
    vi.stubEnv("MNEMO_KEY", "");
    const client = makeClientStub({ doctor: vi.fn(async () => makeHealthyServerReport()) });
    const { handler } = registerAndCapture(client, MCP_TOOL_COUNT);
    const out = (await handler({})) as ToolResult;
    const result = JSON.parse(out.content[0]!.text) as {
      status: string;
      checks: Array<{ name: string; status: string; message: string }>;
    };
    const env = result.checks.find((c) => c.name === "env_config");
    expect(env?.status).toBe("error");
  });
});

describe("memory_doctor — mcp_tools check", () => {
  // Compares the injected count against MCP_TOOL_COUNT (the real
  // TOOL_REGISTRARS.length from registry.ts) with exact equality — not the
  // old hardcoded `>= 15` floor, which could only ever fail after losing
  // ~20 of 34 registered tools.
  it.each([
    { count: MCP_TOOL_COUNT - 1, status: "warn" },
    { count: MCP_TOOL_COUNT, status: "ok" },
    { count: MCP_TOOL_COUNT + 1, status: "warn" },
  ])("uses injected count $count against MCP_TOOL_COUNT ($status)", async ({ count, status }) => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_key");
    const client = makeClientStub({ doctor: vi.fn(async () => makeHealthyServerReport()) });
    const { handler } = registerAndCapture(client, count);
    const out = (await handler({})) as ToolResult;
    const result = JSON.parse(out.content[0]!.text) as {
      checks: Array<{
        name: string;
        status: string;
        message: string;
        detail?: { toolCount?: number; expected?: number };
      }>;
    };
    const mcp = result.checks.find((c) => c.name === "mcp_tools");
    expect(mcp?.status).toBe(status);
    expect(mcp?.message).toContain(String(count));
    expect(mcp?.detail?.toolCount).toBe(count);
    expect(mcp?.detail?.expected).toBe(MCP_TOOL_COUNT);
  });

  // Regression proof: the OLD `toolCount >= 15` floor reported "ok" for any
  // count from 15 up to MCP_TOOL_COUNT, so silently losing tools down to 15
  // (e.g. 34 -> 20, more than a third of the registry) would never have
  // been caught. The fixed check compares against the live MCP_TOOL_COUNT,
  // so the same regression now reports "warn".
  it("catches a regression the old >= 15 floor would have missed (e.g. dropping from 34 to 20 registered tools)", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_key");
    const regressedCount = 20;
    expect(regressedCount).toBeGreaterThanOrEqual(15); // the old floor would have said "ok"
    expect(regressedCount).toBeLessThan(MCP_TOOL_COUNT);

    const client = makeClientStub({ doctor: vi.fn(async () => makeHealthyServerReport()) });
    const { handler } = registerAndCapture(client, regressedCount);
    const out = (await handler({})) as ToolResult;
    const result = JSON.parse(out.content[0]!.text) as {
      status: string;
      checks: Array<{ name: string; status: string }>;
    };
    const mcp = result.checks.find((c) => c.name === "mcp_tools");
    expect(mcp?.status).toBe("warn");
    expect(result.status).toBe("warn");
  });
});

describe("memory_doctor — server checks merging", () => {
  it("merges 6 server checks + 2 client checks = 8 total", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_key");
    const client = makeClientStub({ doctor: vi.fn(async () => makeHealthyServerReport()) });
    const { handler } = registerAndCapture(client, MCP_TOOL_COUNT);
    const out = (await handler({})) as ToolResult;
    const result = JSON.parse(out.content[0]!.text) as { checks: unknown[] };
    expect(result.checks).toHaveLength(8);
  });

  it("overall status is error when server has an error check", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_key");
    const report: DoctorReport = {
      ...makeHealthyServerReport(),
      status: "error",
      checks: [
        ...makeHealthyServerReport().checks.slice(0, 5),
        { name: "workspace_id_valid", status: "error", message: "bad uuid" },
      ],
    };
    const client = makeClientStub({ doctor: vi.fn(async () => report) });
    const { handler } = registerAndCapture(client, MCP_TOOL_COUNT);
    const out = (await handler({})) as ToolResult;
    const result = JSON.parse(out.content[0]!.text) as { status: string };
    expect(result.status).toBe("error");
  });

  it("overall status is warn when server has a warn check and no errors", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_key");
    const report: DoctorReport = {
      ...makeHealthyServerReport(),
      status: "warn",
      checks: [
        ...makeHealthyServerReport().checks.slice(0, 4),
        { name: "embedding_backlog", status: "warn", message: "42 pending" },
        { name: "workspace_id_valid", status: "ok", message: "ok" },
      ],
    };
    const client = makeClientStub({ doctor: vi.fn(async () => report) });
    const { handler } = registerAndCapture(client, MCP_TOOL_COUNT);
    const out = (await handler({})) as ToolResult;
    const result = JSON.parse(out.content[0]!.text) as { status: string };
    expect(result.status).toBe("warn");
  });

  it("overall status is ok when all 8 checks pass", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_key");
    const client = makeClientStub({ doctor: vi.fn(async () => makeHealthyServerReport()) });
    const { handler } = registerAndCapture(client, MCP_TOOL_COUNT);
    const out = (await handler({})) as ToolResult;
    const result = JSON.parse(out.content[0]!.text) as { status: string };
    expect(result.status).toBe("ok");
  });
});

describe("memory_doctor — server unreachable", () => {
  it("returns a server error check and overall error when client.doctor() throws", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_key");
    const client = makeClientStub({
      doctor: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    const { handler } = registerAndCapture(client, MCP_TOOL_COUNT);
    const out = (await handler({})) as ToolResult;
    const result = JSON.parse(out.content[0]!.text) as {
      status: string;
      checks: Array<{ name: string; status: string; message: string }>;
    };
    expect(result.status).toBe("error");
    const serverCheck = result.checks.find((c) => c.name === "server");
    expect(serverCheck?.status).toBe("error");
    expect(serverCheck?.message).toContain("ECONNREFUSED");
  });

  it("still returns env_config and mcp_tools checks when server is down", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_key");
    const client = makeClientStub({
      doctor: vi.fn(async () => {
        throw new Error("unreachable");
      }),
    });
    const { handler } = registerAndCapture(client, MCP_TOOL_COUNT);
    const out = (await handler({})) as ToolResult;
    const result = JSON.parse(out.content[0]!.text) as { checks: Array<{ name: string }> };
    const names = result.checks.map((c) => c.name);
    expect(names).toContain("env_config");
    expect(names).toContain("mcp_tools");
    expect(names).toContain("server");
  });
});

describe("memory_doctor — response shape", () => {
  it("returns content[0].type === 'text' with valid JSON", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_key");
    const client = makeClientStub({ doctor: vi.fn(async () => makeHealthyServerReport()) });
    const { handler } = registerAndCapture(client, MCP_TOOL_COUNT);
    const out = (await handler({})) as ToolResult;
    expect(out.content[0]?.type).toBe("text");
    const text = out.content[0]?.text;
    expect(() => JSON.parse(text ?? "")).not.toThrow();
  });

  it("structuredContent matches parsed text content", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_key");
    const client = makeClientStub({ doctor: vi.fn(async () => makeHealthyServerReport()) });
    const { handler } = registerAndCapture(client, MCP_TOOL_COUNT);
    const out = (await handler({})) as ToolResult;
    const parsed = JSON.parse(out.content[0]!.text);
    expect(out.structuredContent).toMatchObject(parsed);
  });
});

describe("memory_doctor — mcp_tools measures REAL registrations (DOCTOR-1)", () => {
  function captureDoctorHandler(server: McpServer) {
    let handler: (() => Promise<unknown>) | undefined;
    const orig = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation((name, config, cb) => {
      if (name === "memory_doctor") handler = cb as () => Promise<unknown>;
      return orig(name, config as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    });
    return {
      get: () => {
        if (!handler) throw new Error("memory_doctor was not registered");
        return handler;
      },
    };
  }

  async function runDoctor(handler: () => Promise<unknown>) {
    const out = (await handler()) as ToolResult;
    return JSON.parse(out.content[0]!.text) as {
      status: string;
      checks: Array<{
        name: string;
        status: string;
        message: string;
        detail?: {
          toolCount?: number;
          expected?: number;
          failedRegistrars?: Array<{ registrar: string; error: string }>;
        };
      }>;
    };
  }

  it("reports ok with the real 34 when every registrar succeeds", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_key");
    const server = new McpServer({ name: "doctor-real", version: "0.0.0" });
    const cap = captureDoctorHandler(server);
    registerAllTools(
      server,
      makeClientStub({ doctor: vi.fn(async () => makeHealthyServerReport()) })
    );
    const result = await runDoctor(cap.get());
    const mcp = result.checks.find((c) => c.name === "mcp_tools");
    expect(mcp?.status).toBe("ok");
    expect(mcp?.detail?.toolCount).toBe(MCP_TOOL_COUNT);
  });

  it("reports a failure when an EARLY registrar (before memory_doctor) cannot register", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_key");
    const server = new McpServer({ name: "doctor-real", version: "0.0.0" });
    // Squat on memory_recall (TOOL_REGISTRARS[0]) so the REAL registerRecall
    // throws "already registered" — a genuine failure, no mocking.
    server.registerTool("memory_recall", { title: "decoy", inputSchema: {} }, async () => ({
      content: [],
    }));
    const cap = captureDoctorHandler(server);
    registerAllTools(
      server,
      makeClientStub({ doctor: vi.fn(async () => makeHealthyServerReport()) })
    );
    const result = await runDoctor(cap.get());
    const mcp = result.checks.find((c) => c.name === "mcp_tools");
    expect(mcp?.status).not.toBe("ok");
    expect(mcp?.detail?.toolCount).toBe(MCP_TOOL_COUNT - 1);
    expect(mcp?.detail?.failedRegistrars?.map((f) => f.registrar)).toContain("registerRecall");
    expect(result.status).not.toBe("ok");
  });

  it("reports a failure when a LATE registrar (after memory_doctor) cannot register — proves the count is read lazily", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_key");
    const server = new McpServer({ name: "doctor-real", version: "0.0.0" });
    // memory_workspace is index 33, seven AFTER registerDoctorFromRegistry (26).
    server.registerTool("memory_workspace", { title: "decoy", inputSchema: {} }, async () => ({
      content: [],
    }));
    const cap = captureDoctorHandler(server);
    registerAllTools(
      server,
      makeClientStub({ doctor: vi.fn(async () => makeHealthyServerReport()) })
    );
    const result = await runDoctor(cap.get());
    const mcp = result.checks.find((c) => c.name === "mcp_tools");
    expect(mcp?.detail?.toolCount).toBe(MCP_TOOL_COUNT - 1);
    expect(mcp?.detail?.failedRegistrars?.map((f) => f.registrar)).toContain("registerWorkspace");
    expect(mcp?.status).not.toBe("ok");
  });

  it("a failing registrar no longer aborts the whole boot — the other 33 tools still register", async () => {
    const server = new McpServer({ name: "doctor-real", version: "0.0.0" });
    server.registerTool("memory_recall", { title: "decoy", inputSchema: {} }, async () => ({
      content: [],
    }));
    const names: string[] = [];
    const orig = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation((name, config, cb) => {
      // Push only after orig() succeeds — a name pushed unconditionally here
      // would record the FAILED memory_recall attempt too (orig throws on
      // the duplicate name, but a JS array push isn't rolled back by a
      // later throw), counting attempts instead of the successes this test
      // is actually asserting on.
      const result = orig(
        name,
        config as Parameters<typeof orig>[1],
        cb as Parameters<typeof orig>[2]
      );
      names.push(name);
      return result;
    });
    expect(() => registerAllTools(server, {} as MnemosyneClient)).not.toThrow(); // pre-fix THROWS
    expect(names).toHaveLength(MCP_TOOL_COUNT - 1);
    expect(names).not.toContain("memory_recall");
  });
});
