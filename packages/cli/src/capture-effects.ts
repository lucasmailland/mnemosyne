/**
 * The real side of the capture phase: filesystem, host binaries, the harness.
 *
 * Kept apart from `capture-install.ts` so the orchestration — which is where the
 * ordering and consent rules live — stays a pure function of injected effects,
 * and so `cmdInstall` gains one call rather than a second install procedure.
 *
 * Every path here is derived from an injected home, never from `homedir()`, so
 * a test can exercise the real code against a scratch directory instead of a
 * mock of it.
 */

import { t } from "./i18n/index.js";
import { isYes, yesNoSuffix } from "./i18n/yes-no.js";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicReplace, identifyFile } from "./atomic-file.js";
import { readInstalledPluginEntry } from "./claude-plugin-registry.js";
import { enableCodexHooks, readCodexHooksGate } from "./codex-config.js";
import { installOpencodeCapture, resolveHostConfig } from "./harness-install.js";
import type { InstallResult } from "./harness-install.js";
import type { Answer, CaptureEffects, CaptureMode } from "./capture-install.js";
import type { CaptureHost } from "./install-args.js";

export interface CaptureEffectsInput {
  /** The user's home. Injected, never read from the environment here. */
  home: string;
  /** Where this build's plugin payload lives (hooks/, scripts/, opencode/). */
  pluginDir: string | null;
}

type Harness = typeof import("@mnemo-ai/harness");

/**
 * A three-valued prompt.
 *
 * A boolean cannot tell "the user said no" from "there was nobody to ask", and
 * those deserve opposite outcomes: one is the system working, the other is a
 * decision made on someone's behalf. Anything that is not an explicit yes from a
 * human — no TTY, EOF, a closed stream, an empty line — is `unavailable`.
 */
export async function askThreeValued(question: string): Promise<Answer> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "unavailable";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string | null>((resolve) => {
      rl.question(`${question} ${yesNoSuffix(false)} `, resolve);
      rl.once("close", () => resolve(null));
    });
    if (answer === null) return "unavailable";
    return isYes(answer, false) ? "yes" : "no";
  } catch {
    return "unavailable";
  } finally {
    rl.close();
  }
}

/** Where each host keeps the config this install would edit. */
export function hostPaths(home: string) {
  return {
    opencode: join(home, ".config", "opencode"),
    codex: join(home, ".codex"),
    "claude-code": join(home, ".claude"),
  } as const;
}

/**
 * The live gate: whether capture can exist on this machine at all.
 *
 * A different question from the qualification record, which answers whether a
 * given build was ever proven. On Windows the Codex record is absent or
 * platform-mismatched, so the record alone says `mcp-only` — but hooks cannot
 * exist there at all, and reporting `mcp-only` would promise a manifest that
 * can never fire.
 */
export function liveGateFor(
  host: CaptureHost,
  input: { home: string; platform: string }
): { mode: CaptureMode; reason: string } {
  if (host !== "codex") return { mode: "full", reason: t("capture.noFeatureGate") };

  if (input.platform === "win32") {
    return {
      mode: "unavailable",
      reason: t("capture.codexHooksDoNot"),
    };
  }

  const configPath = join(hostPaths(input.home).codex, "config.toml");
  if (!existsSync(configPath)) {
    return {
      mode: "mcp-only",
      reason: t("capture.featuresHooksIsNot"),
    };
  }
  let gate: ReturnType<typeof readCodexHooksGate>;
  try {
    gate = readCodexHooksGate(readFileSync(configPath, "utf8"));
  } catch (error) {
    return {
      mode: "mcp-only",
      reason: t("capture.configTomlCouldNotRead", { message: describe(error) }),
    };
  }
  if (gate.status === "malformed") {
    // Unreadable is not disabled, but it is equally not evidence that capture
    // works — and it is a config we must not edit.
    return { mode: "mcp-only", reason: t("capture.configTomlUnparsable", { reason: gate.reason }) };
  }
  return gate.enabled
    ? { mode: "full", reason: t("capture.featuresHooksIsEnabled") }
    : {
        mode: "mcp-only",
        reason: t("capture.featuresHooksIsNot"),
      };
}

/**
 * Place a host's capture artifacts.
 *
 * Claude Code's hook manifest ships with the plugin payload the installer
 * already copies, so there is nothing to write here — only something to verify.
 * Writing it a second time would mean owning two copies of the same file.
 */
