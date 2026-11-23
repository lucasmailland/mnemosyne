import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { MCP_INSTRUCTIONS } from "../instructions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_MD_PATH = resolve(HERE, "../../../plugin/skills/memory/SKILL.md");
const GEMINI_MD_PATH = resolve(HERE, "../../../plugin/GEMINI.md");

describe("P30 — MCP instructions handshake", () => {
  it("exports a non-empty, well-structured MCP_INSTRUCTIONS string", () => {
    expect(MCP_INSTRUCTIONS).toContain("Mnemosyne Memory Protocol");
    expect(MCP_INSTRUCTIONS).toContain("Recall First");
    expect(MCP_INSTRUCTIONS).toContain("Proactive Save Triggers");
    expect(MCP_INSTRUCTIONS).toContain("memory_recall");
    expect(MCP_INSTRUCTIONS).toContain("memory_remember");
    expect(MCP_INSTRUCTIONS).toContain("memory_episode_start");
    expect(MCP_INSTRUCTIONS).toContain("memory_episode_end");
    expect(MCP_INSTRUCTIONS).toContain('scope: "global"');
    expect(MCP_INSTRUCTIONS).toContain('scope: "personal"');
    expect(MCP_INSTRUCTIONS).toContain("scopeRef:");
    expect(MCP_INSTRUCTIONS).not.toContain('scope: "workspace"');
  });

  it("fits the ~2 KB a host shows of server instructions, must-knows first (audit 2026-11-22)", () => {
    // Claude Code truncates server instructions near 2 KB: anything past it
    // never reaches the model, so the whole protocol has to fit.
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
    // Recall is conditional: the plugin hook already injected the top hits.
    expect(MCP_INSTRUCTIONS).toMatch(/no injected <untrusted_memory>[^.]*memory_recall/);
    expect(MCP_INSTRUCTIONS).not.toMatch(/on the first turn/i);
    const at = (needle: string) => MCP_INSTRUCTIONS.indexOf(needle);
    for (const needle of ["memory_recall", "one claim", "memory_remember", "sessionId", "Workspace Identity"])
      expect(at(needle), needle).toBeGreaterThanOrEqual(0);
    expect(at("memory_recall")).toBeLessThan(at("one claim"));
  });

  it("says every tool is served by default and MNEMO_MCP_TOOLS=core trims to 9 (owner, 2026-11-22)", () => {
    expect(MCP_INSTRUCTIONS).toContain("MNEMO_MCP_TOOLS=core");
    expect(MCP_INSTRUCTIONS).not.toContain("MNEMO_MCP_TOOLS=full");
    expect(MCP_INSTRUCTIONS).not.toContain("(full profile)");
  });

  it("returns instructions field during MCP protocol initialization handshake", async () => {
    const server = new McpServer(
      { name: "mnemosyne-test", version: "1.0.0" },
      {
        capabilities: { tools: {} },
        instructions: MCP_INSTRUCTIONS,
      }
    );

    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const connectPromise = Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    await connectPromise;

    // Verify instructions received in client initialization result
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);

    await client.close();
    await server.close();
  });
});

describe("M4 — Workspace Identity rules mirrored across instructions.ts / SKILL.md / GEMINI.md", () => {
  // instructions.ts's own file header mandates keeping the behavioral rules
  // in sync with SKILL.md (mirrored, by design, into GEMINI.md too). This
  // test asserts the 3 core Workspace Identity rules (fixed for the
  // session, role is the real ceiling, 403 != retry) show up in all three,
  // not that the prose matches word-for-word.
  const skillMd = readFileSync(SKILL_MD_PATH, "utf8");
  const geminiMd = readFileSync(GEMINI_MD_PATH, "utf8");

  it("all three mention the workspace-is-fixed-for-the-session rule", () => {
    for (const [name, text] of [
      ["instructions.ts", MCP_INSTRUCTIONS],
      ["SKILL.md", skillMd],
      ["GEMINI.md", geminiMd],
    ] as const) {
      expect(text, `${name} should document Workspace Identity`).toMatch(
        /[Ww]orkspace [Ii]dentity/
      );
      expect(text, `${name} should state the workspace is fixed for the session`).toMatch(
        /fixed for (the|the whole|the entire|the ENTIRE) session/
      );
    }
  });

  it("all three document the role ceiling (read/write/admin)", () => {
    for (const [name, text] of [
      ["instructions.ts", MCP_INSTRUCTIONS],
      ["SKILL.md", skillMd],
      ["GEMINI.md", geminiMd],
    ] as const) {
      expect(text, `${name} should mention role read`).toMatch(/read/);
      expect(text, `${name} should mention role write`).toMatch(/write/);
      expect(text, `${name} should mention role admin`).toMatch(/admin/);
    }
  });

  it("all three tell the agent not to retry a role-caused 403", () => {
    for (const [name, text] of [
      ["instructions.ts", MCP_INSTRUCTIONS],
      ["SKILL.md", skillMd],
      ["GEMINI.md", geminiMd],
    ] as const) {
      expect(text, `${name} should mention 403`).toContain("403");
      expect(text, `${name} should mention memory_context as the diagnostic tool`).toContain(
        "memory_context"
      );
    }
  });
});

