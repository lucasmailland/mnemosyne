/**
 * cli-install-native-marketplace — Claude Code branch of `mnemo install`.
 *
 * `cmdInstall` itself is excluded from `command-routes.snapshot.json`
 * ("install (skipped)") because it mutates real installed-agent config
 * directories, so coverage lives entirely on the exported, runner-injected
 * helpers instead: `planClaudeCodePluginCommands`, `installClaudeCodePluginNative`,
 * `classifyClaudeCliFailure`, `readInstalledPluginEntry`,
 * `claudeCodePreflight`, and `installClaudeCodePluginLocal`.
 *
 * Deliberately uses a dependency-injected `ClaudeRunner` recorder instead of
 * `vi.mock("node:child_process")` for the orchestration layer above — a
 * repo-wide grep found zero precedent for mocking that module in this
 * codebase (see design decision "injected runner instead of
 * vi.mock('node:child_process')"). The one narrow, deliberate exception is
 * the `runClaudeCli` describe block below: it is the only code that actually
 * shells out to `claude`, so it needs its own scoped `spawnSync` mock — see
 * that block's comment.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  planClaudeCodePluginCommands,
  classifyClaudeCliFailure,
  readInstalledPluginEntry,
  claudeCodePreflight,
  installClaudeCodePluginNative,
  installClaudeCodePluginLocal,
  runClaudeCli,
  cmdInstall,
  type ClaudeResult,
  type ClaudeRunner,
} from "../commands.js";

// Scoped to this file only (Vitest's module registry is per test file):
// replaces `spawnSync` with a `vi.fn()` wrapping the real implementation as
// its default, so every OTHER test in this file (which always injects an
// explicit `ClaudeRunner` recorder) keeps passing unaffected. Only the
// `runClaudeCli` tests below override the return value.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const PLUGIN_ID = "mnemosyne@mnemosyne";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PLUGIN_DIR = join(REPO_ROOT, "packages", "plugin");

function ok(output = ""): ClaudeResult {
  return { status: 0, output };
}
function fail(status: number, output = "", errorCode?: string): ClaudeResult {
  return { status, output, errorCode };
}

/** Records every (argv, timeoutMs) call and replays scripted results in order. */
function makeRecorder(scriptedResults: ClaudeResult[]): {
  run: ClaudeRunner;
  calls: { argv: string[]; timeoutMs: number }[];
} {
  const calls: { argv: string[]; timeoutMs: number }[] = [];
  let i = 0;
  const run: ClaudeRunner = (argv, timeoutMs) => {
    calls.push({ argv, timeoutMs });
    const result = scriptedResults[i] ?? ok();
    i += 1;
    return result;
  };
  return { run, calls };
}

function writeInstalledPluginsJson(
  configDir: string,
  entry: { installPath: string; gitCommitSha?: string } | undefined
): void {
  const pluginsJsonPath = join(configDir, "plugins", "installed_plugins.json");
  mkdirSync(join(configDir, "plugins"), { recursive: true });
  const plugins: Record<string, unknown> = entry
    ? {
        [PLUGIN_ID]: [
          {
            scope: "user",
            installPath: entry.installPath,
            gitCommitSha: entry.gitCommitSha,
            version: "0.1.0",
            installedAt: new Date().toISOString(), // determinism-ok: throwaway fixture date, not asserted
          },
        ],
      }
    : {};
  writeFileSync(pluginsJsonPath, JSON.stringify({ version: 2, plugins }, null, 2));
}

describe("planClaudeCodePluginCommands", () => {
  it("returns the exact 4-step ordered argv sequence", () => {
    const steps = planClaudeCodePluginCommands();
    expect(steps.map((s) => s.argv)).toEqual([
      ["plugin", "marketplace", "add", "lucasmailland/mnemosyne"],
      ["plugin", "marketplace", "update", "mnemosyne"],
      ["plugin", "uninstall", PLUGIN_ID],
      ["plugin", "install", PLUGIN_ID],
    ]);
  });

  it("never enables a shell and never interpolates external input into argv", () => {
    const steps = planClaudeCodePluginCommands();
    for (const step of steps) {
      for (const arg of step.argv) {
        expect(typeof arg).toBe("string");
      }
    }
    // Constants only — the marketplace slug/plugin id never come from
    // process.argv/env, so re-running this is deterministic across machines.
    expect(steps[3].argv).toEqual(["plugin", "install", PLUGIN_ID]);
  });
});

