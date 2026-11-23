/**
 * The orchestration, with every effect injected.
 *
 * What these protect is ORDERING and HONESTY: nothing is written before every
 * question is answered, the binding precedes every write, a user who declined is
 * not a failure, and nobody-could-be-asked is not consent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureFailed,
  installCaptureHosts,
  renderCaptureSummary,
  type CaptureEffects,
  type CaptureMode,
  type CaptureRequest,
} from "../capture-install.js";
import { installClaudeCodePluginLocal } from "../commands.js";
import type { CaptureHost } from "../install-args.js";

const REQUEST: CaptureRequest = {
  hosts: ["opencode"],
  acceptDegraded: false,
  serverUrl: "https://memory.example.com",
  apiKey: "mns_live_fake",
  workspaceId: "workspace-a",
};

/** Records the order of every effect, which is what most of these assert on. */
function effects(overrides: Partial<CaptureEffects> = {}) {
  const calls: string[] = [];
  const base: CaptureEffects = {
    readHostVersion: (host) => {
      calls.push(`version:${host}`);
      return { version: "1.0.0" };
    },
    resolveMode: ({ host }) => {
      calls.push(`resolve:${host}`);
      return { mode: "user-only", reason: "unproven capabilities: transcript" };
    },
    liveGate: (host) => {
      calls.push(`gate:${host}`);
      return { mode: "full", reason: "no host gate" };
    },
    confirm: async (question) => {
      calls.push(`confirm:${question.slice(0, 24)}`);
      return "yes";
    },
    bind: async () => {
      calls.push("bind");
      return { rebound: false };
    },
    installArtifacts: async (host) => {
      calls.push(`install:${host}`);
      return { status: "installed", path: `/fake/${host}` };
    },
    writeConsent: async ({ host }) => {
      calls.push(`consent:${host}`);
    },
    ...overrides,
  };
  return { calls, fx: base };
}

describe("an honest mode needs no second question", () => {
  it("installs a user-only host without prompting", async () => {
    const { calls, fx } = effects();
    const [outcome] = await installCaptureHosts(REQUEST, fx);

    expect(outcome).toMatchObject({
      host: "opencode",
      mode: "user-only",
      consent: "not-required",
      artifact: "installed",
    });
    expect(calls.filter((c) => c.startsWith("confirm"))).toEqual([]);
  });

  it("binds before it writes anything, and binds once", async () => {
    const { calls, fx } = effects();
    await installCaptureHosts({ ...REQUEST, hosts: ["opencode", "codex"] }, fx);

    // An artifact written first can be picked up by a host already running.
    expect(calls.indexOf("bind")).toBeLessThan(calls.indexOf("install:opencode"));
    expect(calls.indexOf("bind")).toBeLessThan(calls.indexOf("install:codex"));
    expect(calls.filter((c) => c === "bind")).toHaveLength(1);
  });

  it("writes the consent marker only after the artifacts exist", async () => {
    const { calls, fx } = effects();
    await installCaptureHosts(REQUEST, fx);
    // The marker is the on-switch: writing it first enables a host we might
    // then fail to configure.
    expect(calls.indexOf("install:opencode")).toBeLessThan(calls.indexOf("consent:opencode"));
  });

  it("answers every question before it writes anything at all", async () => {
    const { calls, fx } = effects({
      resolveMode: () => ({ mode: "mcp-only", reason: "hooks are off" }),
    });
    await installCaptureHosts({ ...REQUEST, hosts: ["opencode", "codex"] }, fx);

    const lastConfirm = calls.map((c) => c.startsWith("confirm")).lastIndexOf(true);
    const firstWrite = calls.findIndex((c) => c.startsWith("install") || c === "bind");
    expect(lastConfirm).toBeLessThan(firstWrite);
  });
});

