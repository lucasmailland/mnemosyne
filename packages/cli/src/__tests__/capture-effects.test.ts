/**
 * The real side: what actually gets written, and what deliberately does not.
 *
 * Each of these runs against a scratch home, so they exercise the shipped code
 * rather than a mock of it — which matters here, because every bug this change
 * fixes was in the part that touched the filesystem.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installCodexPlugin, installHostArtifacts, liveGateFor } from "../capture-effects.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "mnemo-capture-effects-"));
  dirs.push(home);
  return home;
}

/** The plugin payload this build would install from. */
const PLUGIN_DIR = join(import.meta.dirname, "..", "..", "..", "plugin");

describe("the live gate answers whether capture can exist here at all", () => {
  it("reports Windows as unavailable, not merely degraded", () => {
    const home = scratchHome();
    // `mcp-only` would promise a manifest that can never fire on this platform.
    expect(liveGateFor("codex", { home, platform: "win32" })).toMatchObject({
      mode: "unavailable",
    });
  });

  it("reports a missing config.toml as the gate being off", () => {
    const home = scratchHome();
    expect(liveGateFor("codex", { home, platform: "darwin" })).toMatchObject({
      mode: "mcp-only",
      reason: expect.stringContaining("features.hooks"),
    });
  });

  it("reads an enabled gate as full", () => {
    const home = scratchHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
    expect(liveGateFor("codex", { home, platform: "darwin" })).toMatchObject({ mode: "full" });
  });

  it("does not read a nested table's hooks key as this one's", () => {
    const home = scratchHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      "[features]\nother = true\n\n[features.experimental]\nhooks = true\n"
    );
    expect(liveGateFor("codex", { home, platform: "darwin" })).toMatchObject({ mode: "mcp-only" });
  });

  it("treats an unparseable config as no evidence, and says which", () => {
    const home = scratchHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features\nhooks = true\n");
    expect(liveGateFor("codex", { home, platform: "darwin" })).toMatchObject({
      mode: "mcp-only",
      reason: expect.stringContaining("could not be parsed"),
    });
  });

  it("does not gate the hosts that have no gate", () => {
    const home = scratchHome();
    for (const host of ["opencode", "claude-code"] as const) {
      expect(liveGateFor(host, { home, platform: "darwin" })).toMatchObject({ mode: "full" });
    }
  });
});

describe("OpenCode's plugin entry", () => {
  it("adds the plugin to an existing config without disturbing it", async () => {
    const home = scratchHome();
    const configDir = join(home, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "opencode.json"),
      '{\n  // keep me\n  "theme": "dark",\n  "plugin": ["./other.ts"]\n}\n'
    );

    const result = await installHostArtifacts("opencode", { home, pluginDir: PLUGIN_DIR });

    expect(result.status).toBe("installed");
    const after = readFileSync(join(configDir, "opencode.json"), "utf8");
    expect(after).toContain("// keep me");
    expect(after).toContain("./other.ts");
    expect(after).toContain("mnemosyne.ts");
  });

  it("refuses when there is no config to add the plugin to", async () => {
    const home = scratchHome();
    const result = await installHostArtifacts("opencode", { home, pluginDir: PLUGIN_DIR });
    expect(result).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("no opencode.json"),
    });
  });

  it("is idempotent", async () => {
    const home = scratchHome();
    const configDir = join(home, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "opencode.json"), "{}\n");

    await installHostArtifacts("opencode", { home, pluginDir: PLUGIN_DIR });
    const second = await installHostArtifacts("opencode", { home, pluginDir: PLUGIN_DIR });
    expect(second.status).toBe("already-installed");
  });
});