describe("classifyClaudeCliFailure", () => {
  it.each([
    ["authentication failed for repo", undefined, "auth"],
    ["Permission denied (publickey)", undefined, "auth"],
    ["repository not found", undefined, "auth"],
    ["remote: 403 Forbidden", undefined, "auth"],
    ["fatal: could not read from remote repository", undefined, "auth"],
    ["fatal: could not resolve host: github.com", undefined, "network"],
    ["network is unreachable", undefined, "network"],
    ["some dns failure", undefined, "network"],
    ["", "ETIMEDOUT", "network"],
    ["git: command not found", undefined, "git-missing"],
    ["spawn git ENOENT", undefined, "git-missing"],
    ["some completely unrelated output", undefined, "unknown"],
  ] as const)("classifies %j (code=%s) as %s", (output, code, expectedCause) => {
    const result = classifyClaudeCliFailure(output, code);
    expect(result.cause).toBe(expectedCause);
    expect(result.hint.length).toBeGreaterThan(0);
  });

  it("auth cause hint points at --local as an alternative without claiming certainty", () => {
    const { hint } = classifyClaudeCliFailure("repository not found");
    expect(hint).toContain("--local");
    expect(hint.toLowerCase()).toContain("may be");
  });
});

describe("readInstalledPluginEntry", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mnemo-installed-plugins-"));
    dirs.push(dir);
    return dir;
  }

  it("returns null when installed_plugins.json does not exist", () => {
    const configDir = makeConfigDir();
    expect(readInstalledPluginEntry(configDir)).toBeNull();
  });

  it("returns null when the mnemosyne@mnemosyne entry is missing", () => {
    const configDir = makeConfigDir();
    writeInstalledPluginsJson(configDir, undefined);
    expect(readInstalledPluginEntry(configDir)).toBeNull();
  });

  it("returns an entry with an empty gitCommitSha when the field is blank", () => {
    const configDir = makeConfigDir();
    writeInstalledPluginsJson(configDir, { installPath: "/some/path", gitCommitSha: "" });
    const entry = readInstalledPluginEntry(configDir);
    expect(entry).not.toBeNull();
    expect(entry?.gitCommitSha).toBe("");
  });

  it("returns the installPath and gitCommitSha for a valid entry", () => {
    const configDir = makeConfigDir();
    writeInstalledPluginsJson(configDir, { installPath: "/some/path", gitCommitSha: "abc123" });
    const entry = readInstalledPluginEntry(configDir);
    expect(entry).toEqual({ installPath: "/some/path", gitCommitSha: "abc123" });
  });
});

describe("claudeCodePreflight", () => {
  it("is ok when agent.binary is present", () => {
    const result = claudeCodePreflight({ configDir: "/x", detected: true, binary: "claude" });
    expect(result.ok).toBe(true);
    expect(result.message).toBeUndefined();
  });

  it("skips with an actionable message (never throws) when agent.binary is absent", () => {
    expect(() =>
      claudeCodePreflight({ configDir: "/x", detected: true, binary: undefined })
    ).not.toThrow();
    const result = claudeCodePreflight({ configDir: "/x", detected: true, binary: undefined });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("claude");
    expect(result.message).toContain("not on PATH");
  });
});