describe("the mode is the lower of what was proved and what is possible here", () => {
  it("takes the live gate when it is more pessimistic than the record", async () => {
    const { fx } = effects({
      resolveMode: () => ({ mode: "full", reason: "qualified" }),
      liveGate: () => ({ mode: "mcp-only", reason: "features.hooks is off" }),
    });
    const [outcome] = await installCaptureHosts({ ...REQUEST, hosts: ["codex"] }, fx);

    expect(outcome?.mode).toBe("mcp-only");
    expect(outcome?.reason).toBe("features.hooks is off");
  });

  it("takes the record when it is the more pessimistic of the two", async () => {
    const { fx } = effects({
      resolveMode: () => ({ mode: "mcp-only", reason: "no qualification record" }),
      liveGate: () => ({ mode: "full", reason: "no host gate" }),
    });
    const [outcome] = await installCaptureHosts({ ...REQUEST, acceptDegraded: true }, fx);

    expect(outcome?.mode).toBe("mcp-only");
    expect(outcome?.reason).toBe("no qualification record");
  });

  it("never rounds a degraded answer up", async () => {
    const cases: Array<[CaptureMode, CaptureMode, CaptureMode]> = [
      ["full", "full", "full"],
      ["full", "user-only", "user-only"],
      ["user-only", "mcp-only", "mcp-only"],
      ["mcp-only", "unavailable", "unavailable"],
      ["unavailable", "full", "unavailable"],
    ];
    for (const [record, live, expected] of cases) {
      const { fx } = effects({
        resolveMode: () => ({ mode: record, reason: "r" }),
        liveGate: () => ({ mode: live, reason: "l" }),
      });
      const [outcome] = await installCaptureHosts({ ...REQUEST, acceptDegraded: true }, fx);
      expect(outcome?.mode, `${record} + ${live}`).toBe(expected);
    }
  });
});

describe("declining is an answer; being unable to ask is not", () => {
  it("skips a host the user declined, without calling it a failure", async () => {
    const { calls, fx } = effects({
      resolveMode: () => ({ mode: "mcp-only", reason: "hooks are off" }),
      confirm: async () => "no",
    });
    const outcomes = await installCaptureHosts(REQUEST, fx);

    expect(outcomes[0]).toMatchObject({ consent: "declined", artifact: "skipped" });
    expect(outcomes[0]?.failure).toBeUndefined();
    expect(captureFailed(outcomes)).toBe(false);
    expect(calls).not.toContain("install:opencode");
  });

  it("fails when nobody could be asked, because silence is not agreement", async () => {
    const { calls, fx } = effects({
      resolveMode: () => ({ mode: "mcp-only", reason: "hooks are off" }),
      confirm: async () => "unavailable",
    });
    const outcomes = await installCaptureHosts(REQUEST, fx);

    expect(outcomes[0]).toMatchObject({ consent: "unobtainable", artifact: "skipped" });
    expect(captureFailed(outcomes)).toBe(true);
    expect(outcomes[0]?.failure).toMatch(/--accept-degraded/);
    expect(calls).not.toContain("install:opencode");
  });

  it("does not ask at all under --accept-degraded", async () => {
    const { calls, fx } = effects({
      resolveMode: () => ({ mode: "mcp-only", reason: "hooks are off" }),
    });
    const outcomes = await installCaptureHosts({ ...REQUEST, acceptDegraded: true }, fx);

    expect(outcomes[0]).toMatchObject({ consent: "pre-consented", artifact: "installed" });
    expect(calls.filter((c) => c.startsWith("confirm"))).toEqual([]);
  });

  it("declining does not stop the other requested hosts", async () => {
    let asked = 0;
    const { fx } = effects({
      resolveMode: ({ host }) =>
        host === "codex"
          ? { mode: "mcp-only", reason: "hooks are off" }
          : { mode: "user-only", reason: "proven" },
      confirm: async () => {
        asked += 1;
        return "no";
      },
    });
    const outcomes = await installCaptureHosts({ ...REQUEST, hosts: ["codex", "opencode"] }, fx);

    expect(asked).toBe(1);
    expect(outcomes.map((o) => o.artifact)).toEqual(["skipped", "installed"]);
  });
});

describe("nothing is written without a destination to write to", () => {
  it("refuses every host when the workspace could not be resolved", async () => {
    const { calls, fx } = effects();
    const outcomes = await installCaptureHosts(
      { ...REQUEST, hosts: ["opencode", "codex"], workspaceId: null },
      fx
    );

    // Capture with no binding is a queue with no destination.
    expect(outcomes.every((o) => o.failure !== undefined)).toBe(true);
    expect(calls.filter((c) => c.startsWith("install"))).toEqual([]);
    expect(outcomes[0]?.failure).toMatch(/no destination/);
  });

  it("refuses every host when binding itself throws", async () => {
    const { calls, fx } = effects({
      bind: async () => {
        throw new Error("disk full");
      },
    });
    const outcomes = await installCaptureHosts({ ...REQUEST, hosts: ["opencode", "codex"] }, fx);

    expect(outcomes.every((o) => o.failure?.includes("disk full"))).toBe(true);
    expect(calls.filter((c) => c.startsWith("install"))).toEqual([]);
  });

  it("does not bind at all when no host survived consent", async () => {
    const { calls, fx } = effects({
      resolveMode: () => ({ mode: "mcp-only", reason: "hooks are off" }),
      confirm: async () => "no",
    });
    await installCaptureHosts(REQUEST, fx);
    expect(calls).not.toContain("bind");
  });

  it("surfaces a rebind rather than swallowing it", async () => {
    const { fx } = effects({ bind: async () => ({ rebound: true }) });
    const [outcome] = await installCaptureHosts(REQUEST, fx);
    // Events already queued belong to the previous destination.
    expect(outcome?.nextStep).toMatch(/drain/);
  });
});

