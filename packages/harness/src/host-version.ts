/**
 * The one place a host binary's version string is produced.
 *
 * A qualification record is matched on STRING EQUALITY of `hostVersion`, so the
 * writer (the qualifier) and every reader (the CLI, the OpenCode plugin) have to
 * normalise identically. When they drift, nothing errors: the record simply stops
 * matching and every host silently pins to the mode that needs no evidence. That
 * is why normalisation lives in one function instead of at each call site.
 *
 * The spawn is deliberately kept out of `resolveHostCaptureMode`, which stays a
 * pure file-reading decision and never shells out.
 */

import { spawnSync } from "node:child_process";

import type { CaptureHost } from "./adapters/capabilities.js";

export type HostVersionResult = { version: string } | { error: string };

/**
 * The part of `spawnSync`'s result this module reads.
 *
 * Declared STRUCTURALLY rather than as `typeof spawnSync` on purpose: the harness
 * does not depend on `@types/node`, and a `typeof import("node:child_process")`
 * in an exported type emits exactly that requirement into the published `.d.ts`,
 * breaking every consumer that does not install Node's types. The packaging test
 * type-checks a consumer without them, which is what caught it.
 */
export interface HostVersionSpawnResult {
  error?: Error | undefined;
  signal?: string | null | undefined;
  status?: number | null | undefined;
  stdout?: string | null | undefined;
}

export type HostVersionSpawn = (
  command: string,
  args: readonly string[],
  options: { shell: false; timeout: number; encoding: "utf8" }
) => HostVersionSpawnResult;

export interface HostVersionEffects {
  spawn?: HostVersionSpawn;
  env?: Readonly<Record<string, string | undefined>>;
}

/** The binary to ask, and how to read what it answers. */
const SOURCES: Record<CaptureHost, { binary: string; normalize: (raw: string) => string }> = {
  // OpenCode prints a bare version. The host may also publish it into the plugin
  // environment, which is preferred when present because it needs no process.
  opencode: { binary: "opencode", normalize: (raw) => raw.trim() },
  // Claude Code prints `2.0.1 (Claude Code)`; the record holds the first token.
  "claude-code": { binary: "claude", normalize: (raw) => raw.trim().split(/\s+/)[0] ?? "" },
  // Codex prints `codex-cli 0.153.4`, and the record holds all of it.
  codex: { binary: "codex", normalize: (raw) => raw.trim() },
};

/** Only OpenCode has an environment override, and only the host ever sets it. */
const ENV_OVERRIDE: Partial<Record<CaptureHost, string>> = {
  opencode: "OPENCODE_VERSION",
};

/**
 * Read a host binary's version, normalised exactly as the qualifier records it.
 *
 * Returns `{ error }` rather than throwing for every reachable failure — an
 * absent binary, a non-zero exit, a timeout — because "no version" is a normal
 * answer on a machine that does not have the host installed, not an exception.
 */
export function readHostVersion(host: CaptureHost, fx: HostVersionEffects = {}): HostVersionResult {
  const source = SOURCES[host];
  if (!source) return { error: `unknown host: ${String(host)}` };

  const env = fx.env ?? process.env;
  const overrideKey = ENV_OVERRIDE[host];
  if (overrideKey) {
    const override = source.normalize(env[overrideKey] ?? "");
    if (override !== "") return { version: override };
  }

  const spawn: HostVersionSpawn = fx.spawn ?? spawnSync;
  let result: HostVersionSpawnResult;
  try {
    result = spawn(source.binary, ["--version"], {
      shell: false,
      timeout: 5000,
      encoding: "utf8",
    });
  } catch (cause) {
    return { error: `${source.binary} could not be executed: ${String(cause)}` };
  }

  if (result.error)
    return { error: `${source.binary} could not be executed: ${result.error.message}` };
  if (result.signal) return { error: `${source.binary} --version was killed by ${result.signal}` };
  if (result.status !== 0)
    return { error: `${source.binary} --version exited ${String(result.status)}` };

  const version = source.normalize(String(result.stdout ?? ""));
  if (version === "") return { error: `${source.binary} --version printed nothing` };
  return { version };
}