describe("Claude Code's manifest is verified, never written twice", () => {
  /** What `claude plugin install` (and `--local`) leave behind: a registry entry and its payload. */
  function registerPlugin(home: string, withManifest = true): string {
    const installPath = join(
      home,
      ".claude",
      "plugins",
      "cache",
      "mnemosyne",
      "mnemosyne",
      "0.3.1"
    );
    if (withManifest) {
      mkdirSync(join(installPath, "hooks"), { recursive: true });
      writeFileSync(join(installPath, "hooks", "hooks.json"), "{}");
    }
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "mnemosyne@mnemosyne": [{ scope: "user", installPath, version: "0.3.1" }] },
      })
    );
    return join(installPath, "hooks", "hooks.json");
  }

  it("reports the manifest where Claude Code's plugin manager installed it", async () => {
    const home = scratchHome();
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    const manifest = registerPlugin(home);

    const result = await installHostArtifacts("claude-code", { home, pluginDir: PLUGIN_DIR });
    expect(result).toEqual({ status: "already-installed", path: manifest });
  });

  it("does not count a registry entry whose payload has no hook manifest", async () => {
    const home = scratchHome();
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    registerPlugin(home, false);

    const result = await installHostArtifacts("claude-code", { home, pluginDir: PLUGIN_DIR });
    expect(result).toMatchObject({ status: "failed" });
  });

  it("does not count a manifest Claude Code never loads (an unregistered copy)", async () => {
    // The path this check used to read. No install mode writes it, so a manifest
    // there proves nothing, and requiring it refused every real install.
    const home = scratchHome();
    const stray = join(home, ".claude", "plugins", "mnemosyne", "hooks");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "hooks.json"), "{}");

    const result = await installHostArtifacts("claude-code", { home, pluginDir: PLUGIN_DIR });
    expect(result).toMatchObject({ status: "failed" });
  });

  it("says what to do when the plugin is not installed, rather than writing a second copy", async () => {
    const home = scratchHome();
    const result = await installHostArtifacts("claude-code", { home, pluginDir: PLUGIN_DIR });
    expect(result).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("plugin is not installed"),
    });
  });
});