export async function installHostArtifacts(
  host: CaptureHost,
  input: CaptureEffectsInput
): Promise<InstallResult> {
  const paths = hostPaths(input.home);
  if (!input.pluginDir) {
    return {
      status: "failed",
      path: "",
      reason: t("capture.pluginPayloadMissing"),
    };
  }

  if (host === "opencode") {
    const resolution = resolveHostConfig({ candidates: [join(paths.opencode, "opencode.json")] });
    if (resolution.status === "absent") {
      return {
        status: "failed",
        path: paths.opencode,
        reason: t("capture.noOpencodeJsonTo"),
      };
    }
    if (resolution.status !== "resolved") {
      return {
        status: "failed",
        path: paths.opencode,
        reason:
          resolution.status === "ambiguous"
            ? t("capture.ambiguousConfig", { candidates: resolution.competing.join(", ") })
            : resolution.reason,
      };
    }
    return installOpencodeCapture({
      configPath: resolution.path,
      pluginPath: join(input.pluginDir, "opencode", "mnemosyne.ts"),
    });
  }

  if (host === "claude-code") {
    // Installed by the plugin step this command already performs. Verified
    // rather than rewritten: a second writer of one file is how the two copies
    // drift. The manifest is read from where Claude Code registered the plugin;
    // `~/.claude/plugins/mnemosyne/`, the path this used to check, is written by
    // no install mode, so every real install was refused.
    const entry = readInstalledPluginEntry(paths["claude-code"]);
    const manifest = entry ? join(entry.installPath, "hooks", "hooks.json") : null;
    const shipped = join(input.pluginDir, "hooks", "hooks.json");
    if (manifest && existsSync(manifest)) return { status: "already-installed", path: manifest };
    if (!existsSync(shipped)) {
      return {
        status: "failed",
        path: shipped,
        reason: t("capture.noClaudeHookManifest"),
      };
    }
    return {
      status: "failed",
      path: manifest ?? join(paths["claude-code"], "plugins", "installed_plugins.json"),
      reason: t("capture.theClaudeCodePlugin"),
    };
  }

  return installCodexPlugin(input);
}

/**
 * Codex's plugin, installed the way Codex installs plugins.
 *
 * Not by dropping a file into `~/.codex/plugins`: that directory is a cache
 * owned by Codex's own plugin manager, and a manifest written there by hand is
 * one Codex never reads — a file on disk, a success reported, and no capture.
 *
 * Codex takes a LOCAL PATH as a marketplace source, so the sanctioned route is
 * the same shape the Claude Code branch of this installer already uses:
 *
 *     codex plugin marketplace add <root>
 *     codex plugin add mnemosyne
 *
 * A marketplace root is a directory containing `plugins/<name>/`, and a plugin
 * is `.codex-plugin/plugin.json` plus `hooks/hooks.json`, `scripts/` and the
 * `skills/` its manifest declares. That
 * layout was read off a working third-party plugin, not guessed.
 *
 * `${PLUGIN_ROOT}` is left VERBATIM in the manifest: Codex expands it, as real
 * plugins rely on. Rendering it to an absolute path here would have been the
 * Cursor lesson applied to a host that does not have that problem.
 */
