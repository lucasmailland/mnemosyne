/**
 * G1 — MCP tool-contract Zod I/O tests.
 *
 * Drives off the REAL registry: every register* call is intercepted via spy to
 * capture the inputSchema. A table of { good, bad } fixtures then asserts
 * `.safeParse(good).success === true` and `.safeParse(bad).success === false`
 * for each tool. An extra top-level assertion cross-checks the table against
 * the captured registry so adding or removing a tool is caught immediately.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

// Unified runtime registry
import { MCP_TOOL_COUNT, registerAllTools } from "../registry.js";

// ── registry capture ──────────────────────────────────────────────────────────

interface CapturedTool {
  name: string;
  inputSchema: Record<string, z.ZodTypeAny>;
}

function captureRegistry(): Map<string, CapturedTool> {
  const server = new McpServer({ name: "contract-io", version: "0.0.0" });
  const map = new Map<string, CapturedTool>();
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, config: unknown, cb: unknown) => {
      const cfg = config as { inputSchema?: Record<string, z.ZodTypeAny> };
      map.set(name, { name, inputSchema: cfg.inputSchema ?? {} });
      return orig(name, config as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  const stub = {} as MnemosyneClient;
  registerAllTools(server, stub);
  return map;
}

const REGISTRY = captureRegistry();

// ── fixtures ──────────────────────────────────────────────────────────────────
// Each entry: good = minimal valid input, bad = clearly-invalid input
// (missing required field or wrong type on a required field).

interface Fixture {
  good: Record<string, unknown>;
  /** Single bad input that should fail validation */
  bad: Record<string, unknown>;
}

const FIXTURES: Record<string, Fixture> = {
  memory_recall: {
    good: { query: "recent project decisions" },
    bad: { query: "" }, // min(1) — empty string is invalid
  },
  // P67 — the escalation half of compact recall.
  memory_fact: {
    good: { factId: "fact_1" },
    bad: { factId: "" }, // min(1) — an empty id is invalid
  },
  memory_remember: {
    good: { statement: "User prefers dark mode" },
    bad: { statement: 42 }, // wrong type — must be string
  },
  memory_pin: {
    good: { factId: "mfact_abc123" },
    bad: { factId: "" }, // min(1) — empty string is invalid
  },
  // P72 — its own tool, not a field on memory_update. `targetWorkspaceId` is
  // `.uuid()`, so a well-formed-but-not-a-UUID id is the interesting reject:
  // an unvalidated workspace id would send the fact somewhere unnameable.
  memory_relocate: {
    good: {
      factId: "mfact_abc123",
      targetWorkspaceId: "00000000-0000-4000-8000-000000000001",
    },
    bad: { factId: "mfact_abc123", targetWorkspaceId: "not-a-uuid" },
  },
  memory_forget: {
    good: { factId: "mfact_abc123" },
    bad: { factId: "" }, // min(1) — empty string is invalid
  },
  memory_timeline: {
    good: {},
    bad: { limit: 0 }, // min(1)
  },
  memory_search: {
    good: { query: "vector similarity concepts" },
    bad: { query: "" }, // min(1)
  },
  memory_relate: {
    good: {
      sourceKind: "fact",
      from: "mfact_src",
      targetKind: "entity",
      to: "ment_dst",
      verb: "derived_from",
    },
    bad: {
      sourceKind: "unknown_kind", // not in enum
      from: "mfact_src",
      targetKind: "entity",
      to: "ment_dst",
      verb: "derived_from",
    },
  },
  memory_decide: {
    good: {
      kind: "architecture",
      title: "Use PostgreSQL as primary DB",
      body: "Chosen because of ACID guarantees and mature ecosystem",
    },
    bad: {
      kind: "invalid_kind", // not in enum
      title: "Some decision",
      body: "Some reason",
    },
  },
  memory_entity: {
    good: { name: "Acme Corp", kind: "organization" },
    bad: { name: "Acme Corp", kind: "robot" }, // not in enum
  },
  memory_status: {
    good: {},
    bad: {}, // no required fields; any input parses — we need a different bad case
    // Note: status has empty inputSchema so any {} parses. We'll handle this specially below.
  },
  memory_remind_when: {
    good: {
      content: "Ask the user about the contract",
      condition: "when Acme is mentioned",
    },
    bad: {
      content: "", // min(1)
      condition: "when Acme is mentioned",
    },
  },
  memory_episode_start: {
    good: {},
    bad: { metadata: "not-an-object" }, // record(string, unknown) — string not allowed
  },
  memory_episode_end: {
    good: { sessionId: "sess_abc" },
    bad: { sessionId: "" }, // min(1)
  },
  memory_session: {
    good: { action: "pin" },
    bad: { action: "invalid_action" }, // not in enum
  },
  memory_consolidate: {
    good: {},
    bad: { mode: "invalid_mode" }, // not in enum
  },
  memory_task: {
    good: { action: "list" },
    bad: { action: "invalid_action" }, // not in enum
  },
  memory_event: {
    good: { action: "list" },
    bad: { action: "invalid_action" }, // not in enum
  },
  memory_reasoning: {
    good: { action: "list" },
    bad: { action: "invalid_action" }, // not in enum
  },
  memory_strategy: {
    good: { op: "list" },
    bad: { op: "invalid_op" }, // not in enum
  },
  memory_self_edit: {
    good: { action: "reflect", target: "profile", reason: "Re-evaluate my knowledge base" },
    bad: { action: "invalid_action", target: "profile", reason: "x" }, // not in enum
  },
  memory_hyperedge: {
    good: { action: "list" },
    bad: { action: "invalid_action" }, // not in enum
  },
  memory_introspect: {
    good: {},
    bad: { aspect: "invalid_aspect" }, // not in enum
  },
  memory_anticipate: {
    good: {},
    bad: { limit: 0 }, // min(1)
  },
  memory_compose: {
    good: { action: "list" },
    bad: { action: "invalid_action" }, // not in enum
  },
  memory_workflow: {
    good: { action: "list" },
    bad: { action: "invalid_action" }, // not in enum
  },
  memory_skill: {
    good: { action: "list" },
    bad: { action: "invalid_action" }, // not in enum
  },
  memory_doctor: { good: {}, bad: {} },
  memory_update: {
    good: { factId: "mfact_abc", statement: "Corrected" },
    bad: { factId: "", statement: "Corrected" },
  },
  memory_judge: {
    good: { action: "list" },
    bad: { action: "invalid_action" },
  },
  memory_stats: {
    good: {},
    bad: {}, // empty inputSchema — any input parses (same as memory_status)
  },
  memory_compare: {
    good: { factIdA: "mfact_abc", factIdB: "mfact_xyz" },
    bad: { factIdA: "", factIdB: "mfact_xyz" }, // min(1) — empty factIdA is invalid
  },
  memory_purge: {
    good: { action: "closed" },
    bad: { action: "invalid_action" },
  },
  memory_context: {
    good: {},
    bad: { includeStats: "yes" },
  },
  memory_workspace: {
    good: { action: "list" },
    bad: { action: "invalid_action" },
  },
  memory_suggest_topic_key: {
    good: { subject: "Auth Strategy", body: "Use JWT rotation" },
    bad: { subject: 123 }, // wrong type — subject must be a string
  },
};