describe("Codex is installed the way Codex installs plugins", () => {
  /** Records what would have been asked of the `codex` binary. */
  function runner(results: Array<{ status: number | null; output: string }>) {
    const calls: string[][] = [];
    let index = 0;
    return {
      calls,
      run: (args: string[]) => {
        calls.push(args);
        return results[index++] ?? { status: 0, output: "" };
      },
    };
  }

  const ok = { status: 0, output: "" };

  it("stages a marketplace source and asks codex to install from it", () => {
    const home = scratchHome();
    const { calls, run } = runner([ok, ok]);

    const result = installCodexPlugin({ home, pluginDir: PLUGIN_DIR }, run);

    expect(result.status).toBe("installed");
    // The sanctioned route, and the same shape the Claude Code branch uses.
    expect(calls[0]?.slice(0, 3)).toEqual(["plugin", "marketplace", "add"]);
    // Qualified with the marketplace: Codex refuses a bare name whenever more
    // than one marketplace is configured, and it always is — it ships its own.
    expect(calls[1]).toEqual(["plugin", "add", "mnemosyne@mnemosyne-local"]);
  });

  it("lays the plugin out where a real Codex plugin lives", () => {
    const home = scratchHome();
    const { run } = runner([ok, ok]);
    installCodexPlugin({ home, pluginDir: PLUGIN_DIR }, run);

    // Read off a working third-party plugin, not guessed: a marketplace root
    // holds plugins/<name>/, and the hook manifest is hooks/hooks.json.
    const root = join(home, ".mnemo", "codex-marketplace");
    // Codex refuses a source without this file outright: "marketplace root does
    // not contain a supported manifest". Verified against the real binary.
    expect(existsSync(join(root, ".agents", "plugins", "marketplace.json"))).toBe(true);
    const plugin = join(root, "plugins", "mnemosyne");
    expect(existsSync(join(plugin, ".codex-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(plugin, "hooks", "hooks.json"))).toBe(true);
    expect(existsSync(join(plugin, "scripts", "harness-hook.sh"))).toBe(true);
  });

  it("stages the skills its manifest declares, and the runtime locator (APP-035b)", () => {
    const home = scratchHome();
    const { run } = runner([ok, ok]);
    installCodexPlugin({ home, pluginDir: PLUGIN_DIR }, run);

    const plugin = join(home, ".mnemo", "codex-marketplace", "plugins", "mnemosyne");
    // .codex-plugin/plugin.json says "skills": "./skills/"; a declared directory
    // that is not there is a plugin Codex loads without its skills.
    const declared = JSON.parse(
      readFileSync(join(plugin, ".codex-plugin", "plugin.json"), "utf8")
    ) as { skills?: string };
    expect(declared.skills).toBe("./skills/");
    expect(existsSync(join(plugin, "skills", "memory", "SKILL.md"))).toBe(true);
    // Hooks run with a PATH that may lack the npm bin directory: harness-hook.sh
    // reads the node binary and CLI entry from here, as for Claude Code.
    const locator = join(plugin, ".mnemo-runtime.json");
    expect(JSON.parse(readFileSync(locator, "utf8"))).toMatchObject({
      node: process.execPath,
      cli: expect.stringMatching(/index\.js$/),
    });
    expect(statSync(locator).mode & 0o077).toBe(0);
  });

  it("leaves ${PLUGIN_ROOT} for Codex to expand, because Codex expands it", () => {
    const home = scratchHome();
    const { run } = runner([ok, ok]);
    installCodexPlugin({ home, pluginDir: PLUGIN_DIR }, run);

    const manifest = readFileSync(
      join(home, ".mnemo", "codex-marketplace", "plugins", "mnemosyne", "hooks", "hooks.json"),
      "utf8"
    );
    expect(manifest).toContain("${PLUGIN_ROOT}");
    expect(manifest).toContain("--host codex");
  });

  it("keeps the hook scripts executable", () => {
    const home = scratchHome();
    const { run } = runner([ok, ok]);
    installCodexPlugin({ home, pluginDir: PLUGIN_DIR }, run);

    // npm publish strips the bit from anything not declared in `bin`, and a hook
    // that cannot execute is a hook that silently never runs.
    const script = join(
      home,
      ".mnemo",
      "codex-marketplace",
      "plugins",
      "mnemosyne",
      "scripts",
      "harness-hook.sh"
    );
    expect(statSync(script).mode & 0o111).not.toBe(0);
  });

  it("tolerates a marketplace that was already added", () => {
    const home = scratchHome();
    const { run } = runner([{ status: 1, output: "marketplace already configured" }, ok]);
    // The second run of an installer is the normal case, not an error.
    expect(installCodexPlugin({ home, pluginDir: PLUGIN_DIR }, run).status).toBe("installed");
  });

  it("reports an already-installed plugin as such", () => {
    const home = scratchHome();
    const { run } = runner([ok, { status: 1, output: "plugin mnemosyne is already installed" }]);
    expect(installCodexPlugin({ home, pluginDir: PLUGIN_DIR }, run).status).toBe(
      "already-installed"
    );
  });

  it("reports a real failure with what codex said", () => {
    const home = scratchHome();
    const { run } = runner([ok, { status: 1, output: "no such marketplace\nmore detail" }]);
    const result = installCodexPlugin({ home, pluginDir: PLUGIN_DIR }, run);
    expect(result).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("no such marketplace"),
    });
  });

  it("reports a missing codex binary rather than claiming success", () => {
    const home = scratchHome();
    const { run } = runner([{ status: null, output: "spawnSync codex ENOENT" }]);
    const result = installCodexPlugin({ home, pluginDir: PLUGIN_DIR }, run);
    expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("ENOENT") });
  });

  it("does not ask codex for anything when the payload cannot be staged", () => {
    const home = scratchHome();
    const { calls, run } = runner([ok, ok]);
    const result = installCodexPlugin({ home, pluginDir: join(home, "nonexistent") }, run);

    expect(result.status).toBe("failed");
    expect(calls).toEqual([]);
  });
});

describe("a build with no plugin payload configures nothing", () => {
  it.each(["opencode", "claude-code", "codex"] as const)("refuses for %s", async (host) => {
    const home = scratchHome();
    const result = await installHostArtifacts(host, { home, pluginDir: null });
    expect(result).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("plugin payload could not be located"),
    });
  });
});