export function installCodexPlugin(
  input: CaptureEffectsInput,
  run: CodexRunner = defaultCodexRunner
): InstallResult {
  const root = join(input.home, ".mnemo", "codex-marketplace");
  const pluginRoot = join(root, "plugins", PLUGIN_NAME);

  const staged = stageCodexPlugin(input, pluginRoot);
  if (staged) return staged;

  // Adding the same marketplace twice is not an error worth failing on — the
  // second run of an installer is the normal case, not the exception.
  const added = run(["plugin", "marketplace", "add", root]);
  if (added.status !== 0 && !/already/i.test(added.output)) {
    return {
      status: "failed",
      path: root,
      reason: t("capture.codexMarketplaceAddFailed", { output: firstLine(added.output) }),
    };
  }

  // Qualified with the marketplace: Codex refuses a bare name when more than one
  // marketplace is configured, and it always is — it ships with its own.
  const installed = run(["plugin", "add", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`]);
  if (installed.status !== 0) {
    if (/already/i.test(installed.output)) {
      return { status: "already-installed", path: pluginRoot };
    }
    return {
      status: "failed",
      path: pluginRoot,
      reason: t("capture.codexPluginAddFailed", { output: firstLine(installed.output) }),
    };
  }
  return { status: "installed", path: pluginRoot };
}

const PLUGIN_NAME = "mnemosyne";
/** Our own marketplace, named so it cannot collide with a configured one. */
const MARKETPLACE_NAME = "mnemosyne-local";

export interface CodexRunResult {
  status: number | null;
  output: string;
}

export type CodexRunner = (args: string[]) => CodexRunResult;

const defaultCodexRunner: CodexRunner = (args) => {
  const result = spawnSync("codex", args, { encoding: "utf8", timeout: 60_000, shell: false });
  if (result.error) return { status: null, output: result.error.message };
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

/**
 * Lay out the plugin as a marketplace source. Returns a failure, or null when
 * the staging is complete.
 */
function stageCodexPlugin(input: CaptureEffectsInput, pluginRoot: string): InstallResult | null {
  // A marketplace root is identified by this file, and Codex refuses the source
  // outright without it ("marketplace root does not contain a supported
  // manifest"). The shape was read off the bundled marketplace Codex ships.
  const marketplace = {
    name: MARKETPLACE_NAME,
    interface: { displayName: "Mnemosyne" },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: { source: "local", path: `./plugins/${PLUGIN_NAME}` },
        policy: { installation: "AVAILABLE" },
        category: "Developer Tools",
      },
    ],
  };

  const sources: Array<{ from: string; to: string }> = [
    {
      from: join(input.pluginDir!, ".codex-plugin", "plugin.json"),
      to: join(pluginRoot, ".codex-plugin", "plugin.json"),
    },
    // Codex reads `hooks/hooks.json`; we ship it under its host-qualified name
    // so the two manifests can live side by side in one payload.
    {
      from: join(input.pluginDir!, "hooks", "codex-hooks.json"),
      to: join(pluginRoot, "hooks", "hooks.json"),
    },
  ];

  for (const { from } of sources) {
    if (!existsSync(from)) {
      return { status: "failed", path: from, reason: t("capture.noCodexPluginPayload") };
    }
  }

  try {
    const manifestPath = join(
      dirname(dirname(pluginRoot)),
      ".agents",
      "plugins",
      "marketplace.json"
    );
    mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
    atomicReplace(manifestPath, `${JSON.stringify(marketplace, null, 2)}\n`, {
      expect: identifyFile(manifestPath),
    });

    for (const { from, to } of sources) {
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      atomicReplace(to, readFileSync(from, "utf8"), { expect: identifyFile(to) });
    }
    // The launcher the manifest's commands point at, plus everything it sources.
    const scriptsFrom = join(input.pluginDir!, "scripts");
    if (!existsSync(scriptsFrom)) {
      return { status: "failed", path: scriptsFrom, reason: t("capture.noHookScripts") };
    }
    cpSync(scriptsFrom, join(pluginRoot, "scripts"), { recursive: true });
    // `.codex-plugin/plugin.json` declares "skills": "./skills/" (APP-035b).
    const skillsFrom = join(input.pluginDir!, "skills");
    if (existsSync(skillsFrom)) {
      cpSync(skillsFrom, join(pluginRoot, "skills"), { recursive: true });
    }
    writeRuntimeLocator(pluginRoot);
    // npm publish strips the executable bit from anything not declared in `bin`,
    // and a hook that cannot execute is a hook that silently never runs.
    for (const file of readdirSync(join(pluginRoot, "scripts"))) {
      if (file.endsWith(".sh")) chmodSync(join(pluginRoot, "scripts", file), 0o755);
    }
  } catch (error) {
    return { status: "failed", path: pluginRoot, reason: describe(error) };
  }
  return null;
}

/**
 * Record the node binary and CLI entry this install runs from, next to a plugin
 * payload. Hooks often run with a PATH that has no npm bin directory (launchd,
 * a systemd user session), so harness-hook.sh and _helpers.sh read
 * `<plugin>/.mnemo-runtime.json` first and ignore a record whose files are gone.
 * The CLI is one bundle, so this module's own file is the entry.
 */
export function writeRuntimeLocator(pluginRoot: string): void {
  const locator = join(pluginRoot, ".mnemo-runtime.json");
  writeFileSync(
    locator,
    JSON.stringify({
      node: process.execPath,
      cli: join(dirname(fileURLToPath(import.meta.url)), "index.js"),
    }),
    { mode: 0o600 }
  );
  chmodSync(locator, 0o600);
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? t("capture.noOutput");
}

/** The real effects, assembled. */
export function captureEffects(
  input: CaptureEffectsInput & { harness: Harness; platform?: string }
): CaptureEffects {
  const platform = input.platform ?? process.platform;
  return {
    readHostVersion: (host) => input.harness.readHostVersion(host),
    resolveMode: ({ host, hostVersion }) =>
      input.harness.resolveHostCaptureMode({
        host,
        hostVersion,
        artifactRoot: input.pluginDir ?? undefined,
      }),
    liveGate: (host) => liveGateFor(host, { home: input.home, platform }),
    confirm: askThreeValued,
    bind: async ({ serverUrl, workspaceId, apiKey }) => {
      const result = await input.harness.resolveBinding({ serverUrl, workspaceId, apiKey });
      return { rebound: result.status === "rebound" };
    },
    installArtifacts: (host) => installHostArtifacts(host, input),
    writeConsent: async ({ host, mode, hostVersion }) => {
      // The digest of what was consented TO, so an operator can later tell that
      // the artifacts changed under a marker written for an older build. An
      // unhashable payload records an empty digest rather than refusing: the
      // consent itself is still real, and failing the install here would strand
      // a host whose artifacts were already written.
      const hash = input.harness.computeCaptureArtifactHash({
        host,
        artifactRoot: input.pluginDir ?? "",
      });
      await input.harness.writeCaptureConsent({
        host,
        mode,
        hostVersion,
        packageHash: "hash" in hash ? hash.hash : "",
        // Full capture is owned by the managed harness runtime. The plugin's
        // legacy_capture_hook reads this field and hands every hook to
        // harness-hook.sh, so exactly one writer captures the session.
        ...(mode === "full" ? { writer: "managed" as const } : {}),
      });
    },
    enableHostGate: async (host) => {
      if (host !== "codex") {
        return { status: "failed", path: "", reason: t("capture.noFeatureGateToEnable") };
      }
      return enableCodexHooks({ configPath: join(hostPaths(input.home).codex, "config.toml") });
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
