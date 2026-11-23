/**
 * Round-2 audit — five host configs that receive `MNEMO_KEY` (Claude Desktop,
 * Cursor, OpenCode, Gemini, Windsurf) were written with a bare `writeFileSync`:
 * the process umask decided the mode (0644 on a default machine, so every local
 * account could read the key), a crash mid-write truncated the host's config,
 * and an unparseable file was silently replaced with `{}` plus our entry.
 *
 * Codex already went through the atomic 0600 writer; these now share it. And a
 * config kept in a dotfiles repo behind a symlink is followed to its target and
 * replaced there, with the link left in place — the atomic writer refusing every
 * symlink had turned `~/.codex/config.toml -> ~/dotfiles/...` into a failed
 * install.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { FAKE_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  return { FAKE_HOME: fs.mkdtempSync(os.tmpdir() + "/mnemo-secret-cfg-home-") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => FAKE_HOME };
});

import { main } from "../index.js";
import { ConfigNotJsonError, writeSecretJsonConfig } from "../atomic-file.js";
import { enableCodexHooks, registerCodexMcpServer } from "../codex-config.js";

const KEY = "mns_test_SECRETCFG";
const mode = (p: string) => statSync(p).mode & 0o777;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "mnemo-secret-cfg-"));
}

describe("writeSecretJsonConfig", () => {
  it("creates a new config 0600", () => {
    const path = join(scratch(), "nested", "mcp.json");
    writeSecretJsonConfig(path, (c) => {
      c.mcpServers = { mnemosyne: { env: { MNEMO_KEY: KEY } } };
    });
    expect(mode(path)).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.mnemosyne.env.MNEMO_KEY).toBe(KEY);
  });

  it("narrows an existing world-readable config to 0600 and keeps every other key", () => {
    const path = join(scratch(), "mcp.json");
    writeFileSync(path, JSON.stringify({ theme: "dark", mcpServers: { other: { a: 1 } } }), {
      mode: 0o644,
    });
    writeSecretJsonConfig(path, (c) => {
      (c.mcpServers as Record<string, unknown>).mnemosyne = { env: { MNEMO_KEY: KEY } };
    });
    expect(mode(path)).toBe(0o600);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.theme).toBe("dark");
    expect(written.mcpServers.other).toEqual({ a: 1 });
    expect(written.mcpServers.mnemosyne.env.MNEMO_KEY).toBe(KEY);
  });

  it("follows a symlink to its target and leaves the link in place", () => {
    const dir = scratch();
    const real = join(dir, "dotfiles.json");
    const link = join(dir, "mcp.json");
    writeFileSync(real, JSON.stringify({ keep: true }));
    symlinkSync(real, link);
    writeSecretJsonConfig(link, (c) => {
      c.added = KEY;
    });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ keep: true, added: KEY });
    expect(mode(real)).toBe(0o600);
  });

  it("refuses to rewrite a file that is not JSON, and leaves it as it was", () => {
    const path = join(scratch(), "mcp.json");
    writeFileSync(path, "{ not json");
    expect(() => writeSecretJsonConfig(path, () => {})).toThrow(ConfigNotJsonError);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});

describe("registerCodexMcpServer through a dotfiles symlink", () => {
  it("writes the link's target atomically and keeps the link", () => {
    const dir = scratch();
    const real = join(dir, "dotfiles.toml");
    const link = join(dir, "config.toml");
    writeFileSync(real, 'model = "o3"\n');
    symlinkSync(real, link);
    const result = registerCodexMcpServer({
      configPath: link,
      server: { command: "npx", args: ["-y", "@mnemo-ai/mcp"], url: "http://x", key: KEY },
    });
    expect(result.status).toBe("installed");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const text = readFileSync(real, "utf8");
    expect(text).toContain('model = "o3"');
    expect(text).toContain(KEY);
    expect(mode(real)).toBe(0o600);
  });
});

describe("enableCodexHooks through a dotfiles symlink", () => {
  it("turns hooks on in the link's target and keeps the link", () => {
    const dir = scratch();
    const real = join(dir, "dotfiles.toml");
    const link = join(dir, "config.toml");
    writeFileSync(real, 'model = "o3"\n');
    symlinkSync(real, link);
    expect(enableCodexHooks({ configPath: link }).status).toBe("installed");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toMatch(/hooks = true/);
  });
});

// ── mnemo install, end to end against a scratch HOME ────────────────────────

const CURSOR = join(FAKE_HOME, ".cursor", "mcp.json");
const OPENCODE = join(FAKE_HOME, ".config", "opencode", "opencode.json");
const WINDSURF = join(FAKE_HOME, ".codeium", "windsurf", "mcp_config.json");
const GEMINI = join(FAKE_HOME, ".gemini", "extensions", "mnemosyne", "gemini-extension.json");

function seedHome(): void {
  rmSync(FAKE_HOME, { recursive: true, force: true });
  mkdirSync(join(FAKE_HOME, ".mnemo"), { recursive: true });
  writeFileSync(
    join(FAKE_HOME, ".mnemo", "config.json"),
    JSON.stringify({ url: "http://localhost:3939", apiKey: KEY })
  );
  for (const path of [CURSOR, OPENCODE, WINDSURF]) {
    mkdirSync(join(path, ".."), { recursive: true });
  }
  mkdirSync(join(FAKE_HOME, ".gemini"), { recursive: true });
  const other = { other: { command: "x" } };
  writeFileSync(CURSOR, JSON.stringify({ mcpServers: other }), { mode: 0o644 });
  writeFileSync(WINDSURF, JSON.stringify({ mcpServers: other }), { mode: 0o644 });
  writeFileSync(OPENCODE, JSON.stringify({ theme: "x", mcp: other }), { mode: 0o644 });
}

async function runInstall(): Promise<string> {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  delete process.env["MNEMO_URL"];
  delete process.env["MNEMO_KEY"];
  process.argv = ["node", "mnemo", "install"];
  const logs: string[] = [];
  const capture = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  const spies = [
    vi.spyOn(console, "log").mockImplementation(capture),
    vi.spyOn(console, "warn").mockImplementation(capture),
    vi.spyOn(console, "error").mockImplementation(capture),
  ];
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((c?: string | number | null) => {
    throw new Error(`exit:${c}`);
  }) as (c?: string | number | null) => never);
  vi.stubGlobal("fetch", (async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ workspaceId: "dcb01cb3-97da-410f-a074-d81bea9eb7b1" }),
    text: async () => "{}",
  })) as unknown as typeof fetch);
  try {
    await main();
  } catch {
    /* exit throws */
  } finally {
    process.argv = originalArgv;
    process.env = originalEnv;
    for (const spy of spies) spy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllGlobals();
  }
  return logs.join("\n");
}