describe("one host's failure is one host's outcome", () => {
  it("reports a host whose version cannot be read, and continues", async () => {
    const { fx } = effects({
      readHostVersion: (host) =>
        host === "codex" ? { error: "codex binary is not on PATH" } : { version: "1.0.0" },
    });
    const outcomes = await installCaptureHosts({ ...REQUEST, hosts: ["codex", "opencode"] }, fx);

    expect(outcomes[0]).toMatchObject({ host: "codex", mode: "unavailable", artifact: "failed" });
    expect(outcomes[1]).toMatchObject({ host: "opencode", artifact: "installed" });
    expect(captureFailed(outcomes)).toBe(true);
  });

  it("reports a failed artifact write without throwing", async () => {
    const { fx } = effects({
      installArtifacts: async () => ({
        status: "failed",
        path: "/x",
        reason: "config is ambiguous",
      }),
    });
    const outcomes = await installCaptureHosts(REQUEST, fx);

    expect(outcomes[0]).toMatchObject({ artifact: "failed" });
    expect(outcomes[0]?.failure).toMatch(/config is ambiguous/);
  });

  it("turns a thrown effect into that host's outcome", async () => {
    const { fx } = effects({
      installArtifacts: async () => {
        throw new Error("EACCES");
      },
    });
    const outcomes = await installCaptureHosts(REQUEST, fx);
    expect(outcomes[0]?.failure).toMatch(/EACCES/);
  });

  it("reports an already-configured host as such, not as a fresh install", async () => {
    const { fx } = effects({
      installArtifacts: async (host) => ({ status: "already-installed", path: `/fake/${host}` }),
    });
    const [outcome] = await installCaptureHosts(REQUEST, fx);
    expect(outcome?.artifact).toBe("already-installed");
    expect(captureFailed([outcome!])).toBe(false);
  });

  it("returns one outcome per REQUESTED host, in command-line order", async () => {
    const { fx } = effects();
    const hosts: CaptureHost[] = ["codex", "claude-code", "opencode"];
    const outcomes = await installCaptureHosts({ ...REQUEST, hosts }, fx);
    expect(outcomes.map((o) => o.host)).toEqual(hosts);
  });
});

describe("the host-gate offer is a separate question", () => {
  const gated = (overrides: Partial<CaptureEffects> = {}) =>
    effects({
      resolveMode: () => ({ mode: "full", reason: "qualified" }),
      liveGate: () => ({ mode: "mcp-only", reason: "features.hooks is off." }),
      enableHostGate: async () => ({ status: "installed", path: "/config.toml" }),
      ...overrides,
    });

  it("asks a second time, after consent, and applies it when accepted", async () => {
    const answers: string[] = [];
    const { fx } = gated({
      confirm: async (question) => {
        answers.push(question);
        return "yes";
      },
    });
    const [outcome] = await installCaptureHosts({ ...REQUEST, hosts: ["codex"] }, fx);

    expect(answers).toHaveLength(2);
    expect(answers[1]).toMatch(/Enable it now/);
    expect(outcome?.gateOffer).toBe("accepted");
    expect(outcome?.nextStep).toMatch(/restart/);
  });

  it("is never implied by --accept-degraded", async () => {
    const { calls, fx } = gated();
    const [outcome] = await installCaptureHosts(
      { ...REQUEST, hosts: ["codex"], acceptDegraded: true },
      fx
    );
    // The two consents differ in blast radius: one adds our entry to a config,
    // the other changes a global host setting other plugins observe.
    expect(calls.filter((c) => c.startsWith("confirm"))).toEqual([]);
    expect(outcome?.gateOffer).toBe("not-applicable");
    expect(outcome?.nextStep).toMatch(/features.hooks/);
  });

  it("is skipped, never auto-answered, when nobody is there to ask", async () => {
    const { fx } = gated({ confirm: async () => "unavailable" });
    const [outcome] = await installCaptureHosts(
      { ...REQUEST, hosts: ["codex"], acceptDegraded: true },
      fx
    );
    expect(outcome?.gateOffer).toBe("not-applicable");
  });

  it("still installs the manifest when the offer is declined", async () => {
    let answer = "yes";
    const { fx } = gated({
      confirm: async () => {
        const current = answer;
        answer = "no";
        return current as "yes" | "no";
      },
    });
    const [outcome] = await installCaptureHosts({ ...REQUEST, hosts: ["codex"] }, fx);

    // Inert and announced beats absent: it is what makes the one-question fix
    // available the next time, without a second install.
    expect(outcome?.artifact).toBe("installed");
    expect(outcome?.gateOffer).toBe("declined");
    expect(captureFailed([outcome!])).toBe(false);
  });

  it("reports a failed gate write as a failure, keeping the manifest", async () => {
    const { fx } = gated({
      enableHostGate: async () => ({
        status: "failed",
        path: "/config.toml",
        reason: "dotted key",
      }),
    });
    const [outcome] = await installCaptureHosts({ ...REQUEST, hosts: ["codex"] }, fx);

    expect(outcome?.artifact).toBe("installed");
    expect(outcome?.failure).toMatch(/dotted key/);
  });

  it("is not offered to a host whose mode is limited by something else", async () => {
    const { fx } = effects({
      resolveMode: () => ({ mode: "user-only", reason: "unproven capabilities: transcript" }),
      enableHostGate: async () => ({ status: "installed", path: "/x" }),
    });
    const [outcome] = await installCaptureHosts(REQUEST, fx);
    expect(outcome?.gateOffer).toBeUndefined();
  });
});

