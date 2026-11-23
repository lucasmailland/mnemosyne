/**
 * Contract test for `memory_doctor` (packages/mcp/src/tools/doctor.ts),
 * covering docs/archive/openspec/tool-promise-remediation/tools/memory_doctor.md.
 *
 * A diagnostic tool has an unusual failure mode: when it is wrong it is wrong
 * in the reassuring direction. A broken check that reports "ok" is worse than
 * no check, because it actively tells an operator to stop looking. That is
 * what this file is for.
 *
 * What it proves, with a stubbed client (no server):
 *   1. The `mcp_tools` check is an INDEPENDENT MEASUREMENT, not a tautology.
 *      It used to compare `toolCount === MCP_TOOL_COUNT` where `toolCount`
 *      WAS `MCP_TOOL_COUNT` — an assertion that could never fail, i.e. a
 *      check that verified nothing while reporting "ok" forever. It now reads
 *      a probe at call time. These tests drive the probe to disagree with the
 *      constant and require the check to say so.
 *   2. A registrar that FAILED to register is surfaced by name, not hidden
 *      behind a count that happens to line up.
 *   3. An unreachable server does not fail the whole tool: the local checks
 *      (env, tool registry) still report. A doctor that dies when the patient
 *      is sick is the one shape a diagnostic must not have.
 *   4. The env check distinguishes which variable is missing rather than
 *      emitting one ambiguous message.
 *
 * Phase 4's separate task — "fix the `mcp_tools` check's hardcoded `>= 15`
 * floor to reference MCP_TOOL_COUNT" — was already done before this audit ran:
 * the current code compares against `MCP_TOOL_COUNT` exactly. The `>= 15`
 * threshold is still observable in PRODUCTION only because prod runs an older
 * build; it is not in this source tree. Verified 2026-08-13.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DoctorReport, MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerDoctor, type ToolRegistrationProbe } from "../../tools/doctor.js";
import { MCP_TOOL_COUNT } from "../../registry.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

interface Check {
  name: string;
  status: string;
  message: string;
  detail?: Record<string, unknown>;
}

function capture(
  client: MnemosyneClient,
  probe: ToolRegistrationProbe
): (args: Record<string, unknown>) => Promise<ToolResult> {
  const server = new McpServer({ name: "doctor-test", version: "0.0.0" });
  let handler: ((a: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: (a: Record<string, unknown>) => Promise<unknown>) => {
      if (name === "memory_doctor") handler = cb as typeof handler;
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerDoctor(server, client, probe);
  if (!handler) throw new Error("memory_doctor was not registered");
  return handler;
}

const healthy = (): DoctorReport => ({
  status: "ok",
  timestamp: new Date(0).toISOString(), // determinism-ok: fixture instant, never asserted
  checks: [],
});

const okProbe = { count: () => MCP_TOOL_COUNT, failures: () => [] };

function checks(res: ToolResult): Check[] {
  return ((res.structuredContent?.["checks"] as Check[]) ?? []).map((c) => c);
}
const find = (res: ToolResult, name: string) => checks(res).find((c) => c.name === name);

describe("memory_doctor — contract", () => {
  it("reports ok for mcp_tools when the probe agrees with the registry", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_x");
    const call = capture({ doctor: vi.fn(async () => healthy()) } as never, okProbe);

    const tools = find(await call({}), "mcp_tools");
    expect(tools?.status).toBe("ok");
    vi.unstubAllEnvs();
  });

  it("the mcp_tools check is a real measurement, not a tautology", async () => {
    // The whole point of Phase 4. Drive the probe AWAY from the constant: if
    // the check still says "ok", it is comparing the constant to itself and
    // can never detect a registrar that silently failed to register.
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_x");
    const call = capture({ doctor: vi.fn(async () => healthy()) } as never, {
      count: () => MCP_TOOL_COUNT - 1,
      failures: () => [],
    });

    const tools = find(await call({}), "mcp_tools");
    expect(tools?.status).not.toBe("ok");
    expect(tools?.message).toContain(String(MCP_TOOL_COUNT));
    vi.unstubAllEnvs();
  });

  it("names the registrars that failed instead of only reporting a count", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_x");
    const call = capture({ doctor: vi.fn(async () => healthy()) } as never, {
      count: () => MCP_TOOL_COUNT - 1,
      failures: () => [{ registrar: "registerPurge", error: "boom" }],
    });

    const tools = find(await call({}), "mcp_tools");
    // "35 of 36" sends someone counting; "registerPurge failed" is actionable.
    expect(tools?.message).toContain("registerPurge");
    vi.unstubAllEnvs();
  });

  describe("the env check distinguishes which variable is missing", () => {
    for (const [label, url, key, expected] of [
      ["both missing", undefined, undefined, "are not set"],
      ["url missing", undefined, "mns_live_x", "MNEMO_URL is not set"],
      ["key missing", "http://x", undefined, "MNEMO_KEY is not set"],
    ] as const) {
      it(label, async () => {
        vi.unstubAllEnvs();
        vi.stubEnv("MNEMO_URL", url ?? "");
        vi.stubEnv("MNEMO_KEY", key ?? "");
        const call = capture({ doctor: vi.fn(async () => healthy()) } as never, okProbe);

        const env = find(await call({}), "env_config");
        expect(env?.status).toBe("error");
        expect(env?.message).toContain(expected);
        vi.unstubAllEnvs();
      });
    }
  });

  it("an unreachable server still yields a report — the doctor does not die with the patient", async () => {
    vi.stubEnv("MNEMO_URL", "http://localhost:3939");
    vi.stubEnv("MNEMO_KEY", "mns_live_x");
    const call = capture(
      {
        doctor: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      } as never,
      okProbe
    );

    const res = await call({});

    // The locally-computable checks are exactly the ones an operator needs
    // when the server is down. Failing the whole tool would withhold them at
    // the moment they matter most.
    expect(res.isError).toBeUndefined();
    expect(find(res, "mcp_tools")).toBeDefined();
    expect(find(res, "env_config")).toBeDefined();
    vi.unstubAllEnvs();
  });
});