describe("managed sessions suppress duplicate episode bookkeeping", () => {
  const skillMd = readFileSync(SKILL_MD_PATH, "utf8");
  const geminiMd = readFileSync(GEMINI_MD_PATH, "utf8");
  const surfaces: Array<[string, string]> = [
    ["instructions.ts", MCP_INSTRUCTIONS],
    ["SKILL.md", skillMd],
    ["GEMINI.md", geminiMd],
  ];

  it("all three name the managed marker", () => {
    for (const [name, text] of surfaces) {
      expect(text, `${name} must name the managed marker`).toMatch(/mnemo-managed-v1/i);
    }
  });

  it("all three say a managed session does not need episode start/end", () => {
    for (const [name, text] of surfaces) {
      // Without this, every managed session gets a second, duplicate episode
      // opened and closed by tool call on top of the one the harness collapses.
      expect(text.toLowerCase(), `${name} must suppress duplicate episodes`).toMatch(
        /do not call `?memory_episode_start|no need to call `?memory_episode_start|skip `?memory_episode_start/
      );
    }
  });

  it("all three still require provenance on explicit writes", () => {
    for (const [name, text] of surfaces) {
      // Suppressing the episode calls must not become "stop passing sessionId":
      // a fact written without it is permanently context-orphaned.
      expect(text, `${name} must keep provenance on explicit writes`).toMatch(/sessionId/);
    }
  });

  it("all three warn that an unvalidated marker must not be trusted", () => {
    for (const [name, text] of surfaces) {
      expect(text.toLowerCase(), `${name} must warn about forged markers`).toMatch(
        /forge|do not invent|never write it yourself|only the harness/
      );
    }
  });
});

describe("every injected protocol copy agrees about managed sessions", () => {
  const SURFACES = [
    "packages/mcp/src/instructions.ts",
    "packages/plugin/skills/memory/SKILL.md",
    "packages/plugin/GEMINI.md",
  ];

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

  it("no surface tells a managed session to open an episode anyway", () => {
    // packages/cli/plugin, the copy a user installs, is generated from
    // packages/plugin on every CLI build (not versioned), so the sources are
    // what can drift. One that did would keep instructing agents to open a
    // duplicate episode for a conversation the harness already collapses.
    for (const relative of SURFACES) {
      const text = readFileSync(join(repoRoot, relative), "utf8");
      expect(text, `${relative} must name the managed marker`).toContain("mnemo-managed-v1");
      expect(text.toLowerCase(), `${relative} must suppress duplicate episodes`).toMatch(
        /do not call `?memory_episode_start|no need to call `?memory_episode_start|skip `?memory_episode_start/
      );
    }
  });
});

describe("every injected protocol copy asks for the fact subtype", () => {
  // `memory_remember` stores a fact without `subtype` as `other`, and no
  // protocol surface ever asked for one: on one production stack 193 of 344 facts
  // written by agents were `other`, most of them fixes, configs and designs.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const SURFACES = [
    "packages/mcp/src/instructions.ts",
    "packages/plugin/skills/memory/SKILL.md",
    "packages/plugin/GEMINI.md",
    // _hook-output.sh no longer repeats the protocol (audit 2026-11-22): in
    // Claude Code these instructions deliver it, once.
  ];
  const AGENT_KINDS = ["architecture", "bugfix", "config", "discovery", "policy", "process"];

  it.each(SURFACES)("%s tells the agent to send subtype with the agent kinds", (relative) => {
    const text = readFileSync(join(repoRoot, relative), "utf8");
    expect(text, `${relative} must ask for subtype`).toMatch(/\bsubtype\b/);
    for (const kind of AGENT_KINDS) {
      expect(text, `${relative} must offer subtype ${kind}`).toMatch(new RegExp(`\\b${kind}\\b`));
    }
    expect(text, `${relative} must say other is the last resort`).toMatch(
      /other[`"']? (only|is the last resort)|only when no(ne| other)/i
    );
  });
});