describe("installClaudeCodePluginNative", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mnemo-native-install-"));
    dirs.push(dir);
    return dir;
  }

  it("invokes the exact 4-command sequence in order via the injected runner", () => {
    const configDir = makeConfigDir();
    writeInstalledPluginsJson(configDir, {
      installPath: join(configDir, "plugins", "cache", "mnemosyne", "mnemosyne"),
      gitCommitSha: "deadbeef",
    });
    const { run, calls } = makeRecorder([ok(), ok(), ok(), ok()]);

    installClaudeCodePluginNative({ configDir, run });

    expect(calls.map((c) => c.argv)).toEqual([
      ["plugin", "marketplace", "add", "lucasmailland/mnemosyne"],
      ["plugin", "marketplace", "update", "mnemosyne"],
      ["plugin", "uninstall", PLUGIN_ID],
      ["plugin", "install", PLUGIN_ID],
    ]);
  });

  it("treats marketplace add/update/uninstall failures as non-fatal — install still runs and can succeed", () => {
    const configDir = makeConfigDir();
    const installPath = join(configDir, "plugins", "cache", "mnemosyne", "mnemosyne");
    writeInstalledPluginsJson(configDir, { installPath, gitCommitSha: "deadbeef" });
    const { run, calls } = makeRecorder([
      fail(1, "already registered"),
      fail(1, "warn: update skipped"),
      fail(1, "no such plugin"),
      ok(),
    ]);

    const result = installClaudeCodePluginNative({ configDir, run });

    expect(calls).toHaveLength(4);
    expect(result.ok).toBe(true);
    expect(result.installPath).toBe(installPath);
  });

  it("fails the branch when the final plugin install step exits non-zero", () => {
    const configDir = makeConfigDir();
    const { run } = makeRecorder([ok(), ok(), ok(), fail(1, "repository not found")]);

    const result = installClaudeCodePluginNative({ configDir, run });

    expect(result.ok).toBe(false);
    expect(result.failure).toBeDefined();
    expect(result.failure).toContain("claude plugin marketplace add lucasmailland/mnemosyne");
    expect(result.failure).toContain("claude plugin install mnemosyne@mnemosyne");
    expect(result.failure).toContain("--local");
  });

  it("surfaces private-repo-possible wording without claiming certainty on an auth-like failure", () => {
    const configDir = makeConfigDir();
    const { run } = makeRecorder([
      fail(1, "fatal: Authentication failed for 'https://github.com/lucasmailland/mnemosyne'"),
      ok(),
      ok(),
      fail(1, "repository not found"),
    ]);

    const result = installClaudeCodePluginNative({ configDir, run });

    expect(result.ok).toBe(false);
    expect(result.failure?.toLowerCase()).toContain("private");
    expect(result.failure).toContain("--local");
  });

  it("treats ETIMEDOUT on the install step as a fatal failure, same as a non-zero exit", () => {
    const configDir = makeConfigDir();
    const { run } = makeRecorder([ok(), ok(), ok(), fail(0, "", "ETIMEDOUT")]);

    const result = installClaudeCodePluginNative({ configDir, run });

    expect(result.ok).toBe(false);
  });

  it("fails when plugin install exits 0 but no installed_plugins.json entry exists", () => {
    const configDir = makeConfigDir();
    const { run } = makeRecorder([ok(), ok(), ok(), ok()]);

    const result = installClaudeCodePluginNative({ configDir, run });

    expect(result.ok).toBe(false);
    expect(result.failure).toContain("installed_plugins.json");
  });

  it("fails when plugin install exits 0 but the entry has an empty gitCommitSha", () => {
    const configDir = makeConfigDir();
    writeInstalledPluginsJson(configDir, {
      installPath: join(configDir, "plugins", "cache", "mnemosyne", "mnemosyne"),
      gitCommitSha: "",
    });
    const { run } = makeRecorder([ok(), ok(), ok(), ok()]);

    const result = installClaudeCodePluginNative({ configDir, run });

    expect(result.ok).toBe(false);
  });

  it("is idempotent — running the sequence twice in succession still converges to ok:true", () => {
    const configDir = makeConfigDir();
    const installPath = join(configDir, "plugins", "cache", "mnemosyne", "mnemosyne");
    writeInstalledPluginsJson(configDir, { installPath, gitCommitSha: "deadbeef" });

    const first = makeRecorder([
      fail(1, "already registered"),
      ok(),
      fail(1, "not installed"),
      ok(),
    ]);
    const firstResult = installClaudeCodePluginNative({ configDir, run: first.run });
    expect(firstResult.ok).toBe(true);

    const second = makeRecorder([fail(1, "already registered"), ok(), ok(), ok()]);
    const secondResult = installClaudeCodePluginNative({ configDir, run: second.run });
    expect(secondResult.ok).toBe(true);
  });
});