describe("the summary reports only what was asked for", () => {
  it("renders nothing when no host was requested", () => {
    expect(renderCaptureSummary([])).toEqual([]);
  });

  it("names the mode, the reason and the next step", async () => {
    const { fx } = effects({
      resolveMode: () => ({ mode: "mcp-only", reason: "no qualification record" }),
      confirm: async () => "no",
    });
    const text = renderCaptureSummary(await installCaptureHosts(REQUEST, fx)).join("\n");

    expect(text).toContain("opencode: not configured (mcp-only)");
    expect(text).toContain("why: no qualification record");
    expect(text).toContain("you declined this one");
  });

  it("does not mention hosts that were never requested", async () => {
    const { fx } = effects();
    const text = renderCaptureSummary(await installCaptureHosts(REQUEST, fx)).join("\n");
    expect(text).not.toContain("codex");
    expect(text).not.toContain("claude-code");
  });
});

const SYNC_PLUGIN_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "sync-plugin.cjs"
);

describe("sync-plugin --check mode and mirror repair", () => {
  it("detects clean trees, reports nonzero on each drift without mutating, and normal sync repairs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sync-plugin-test-"));
    const srcDir = join(tmp, "src");
    const dstDir = join(tmp, "dst");

    const run = (args: string[]) =>
      spawnSync(process.execPath, [SYNC_PLUGIN_SCRIPT, ...args], { encoding: "utf8" });

    try {
      mkdirSync(srcDir, { recursive: true });
      mkdirSync(dstDir, { recursive: true });

      // Clean trees
      writeFileSync(join(srcDir, "a.txt"), "hello");
      writeFileSync(join(dstDir, "a.txt"), "hello");
      const cleanRes = run(["--check", srcDir, dstDir]);
      expect(cleanRes.status).toBe(0);

      // Drift 1: Missing file in destination
      writeFileSync(join(srcDir, "missing.txt"), "needed");
      const missingRes = run(["--check", srcDir, dstDir]);
      expect(missingRes.status).not.toBe(0);
      expect(existsSync(join(dstDir, "missing.txt"))).toBe(false);

      // Drift 2: Extra file in destination
      writeFileSync(join(dstDir, "extra.txt"), "untracked");
      const extraRes = run(["--check", srcDir, dstDir]);
      expect(extraRes.status).not.toBe(0);
      expect(readFileSync(join(dstDir, "extra.txt"), "utf8")).toBe("untracked");

      // Drift 3: Byte-different file
      writeFileSync(join(dstDir, "a.txt"), "divergent content");
      const diffRes = run(["--check", srcDir, dstDir]);
      expect(diffRes.status).not.toBe(0);
      expect(readFileSync(join(dstDir, "a.txt"), "utf8")).toBe("divergent content");

      // Normal sync repairs the fixture without --check
      const syncRes = run([srcDir, dstDir]);
      expect(syncRes.status).toBe(0);
      expect(readFileSync(join(dstDir, "a.txt"), "utf8")).toBe("hello");
      expect(readFileSync(join(dstDir, "missing.txt"), "utf8")).toBe("needed");
      expect(existsSync(join(dstDir, "extra.txt"))).toBe(false);

      // Check mode passes on the repaired fixture
      const postRepairRes = run(["--check", srcDir, dstDir]);
      expect(postRepairRes.status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("distribution manifest and protocol copy alignment", () => {
  const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const repoRoot = join(cliRoot, "..", "..");
  const canonicalPluginDir = join(repoRoot, "packages", "plugin");
  const sharedBundledDir = join(cliRoot, "plugin");
  // packages/cli/plugin is gitignored and only exists after the CLI prebuild,
  // and other suites may regenerate it concurrently. Assert against a
  // test-local mirror produced by the same sync script a build runs.
  let mirrorTmp = "";
  let bundledPluginDir = "";
  beforeAll(() => {
    mirrorTmp = mkdtempSync(join(tmpdir(), "capture-install-mirror-"));
    bundledPluginDir = join(mirrorTmp, "plugin");
    const res = spawnSync(
      process.execPath,
      [SYNC_PLUGIN_SCRIPT, canonicalPluginDir, bundledPluginDir],
      { encoding: "utf8" }
    );
    if (res.status !== 0) throw new Error(`sync-plugin failed: ${res.stderr}`);
  });
  afterAll(() => {
    if (mirrorTmp) rmSync(mirrorTmp, { recursive: true, force: true });
  });

  it("uses a private bundled mirror, not the shared packages/cli/plugin", () => {
    expect(bundledPluginDir.startsWith(mirrorTmp)).toBe(true);
    expect(bundledPluginDir).not.toBe(sharedBundledDir);
    expect(existsSync(join(bundledPluginDir, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("canonical and bundled version equal 0.1.0", () => {
    const canonicalManifest = JSON.parse(
      readFileSync(join(canonicalPluginDir, ".claude-plugin", "plugin.json"), "utf8")
    );
    const bundledManifest = JSON.parse(
      readFileSync(join(bundledPluginDir, ".claude-plugin", "plugin.json"), "utf8")
    );
    expect(canonicalManifest.version).toBe("0.1.0");
    expect(bundledManifest.version).toBe("0.1.0");
  });

  it("bundled skill contains subtype guidance and the plugin session marker", () => {
    for (const pluginDir of [canonicalPluginDir, bundledPluginDir]) {
      const skillText = readFileSync(join(pluginDir, "skills", "memory", "SKILL.md"), "utf8");
      expect(skillText).toContain("Episode: open");
      expect(skillText).toContain("subtype");
      expect(skillText).toMatch(/other[`"']? (only|is the last resort)|only when none/i);
    }
  });

  it("the freshness checker detects an old manifest", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sync-plugin-manifest-"));
    try {
      const srcDir = join(tmp, "src");
      const dstDir = join(tmp, "dst");
      mkdirSync(join(srcDir, ".claude-plugin"), { recursive: true });
      mkdirSync(join(dstDir, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(srcDir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ version: "0.3.2" })
      );
      writeFileSync(
        join(dstDir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ version: "0.3.1" })
      );

      const checkRes = spawnSync(
        process.execPath,
        [SYNC_PLUGIN_SCRIPT, "--check", srcDir, dstDir],
        {
          encoding: "utf8",
        }
      );
      expect(checkRes.status).not.toBe(0);
      expect(checkRes.stderr).toContain("Byte-different mirror file: .claude-plugin/plugin.json");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("installClaudeCodePluginLocal reports manifest version and target without real host writes", () => {
    const tmp = mkdtempSync(join(tmpdir(), "capture-install-synthetic-"));
    try {
      const pluginDir = join(tmp, "src");
      const configDir = join(tmp, "config");
      mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
      mkdirSync(join(pluginDir, "skills", "memory"), { recursive: true });

      const manifestVersion = "0.9.9-synthetic";
      writeFileSync(
        join(pluginDir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ version: manifestVersion })
      );
      const fixtureText =
        "# Synthetic Protocol\nEpisode: open (session-123)\nsubtype: architecture (other is the last resort)";
      writeFileSync(join(pluginDir, "skills", "memory", "SKILL.md"), fixtureText);

      const result = installClaudeCodePluginLocal({ pluginDir, configDir });
      expect(result.ok).toBe(true);
      expect(result.pluginVersion).toBe(manifestVersion);
      expect(result.pluginTarget).toBe(
        join(configDir, "plugins", "cache", "mnemosyne", "mnemosyne", manifestVersion)
      );

      const copiedSkill = readFileSync(
        join(result.pluginTarget, "skills", "memory", "SKILL.md"),
        "utf8"
      );
      expect(copiedSkill).toBe(fixtureText);

      // Verify no real host writes: artifacts exist strictly under configDir
      expect(existsSync(join(configDir, "plugins", "installed_plugins.json"))).toBe(true);
      expect(existsSync(join(configDir, "settings.json"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