// ── sanity: fixture table covers the real registry ───────────────────────────

describe("G1 MCP tool contract — Zod I/O assertions", () => {
  it("fixture table covers EVERY registered tool (drift guard)", () => {
    const registeredNames = new Set(REGISTRY.keys());
    const fixtureNames = new Set(Object.keys(FIXTURES));

    for (const name of registeredNames) {
      expect(
        fixtureNames.has(name),
        `Registered tool '${name}' has no fixture in FIXTURES table — add a { good, bad } entry`
      ).toBe(true);
    }
    for (const name of fixtureNames) {
      expect(
        registeredNames.has(name),
        `FIXTURES table has '${name}' but that tool is NOT registered — remove the stale entry`
      ).toBe(true);
    }

    expect(fixtureNames.size).toBe(MCP_TOOL_COUNT);
    expect(registeredNames.size).toBe(MCP_TOOL_COUNT);
  });

  it("all tools are registered under memory_* names", () => {
    for (const name of REGISTRY.keys()) {
      expect(name).toMatch(/^memory_[a-z_]+$/);
    }
  });

  // Table-driven: one describe block per tool, asserting good + bad parse
  describe.each([...REGISTRY.entries()])("%s", (toolName, captured) => {
    const fields = captured.inputSchema;
    const schema = z.object(fields);
    const fixture = FIXTURES[toolName];

    it("good input parses successfully", () => {
      if (!fixture) return; // guarded above; this silences TS
      const result = schema.safeParse(fixture.good);
      expect(
        result.success,
        `${toolName}: good input ${JSON.stringify(fixture.good)} should parse but got: ${
          result.success ? "" : JSON.stringify((result as { error: unknown }).error)
        }`
      ).toBe(true);
    });

    it("bad input is rejected", () => {
      if (!fixture) return;
      // Special case: memory_status has an empty inputSchema — any value parses
      // because z.object({}) is maximally permissive. Instead of asserting a
      // false rejection we simply confirm the schema is empty and skip the bad check.
      if (Object.keys(fields).length === 0) {
        expect(Object.keys(fields)).toHaveLength(0); // documents the no-schema case
        return;
      }
      const result = schema.safeParse(fixture.bad);
      expect(
        result.success,
        `${toolName}: bad input ${JSON.stringify(fixture.bad)} should fail but parsed successfully`
      ).toBe(false);
    });
  });
});