describe("installClaudeCodePluginLocal", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeFakePluginDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mnemo-local-plugin-src-"));
    dirs.push(dir);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "hooks"), { recursive: true });
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, "scripts", "session-start.sh"), "#!/bin/bash\necho hi\n");
    writeFileSync(join(dir, "hooks", "hooks.json"), "{}");
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), '{"version":"9.8.7"}');
    return dir;
  }

  it("never references the claude CLI invocation surface (structural mutual-exclusivity guard)", () => {
    // installClaudeCodePluginLocal has no ClaudeRunner parameter at all — it
    // is architecturally incapable of shelling out to `claude plugin ...`.
    // This guard fails loudly if a future refactor accidentally merges the
    // two mutually-exclusive code paths.
    const source = installClaudeCodePluginLocal.toString();
    expect(source).not.toContain("runClaudeCli");
    expect(source).not.toContain("marketplace");
    expect(source).not.toMatch(/plugin["']?\s*,\s*["']install/);
    expect(source).not.toMatch(/plugin["']?\s*,\s*["']uninstall/);
  });

  it("copies plugin files from the working tree into the per-agent plugin cache", () => {
    const pluginDir = makeFakePluginDir();
    const configDir = mkdtempSync(join(tmpdir(), "mnemo-local-config-"));
    dirs.push(configDir);

    const result = installClaudeCodePluginLocal({ pluginDir, configDir });

    expect(result.ok).toBe(true);
    expect(existsSync(join(result.pluginTarget, "hooks", "hooks.json"))).toBe(true);
    expect(existsSync(join(result.pluginTarget, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("forges installed_plugins.json and settings.json.enabledPlugins (dev-install only)", () => {
    const pluginDir = makeFakePluginDir();
    const configDir = mkdtempSync(join(tmpdir(), "mnemo-local-config-"));
    dirs.push(configDir);

    const result = installClaudeCodePluginLocal({ pluginDir, configDir });

    const pluginsData = JSON.parse(
      readFileSync(join(configDir, "plugins", "installed_plugins.json"), "utf8")
    );
    expect(pluginsData.plugins[PLUGIN_ID][0].installPath).toBe(result.pluginTarget);
    expect(pluginsData.plugins[PLUGIN_ID][0].version).toBe("9.8.7");
    expect(result.pluginTarget).toBe(
      join(configDir, "plugins", "cache", "mnemosyne", "mnemosyne", "9.8.7")
    );

    const settingsData = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
    expect(settingsData.enabledPlugins[PLUGIN_ID]).toBe(true);
  });

  it("installs the current plugin manifest version", () => {
    const configDir = mkdtempSync(join(tmpdir(), "mnemo-local-config-"));
    dirs.push(configDir);
    const manifest = JSON.parse(
      readFileSync(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8")
    ) as { version: string };

    const result = installClaudeCodePluginLocal({ pluginDir: PLUGIN_DIR, configDir });
    const installed = JSON.parse(
      readFileSync(join(configDir, "plugins", "installed_plugins.json"), "utf8")
    ) as { plugins: Record<string, Array<{ version: string }>> };

    expect(installed.plugins[PLUGIN_ID]?.[0]?.version).toBe(manifest.version);
    expect(result.pluginTarget).toBe(
      join(configDir, "plugins", "cache", "mnemosyne", "mnemosyne", manifest.version)
    );
  });

  it("prints a development-install warning before and after the copy", () => {
    const pluginDir = makeFakePluginDir();
    const configDir = mkdtempSync(join(tmpdir(), "mnemo-local-config-"));
    dirs.push(configDir);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      installClaudeCodePluginLocal({ pluginDir, configDir });
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes("--local") && w.includes("development"))).toBe(true);
  });
});

describe("runClaudeCli", () => {
  // The only code that actually shells out to the `claude` binary — the
  // orchestration layer above is covered via the injected `ClaudeRunner`
  // recorder, but this function itself needs its own real (scoped) mock of
  // `spawnSync` (see the module-level `vi.mock("node:child_process")` above).
  // This is a narrow, deliberate exception to the "no
  // vi.mock('node:child_process')" convention noted in this file's header
  // comment: it targets this one function only, not the broader
  // orchestration surface.
  beforeEach(() => {
    vi.mocked(spawnSync).mockClear();
  });

  it("invokes claude with the given argv/timeout, pins cwd to homedir(), and maps a successful result", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: "install ok",
      stderr: "",
      error: undefined,
      pid: 123,
      output: [null, "install ok", ""],
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>);

    const result = runClaudeCli(["plugin", "install", "mnemosyne@mnemosyne"], 120_000);

    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      "claude",
      ["plugin", "install", "mnemosyne@mnemosyne"],
      expect.objectContaining({
        cwd: homedir(),
        stdio: "pipe",
        encoding: "utf8",
        timeout: 120_000,
      })
    );
    expect(result).toEqual({ status: 0, output: "install ok", errorCode: undefined });
  });

  it("maps a spawnSync error (e.g. ENOENT) into errorCode and combines stdout+stderr into output", () => {
    const spawnError = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: null,
      stdout: "partial-out",
      stderr: "some-err",
      error: spawnError,
      pid: 0,
      output: [null, "partial-out", "some-err"],
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>);

    const result = runClaudeCli(
      ["plugin", "marketplace", "add", "lucasmailland/mnemosyne"],
      30_000
    );

    expect(result.status).toBeNull();
    expect(result.output).toBe("partial-outsome-err");
    expect(result.errorCode).toBe("ENOENT");
  });
});

describe("cmdInstall — other agent branches unaffected (structural regression guard)", () => {
  // `cmdInstall` itself is excluded from `command-routes.snapshot.json`
  // route coverage ("install (skipped)") because it mutates real
  // installed-agent config directories, so full end-to-end coverage of the
  // Cursor/opencode/Gemini CLI/Codex branches isn't practical here. This is
  // a proportionate static structural check instead — mirroring the
  // `Function.prototype.toString()` guard pattern already used above for
  // `installClaudeCodePluginLocal` — asserting none of the new
  // Claude-Code-specific install machinery (spec: Out-of-Scope Exclusions)
  // leaked into the other agents' switch-case bodies.
  const FORBIDDEN_REFS = [
    "runClaudeCli",
    "installClaudeCodePluginNative",
    "installClaudeCodePluginLocal",
    "claudeCodePreflight",
  ] as const;

  // Branches in source order, paired with the marker that closes each body.
  const BRANCHES = [
    { name: "cursor", endMarker: 'case "opencode":' },
    { name: "opencode", endMarker: 'case "gemini-cli":' },
    { name: "gemini-cli", endMarker: 'case "codex":' },
    { name: "codex", endMarker: "default:" },
  ] as const;

  it.each(BRANCHES)(
    "$name branch body references none of the new Claude-Code-only install helpers",
    ({ name, endMarker }) => {
      const source = cmdInstall.toString();
      const startMarker = `case "${name}":`;
      const start = source.indexOf(startMarker);
      expect(start).toBeGreaterThan(-1);
      const bodyStart = start + startMarker.length;
      const end = source.indexOf(endMarker, bodyStart);
      expect(end).toBeGreaterThan(bodyStart);

      const body = source.slice(bodyStart, end);
      for (const ref of FORBIDDEN_REFS) {
        expect(body).not.toContain(ref);
      }
    }
  );
});
