/**
 * §35(r) / §24 — MCP tool contract suite.
 *
 * Table-driven over EVERY registered tool: for each it asserts the wire contract
 * — schema metadata, required-field enforcement, unknown-field tolerance
 * (non-strict, so additive server changes don't break old clients), and the
 * idempotency-key shape where present. Happy-path + per-action behavior live in
 * tools.test.ts; auth-scope + rate-limit are enforced server-side and covered by
 * the server contract tests (the MCP layer always delegates through the client).
 *
 * Exact built-wire JSON Schema evidence for every tool lives in
 * contracts/schema-contracts.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

import { MCP_TOOL_COUNT, registerAllTools } from "../registry.js";

interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema?: Record<string, z.ZodTypeAny>;
}

function captureAllTools(): Map<string, ToolConfig> {
  const server = new McpServer({ name: "contract", version: "0.0.0" });
  const map = new Map<string, ToolConfig>();
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, config: unknown, cb: unknown) => {
      map.set(name, config as ToolConfig);
      return orig(name, config as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    },
  );
  const stub = {} as MnemosyneClient;
  registerAllTools(server, stub);
  return map;
}

const TOOLS = captureAllTools();

// A field is "optional" if it accepts `undefined` — avoids the deprecated
// ZodType.isOptional() and correctly treats .optional()/.default() as optional.
const isOptional = (f: z.ZodTypeAny): boolean => f.safeParse(undefined).success;

// ── Main contract suite ──────────────────────────────────────────────────────

describe("§35(r) MCP tool contract — full surface", () => {
  it("registers every tool under a unique memory_* name", () => {
    expect(TOOLS.size).toBe(MCP_TOOL_COUNT);
    for (const name of TOOLS.keys()) expect(name).toMatch(/^memory_[a-z_]+$/);
  });

  describe.each([...TOOLS.entries()])("%s", (name, config) => {
    const fields = config.inputSchema ?? {};
    const obj = z.object(fields);

    it("declares title + description metadata", () => {
      expect(typeof config.title).toBe("string");
      expect(config.title!.length).toBeGreaterThan(0);
      expect(typeof config.description).toBe("string");
      expect(config.description!.length).toBeGreaterThan(10);
    });

    it("inputSchema fields are all Zod types", () => {
      for (const [k, v] of Object.entries(fields)) {
        expect(v, `${name}.${k}`).toBeInstanceOf(z.ZodType);
      }
    });

    it("enforces required fields (empty parse succeeds iff all fields optional)", () => {
      const hasRequired = Object.values(fields).some((f) => !isOptional(f));
      const res = obj.safeParse({});
      expect(res.success).toBe(!hasRequired);
    });

    it("is unknown-field tolerant (non-strict — additive server changes are safe)", () => {
      const res = obj.safeParse({ __contract_unknown__: "x" });
      // Either it parses (unknown stripped), or it fails ONLY for a missing
      // required field — never because of the unrecognized key.
      const failedOnUnknown =
        !res.success && res.error.issues.some((i) => i.code === "unrecognized_keys");
      expect(failedOnUnknown).toBe(false);
    });

    it("idempotencyKey, when present, is an optional string (§34.9)", () => {
      const idem = fields["idempotencyKey"];
      if (!idem) return; // not all tools are mutating
      expect(isOptional(idem)).toBe(true);
      expect(idem.safeParse("uuid-v4").success).toBe(true);
      expect(idem.safeParse(123).success).toBe(false);
    });
  });
});