beforeEach(() => seedHome());
afterAll(() => rmSync(FAKE_HOME, { recursive: true, force: true }));

describe("mnemo install — configs holding the key are 0600", { timeout: 30_000 }, () => {
  it("Cursor, OpenCode, Windsurf and Gemini get 0600 and keep the user's other entries", async () => {
    const out = await runInstall();
    for (const path of [CURSOR, OPENCODE, WINDSURF, GEMINI]) {
      expect(existsSync(path), `${path}\n${out}`).toBe(true);
      expect(readFileSync(path, "utf8"), path).toContain(KEY);
      expect(mode(path).toString(8), path).toBe("600");
    }
    expect(JSON.parse(readFileSync(CURSOR, "utf8")).mcpServers.other).toEqual({ command: "x" });
    expect(JSON.parse(readFileSync(WINDSURF, "utf8")).mcpServers.other).toEqual({ command: "x" });
    const oc = JSON.parse(readFileSync(OPENCODE, "utf8"));
    expect(oc.theme).toBe("x");
    expect(oc.mcp.other).toEqual({ command: "x" });
  });

  it("an unparseable Cursor config is left as it was, and the run says so", async () => {
    writeFileSync(CURSOR, "{ broken");
    const out = await runInstall();
    expect(readFileSync(CURSOR, "utf8")).toBe("{ broken");
    expect(out).toContain(CURSOR);
  });
});
