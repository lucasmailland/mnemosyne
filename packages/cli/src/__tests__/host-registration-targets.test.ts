import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * P73 — every host we claim to support must be written where that host reads.
 *
 * Three registrations were silent no-ops, all the same shape as P64: we say we
 * support a host, the code does something adjacent, and nothing notices.
 *
 *   - Codex was written to `~/.codex/config.json` with an `mcpServers` object.
 *     Codex reads `~/.codex/config.toml` with `[mcp_servers.<id>]` tables.
 *     Wrong file AND wrong format.
 *   - Gemini's manifest went to `~/.gemini/`; the CLI discovers extensions in
 *     `~/.gemini/extensions/<name>/`. The manifest also declared no
 *     `mcpServers` at all, so even in the right place it registered nothing.
 *   - Windsurf was detected and had no `case` in the install switch, so it fell
 *     to `default:` — and the run still ended with "installed for all detected
 *     agents", because `hadFailures` was set only by the claude-code branch.
 *
 * The expectations below come from each host's own documentation, not from our
 * source. That is the point: this file is where the two are made to agree, so
 * "we support host X" stops being a claim nobody checks.
 */

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "commands.ts"),
  "utf8"
);

/**
 * What each host actually reads, split by where the assertion belongs:
 *   `dir`  — the configDir in the detection registry (a path).
 *   `body` — filenames and format markers inside that host's `case` block.
 * Conflating the two is how the first version of this test failed on
 * `claude-code`, whose case body never mentions `.claude` — it uses
 * `agent.configDir`, which is exactly the right thing to do.
 *
 * Update only against that host's own documentation.
 */
const HOST_TARGETS: Record<string, { dir: string; body: string[]; rejects?: string[] }> = {
  "claude-code": { dir: '".claude"', body: [] },
  // P73 — Cursor stopped being the degraded host. Its branch must write BOTH
  // `mcp.json` (tools) and `hooks.json` (session start/end). Pinning the hooks
  // file here is the point: an install that quietly stops writing it leaves
  // Cursor with tools and no memory lifecycle, which looks like it works.
  // P73 — Cursor stopped being the degraded host. Its branch must write BOTH
  // `mcp.json` (tools) and `hooks.json` (session start/end). Pinning the hooks
  // file here is the point: an install that quietly stops writing it leaves
  // Cursor with tools and no memory lifecycle, which looks like it works.
  //
  // The needle is the full `join(...)` expression, not the bare filename:
  // `"hooks.json"` alone is a substring of `"cursor-hooks.json"` (the template
  // we READ), so it would match even if the file we WRITE were renamed away.
  // Verified by mutation — the bare-filename version passed against a branch
  // writing `DISABLED.json`.
  cursor: {
    dir: '".cursor"',
    body: [
      'join(agent.configDir, "mcp.json")',
      'join(agent.configDir, "hooks.json")',
      'join(pluginDir, "hooks", "cursor-hooks.json")',
    ],
  },
  opencode: { dir: '".config", "opencode"', body: [] },
  codex: {
    dir: '".codex"',
    // TOML tables, not a JSON object. The tables themselves are written by
    // `registerCodexMcpServer`, whose output codex-mcp-registration.test.ts
    // checks by running it — the needle here only pins that the case calls it.
    body: ['join(agent.configDir, "config.toml")', "registerCodexMcpServer("],
    rejects: ['join(agent.configDir, "config.json")'],
  },
  "gemini-cli": {
    dir: '".gemini"',
    body: ['"extensions", "mnemosyne"'],
  },
  windsurf: { dir: '".codeium", "windsurf"', body: ["mcp_config.json"] },
};

/**
 * The install switch, sliced out once.
 *
 * Anchored on `default:` and not on the "Manual config required" message: the
 * windsurf case QUOTES that message in its own comment, so the first version of
 * this test cut the switch short at that comment and reported windsurf as not
 * writing a file it plainly writes. A boundary that any case body can
 * accidentally contain is not a boundary.
 */
const installSwitch = (() => {
  const start = SOURCE.indexOf('case "claude-code": {');
  const end = SOURCE.indexOf("\n        default:", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
})();

describe("P73 — host registration targets", () => {
  it("each host's configDir is the directory that host reads", () => {
    const wrong = Object.entries(HOST_TARGETS)
      .filter(([, t]) => !SOURCE.includes(`join(home, ${t.dir})`))
      .map(([host, t]) => `${host}: configDir is not join(home, ${t.dir})`);
    expect(wrong).toEqual([]);
  });

  it("every detected host has a case in the install switch", () => {
    // A detected host with no case falls to `default:` and is not installed.
    const missing = Object.keys(HOST_TARGETS).filter(
      (host) => !installSwitch.includes(`case "${host}":`)
    );
    expect(missing).toEqual([]);
  });

  it("writes each host's config where that host reads it", () => {
    const wrong: string[] = [];
    for (const [host, target] of Object.entries(HOST_TARGETS)) {
      const caseStart = installSwitch.indexOf(`case "${host}":`);
      if (caseStart === -1) continue;
      const nextCase = installSwitch.indexOf('case "', caseStart + 10);
      const body = installSwitch.slice(caseStart, nextCase === -1 ? undefined : nextCase);
      for (const needle of target.body) {
        if (!body.includes(needle)) wrong.push(`${host}: expected to write ${needle}`);
      }
      for (const needle of target.rejects ?? []) {
        if (body.includes(needle)) wrong.push(`${host}: still writes ${needle}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("a host that cannot be configured is reported as a FAILURE, not a success", () => {
    // The real bug was not the missing case — it was that the run ended with
    // "installed for all detected agents" regardless. A partial install that
    // announces success gives the user no reason to look.
    const tail = SOURCE.slice(SOURCE.indexOf("Manual config required") - 400);
    expect(tail).toContain("hadFailures = true");
    // …and the catch-all must mark it too: an exception mid-host left the
    // summary claiming success just as loudly.
    const catchBlock = SOURCE.slice(
      SOURCE.indexOf("Manual config required"),
      SOURCE.indexOf("Also update workspaces.json")
    );
    expect(catchBlock).toContain("hadFailures = true");
  });

  it("the Gemini manifest declares the MCP server it is supposed to register", () => {
    // The extension can be in exactly the right directory and still register
    // nothing. This is the half that made the path fix necessary but not
    // sufficient.
    const manifest = JSON.parse(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "..",
          "..",
          "..",
          "plugin",
          "gemini-extension.json"
        ),
        "utf8"
      )
    ) as { mcpServers?: Record<string, unknown> };
    expect(manifest.mcpServers).toBeDefined();
    expect(Object.keys(manifest.mcpServers!)).toContain("mnemosyne");
  });

  it("APP-055 — host manifests carry the repo's license and the real tool count", () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    const json = (path: string) =>
      JSON.parse(readFileSync(join(repo, path), "utf8")) as Record<string, unknown>;
    const repoLicense = json("package.json")["license"];
    expect(repoLicense).toBe("Apache-2.0");
    for (const host of [".claude-plugin", ".codex-plugin", ".cursor-plugin"]) {
      expect(json(`packages/plugin/${host}/plugin.json`)["license"], host).toBe(repoLicense);
    }
    const marketplace = readFileSync(join(repo, ".claude-plugin", "marketplace.json"), "utf8");
    expect(marketplace).toContain("all 37 memory tools");
    expect(marketplace).not.toContain("14 MCP tools");
  });
});
