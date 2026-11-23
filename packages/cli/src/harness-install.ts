import { t } from "./i18n/index.js";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { atomicReplace, identifyFile } from "./atomic-file.js";
import {
  applyEdits,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";

/**
 * Installing capture into a host's own configuration.
 *
 * Two rules shape everything here, and both come from the same place: this edits
 * a file the user owns and did not ask us to rewrite.
 *
 *   1. FAIL CLOSED. Anything ambiguous, malformed, or not shaped the way we
 *      expect leaves the file exactly as it was. A config we could not parse is
 *      a config whose meaning we do not know, and rewriting it would destroy
 *      whatever the user meant.
 *   2. PRESERVE EVERYTHING ELSE. Comments, key order and unrelated settings all
 *      survive, which is why this edits through jsonc-parser rather than parsing
 *      to an object and stringifying it back.
 */

export type ConfigResolution =
  | { status: "resolved"; path: string }
  | { status: "absent"; searched: string[] }
  | { status: "ambiguous"; competing: string[] }
  | { status: "unsafe"; path: string; reason: string };

/**
 * Decide which config file the installed host actually loads.
 *
 * Candidates are given in precedence order, most specific first. Two configs in
 * the SAME directory is ambiguous rather than a precedence question: editing the
 * one the host ignores looks like success and does nothing, which is the worst
 * possible outcome for an installer.
 */
export function resolveHostConfig(input: { candidates: string[] }): ConfigResolution {
  const existing = input.candidates.filter((path) => existsSync(path));
  if (existing.length === 0) return { status: "absent", searched: input.candidates };

  const byDirectory = new Map<string, string[]>();
  for (const path of existing) {
    const dir = dirname(path);
    byDirectory.set(dir, [...(byDirectory.get(dir) ?? []), path]);
  }
  for (const [, competing] of byDirectory) {
    if (competing.length > 1) return { status: "ambiguous", competing };
  }

  const chosen = existing[0]!;
  // A symlink would take the write outside the directory whose ownership and
  // mode we just checked.
  const stat = lstatSync(chosen);
  if (stat.isSymbolicLink()) {
    return { status: "unsafe", path: chosen, reason: t("harness.configIsASymlink") };
  }
  if (!stat.isFile()) {
    return { status: "unsafe", path: chosen, reason: t("harness.configNotRegularFile") };
  }
  return { status: "resolved", path: chosen };
}

/**
 * OpenCode's resolution, which is host-agnostic. Kept as a named wrapper because
 * the rules it enforces — one config per directory, never a symlink, never a
 * device — are the same for every host, and Codex now reuses them.
 */
export function resolveOpencodeConfig(input: { candidates: string[] }): ConfigResolution {
  return resolveHostConfig(input);
}

export type InstallResult =
  | { status: "installed"; path: string }
  | { status: "already-installed"; path: string }
  | { status: "failed"; path: string; reason: string };

/**
 * Add the capture plugin to a resolved config, non-destructively.
 *
 * The merged text is reparsed and re-validated BEFORE anything is written, so a
 * bad edit can never reach the user's file. The write itself is a same-directory
 * atomic replacement: a crash leaves either the old config or the new one, never
 * a truncated one.
 */
export function installOpencodeCapture(input: {
  configPath: string;
  pluginPath: string;
}): InstallResult {
  const { configPath, pluginPath } = input;
  const fail = (reason: string): InstallResult => ({ status: "failed", path: configPath, reason });

  if (
    typeof pluginPath !== "string" ||
    pluginPath.trim() !== pluginPath ||
    pluginPath.length === 0
  ) {
    return fail(t("harness.pluginPathIsEmpty"));
  }

  // Identify the file before reading it, so the write at the end can prove it is
  // still replacing what it validated.
  const identity = identifyFile(configPath);

  let original: string;
  try {
    original = readFileSync(configPath, "utf8");
  } catch {
    return fail(t("harness.configUnreadable"));
  }

  const errors: ParseError[] = [];
  const current = parse(original, errors, { allowTrailingComma: true }) as
    Record<string, unknown> | undefined;
  if (errors.length > 0) {
    return fail(t("harness.configMalformed", { code: printParseErrorCode(errors[0]!.error) }));
  }
  if (current !== undefined && (typeof current !== "object" || Array.isArray(current))) {
    return fail(t("harness.configNotObject"));
  }

  const plugins = (current ?? {})["plugin"];
  if (plugins !== undefined && !Array.isArray(plugins)) {
    // Overwriting a key we do not understand is exactly the destructive edit
    // this installer exists to avoid.
    return fail(t("harness.pluginKeyNotList"));
  }
  const existing = (plugins ?? []) as unknown[];
  if (existing.includes(pluginPath)) return { status: "already-installed", path: configPath };

  const edits = modify(original, ["plugin"], [...existing, pluginPath], {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  const merged = applyEdits(original, edits);

  // Validate the RESULT, not just the input: an edit that produced something
  // unparseable must never be written.
  const mergedErrors: ParseError[] = [];
  const reparsed = parse(merged, mergedErrors, { allowTrailingComma: true }) as
    Record<string, unknown> | undefined;
  if (mergedErrors.length > 0 || parseTree(merged) === undefined) {
    return fail(t("harness.mergedConfigUnparsable"));
  }
  const mergedPlugins = (reparsed ?? {})["plugin"];
  if (!Array.isArray(mergedPlugins) || !mergedPlugins.includes(pluginPath)) {
    return fail(t("harness.mergedConfigLacksPlugin"));
  }
  for (const [key, value] of Object.entries(current ?? {})) {
    if (key === "plugin") continue;
    // Nothing the user had may disappear.
    if (JSON.stringify((reparsed ?? {})[key]) !== JSON.stringify(value)) {
      return fail(t("harness.mergedConfigWouldChange", { key }));
    }
  }

  try {
    // The identity observed BEFORE parsing: everything between then and now —
    // reading, editing, validating — is a window in which this path could come
    // to name a different file.
    atomicReplace(configPath, merged, { expect: identity });
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    return fail(t("harness.configReplaceFailed", { detail }));
  }
  return { status: "installed", path: configPath };
}
