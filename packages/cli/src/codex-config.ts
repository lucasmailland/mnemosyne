/**
 * Codex's `features.hooks` gate, read by parsing TOML rather than by matching text.
 *
 * The previous reader was
 * `/^\s*hooks\s*=\s*true/m.test(toml.split("[features]")[1] ?? "")`, which has no
 * notion of where a table ends or which table a key belongs to. Three consequences,
 * all verified against real documents:
 *
 *   - `[features]` followed later by `[features.experimental]\nhooks = true` reads
 *     as ENABLED. `"[features.experimental]"` does not contain the substring
 *     `"[features]"`, so the split keeps the whole rest of the file and the `/m`
 *     regex matches a line belonging to another table.
 *   - Any later table with `hooks = true` reads as enabled, for the same reason.
 *   - `features = { hooks = true }` (inline table, no header) reads as DISABLED.
 *
 * The first two say capture works when it cannot; the qualifier then writes a
 * record claiming capture is possible and the operator is told it works. That is
 * the failure this whole mechanism exists to prevent, produced by the mechanism.
 *
 * This module is deliberately PURE and I/O-free (`string` in, verdict out) so the
 * documents above are one-line test cases instead of filesystem fixtures, and it
 * is a separate export entry so the qualifier can import it without executing the
 * CLI's `bin` dispatch.
 */

import { t } from "./i18n/index.js";
import { chmodSync, readFileSync } from "node:fs";

import { parse, TomlError } from "smol-toml";

import { atomicReplace, identifyFile, resolveWriteTarget } from "./atomic-file.js";
import type { InstallResult } from "./harness-install.js";

export type GateRead =
  { status: "read"; enabled: boolean } | { status: "malformed"; reason: string };

/**
 * Whether Codex hooks are enabled by this config text.
 *
 * `malformed` is never collapsed into `enabled: false`: "off" and "unreadable"
 * demand different answers from the installer — one is a thing to offer to fix,
 * the other is a config we must not touch.
 */
export function readCodexHooksGate(tomlText: string): GateRead {
  let document: unknown;
  try {
    document = parse(tomlText);
  } catch (cause) {
    const reason = cause instanceof TomlError ? cause.message : String(cause);
    return { status: "malformed", reason };
  }

  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { status: "malformed", reason: t("capture.configTomlNotTable") };
  }

  const features = (document as Record<string, unknown>)["features"];
  // A `features` that is not a table cannot own a `hooks` key. Notably
  // `[features.experimental]` alone DOES produce a `features` table here — one
  // whose `hooks` is undefined, which is exactly the right answer.
  if (typeof features !== "object" || features === null || Array.isArray(features)) {
    return { status: "read", enabled: false };
  }

  // The boolean `true` and nothing else. `"true"` and `1` are not enablement:
  // Codex reads this key as a boolean, so anything else leaves hooks off, and
  // guessing otherwise would put us back to claiming capture that never happens.
  return { status: "read", enabled: (features as Record<string, unknown>)["hooks"] === true };
}

/**
 * Enable `features.hooks` in a Codex config without rewriting the rest of it.
 *
 * `smol-toml` has no edit API — only `parse` and `stringify` — and stringifying a
 * parsed document reformats it and drops every comment. So the parse decides
 * WHETHER and WHERE, a line splice only APPLIES, and a reparse decides whether to
 * KEEP it. The scanner never interprets TOML: it locates a key whose existence
 * and table ownership the parse already established.
 *
 * Where a splice cannot be unique — a dotted key, an inline table, a duplicated
 * assignment — this refuses and names the shape. Those are legal TOML that cannot
 * be edited by line without restructuring the operator's file, and a correct edit
 * that silently reformats someone's config is still a file they did not ask us to
 * rewrite.
 */
export function enableCodexHooks(input: { configPath: string }): InstallResult {
  const { configPath } = input;
  const fail = (reason: string): InstallResult => ({ status: "failed", path: configPath, reason });

  // A dotfiles symlink is followed here, once: the target is replaced, the link kept.
  const target = resolveWriteTarget(configPath);
  const identity = identifyFile(target);

  let original: string;
  try {
    original = readFileSync(target, "utf8");
  } catch {
    return fail(t("capture.configUnreadable"));
  }

  const gate = readCodexHooksGate(original);
  if (gate.status === "malformed")
    return fail(t("capture.configIsMalformed", { reason: gate.reason }));
  if (gate.enabled) return { status: "already-installed", path: configPath };

  let document: Record<string, unknown>;
  try {
    document = parse(original) as Record<string, unknown>;
  } catch (cause) {
    return fail(t("capture.configIsMalformed", { reason: String(cause) }));
  }

  const located = locateHooksEdit(original);
  if ("reason" in located) return fail(located.reason);

  const merged = applyEdit(original, located);

  // Validate the RESULT. An edit that produced something unparseable, or that
  // moved anything other than this one key, must never reach the user's file.
  const verify = readCodexHooksGate(merged);
  if (verify.status === "malformed") return fail(t("capture.mergedConfigUnparsable"));
  if (!verify.enabled) return fail(t("capture.mergedConfigLacksHooks"));

  let reparsed: Record<string, unknown>;
  try {
    reparsed = parse(merged) as Record<string, unknown>;
  } catch {
    return fail(t("capture.mergedConfigUnparsable"));
  }
  if (canonical(withoutHooks(document)) !== canonical(withoutHooks(reparsed))) {
    return fail(t("capture.mergedConfigWouldChange"));
  }

  try {
    atomicReplace(target, merged, { expect: identity });
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    return fail(t("capture.configReplaceFailed", { detail }));
  }
  return { status: "installed", path: configPath };
}

/** Where and how to splice, or why we will not. */
type HooksEdit =
  | { kind: "replace-value"; line: number }
  | { kind: "insert-after"; line: number }
  | { kind: "append-table" }
  | { reason: string };

const TABLE_HEADER = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/;
/** `hooks = <value>` with optional indentation and a trailing comment. */
const HOOKS_ASSIGNMENT = /^(\s*)(hooks|"hooks"|'hooks')(\s*=\s*)([^#]*?)(\s*)(#.*)?$/;

function locateHooksEdit(text: string): HooksEdit {
  const lines = text.split("\n");
  const headers: number[] = [];
  const assignments: number[] = [];
  const rootAssignments: string[] = [];
  let current: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const header = TABLE_HEADER.exec(lines[index]!);
    if (header) {
      current = header[1]!.trim();
      // `[features]` only. `[features.experimental]` is a DIFFERENT table, and
      // reading its keys as this one's is exactly the bug this module replaced.
      if (current === "features") headers.push(index);
      continue;
    }
    if (current === "features" && HOOKS_ASSIGNMENT.test(lines[index]!)) {
      assignments.push(index);
      continue;
    }
    // The shapes a line splice cannot edit have to be found by looking at the
    // ROOT table's own lines. Asking the parse instead does not work: a document
    // containing only `[features.experimental]` yields a `features` table that
    // no line ever wrote, and refusing on that would refuse a config we can
    // append to perfectly safely.
    if (current === null) {
      if (/^\s*features\s*=/.test(lines[index]!)) rootAssignments.push(t("capture.inlineTable"));
      else if (/^\s*features\s*\./.test(lines[index]!))
        rootAssignments.push(t("capture.dottedKey"));
    }
  }

  if (headers.length > 1) {
    return { reason: t("capture.configDeclaresFeaturesMore") };
  }
  if (assignments.length > 1) {
    return { reason: t("capture.configAssignsFeaturesHooks") };
  }

  if (headers.length === 1) {
    return assignments.length === 1
      ? { kind: "replace-value", line: assignments[0]! }
      : { kind: "insert-after", line: headers[0]! };
  }

  // No `[features]` header. A root-level assignment to `features` means the
  // table is written as a dotted key or an inline table — legal TOML, but not
  // something a line splice can edit without restructuring the document.
  if (rootAssignments.length > 0) {
    return {
      reason: t("capture.featuresDeclaredAs", { form: rootAssignments[0]! }),
    };
  }
  return { kind: "append-table" };
}

function applyEdit(text: string, edit: HooksEdit): string {
  const lines = text.split("\n");
  if ("kind" in edit && edit.kind === "replace-value") {
    const parts = HOOKS_ASSIGNMENT.exec(lines[edit.line]!)!;
    // Indentation, key spelling, spacing and any trailing comment all survive;
    // only the value between them changes.
    const [, indent, key, equals, , gap, comment] = parts;
    lines[edit.line] = `${indent}${key}${equals}true${comment ? `${gap}${comment}` : ""}`;
    return lines.join("\n");
  }
  if ("kind" in edit && edit.kind === "insert-after") {
    lines.splice(edit.line + 1, 0, "hooks = true");
    return lines.join("\n");
  }
  // Appending a header last is safe by TOML's grammar: a table extends to the
  // next header or EOF, so one added at the end can capture nothing.
  const body = text.endsWith("\n") || text === "" ? text : `${text}\n`;
  const separator = body === "" || body.endsWith("\n\n") ? "" : "\n";
  return `${body}${separator}[features]\nhooks = true\n`;
}

/** A copy of the document with only `features.hooks` removed. */
function withoutHooks(document: Record<string, unknown>): Record<string, unknown> {
  const features = document["features"];
  if (typeof features !== "object" || features === null || Array.isArray(features)) {
    return document;
  }
  const { hooks: _removed, ...rest } = features as Record<string, unknown>;
  // A `features` table that held nothing but `hooks` is indistinguishable from
  // no table at all for this comparison — which is the whole point when the edit
  // is the one that created it.
  if (Object.keys(rest).length === 0) {
    const { features: _dropped, ...withoutTable } = document;
    return withoutTable;
  }
  return { ...document, features: rest };
}

/**
 * Order-independent serialisation for the "nothing else moved" comparison.
 *
 * `JSON.stringify` alone is not enough: `smol-toml` yields `TomlDate` for date
 * values, and a plain deep-equal over those is not reliable. The `bigint` arm is
 * defensive — this version of `smol-toml` rejects integers outside the safe
 * range at parse time rather than widening them — but it costs one line and the
 * alternative failure is a throw inside a check that exists to protect a file.
 */
function canonical(value: unknown): string {
  if (typeof value === "bigint") return `"bigint:${value.toString()}"`;
  if (value instanceof Date) return `"date:${value.toISOString()}"`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

/** What `mnemo install` registers under `[mcp_servers.mnemosyne]`. */
export interface CodexMcpServer {
  command: string;
  args: string[];
  url: string;
  key: string;
}

export type CodexMcpMerge =
  { ok: true; text: string; repaired: boolean } | { ok: false; reason: string };

/**
 * Set `mcp_servers.mnemosyne` in a Codex config, touching nothing else.
 *
 * Same division of labour as `enableCodexHooks`, for the same reason:
 * A parse-and-re-serialise round trip would be the short way and it deletes
 * every comment in the operator's file. So we render only OUR tables (TOML basic
 * strings accept JSON's escapes), a line scanner only LOCATES the previous ones,
 * and two parses decide whether the result may be kept: everything outside `mcp_servers.mnemosyne` must compare equal before
 * and after, and the entry itself must equal what was asked for. A document the
 * scanner misreads (a header-looking line inside a multi-line string, an inline
 * table, a dotted key) therefore ends in a refusal, never in a different config.
 *
 * Comments inside the previous mnemosyne tables go with them: that block is
 * ours and is rewritten whole. Every byte outside it is kept.
 *
 * Pure: text in, text out. The file handling is `registerCodexMcpServer`.
 */
export function mergeCodexMcpServer(original: string, server: CodexMcpServer): CodexMcpMerge {
  const wanted = {
    command: server.command,
    args: server.args,
    env: { MNEMO_URL: server.url, MNEMO_KEY: server.key },
  };

  let text = original;
  let before = parseTable(text);
  let repaired = false;
  if ("error" in before) {
    // Only one kind of broken file is ours to fix: see `withoutLegacyLeftovers`.
    const candidate = withoutLegacyLeftovers(text, server.args);
    const reparsed = candidate === text ? before : parseTable(candidate);
    if ("error" in reparsed) return { ok: false, reason: before.error };
    text = candidate;
    before = reparsed;
    repaired = true;
  }

  const str = (value: string) => JSON.stringify(value);
  const block = [
    "[mcp_servers.mnemosyne]",
    `command = ${str(server.command)}`,
    `args = [${server.args.map(str).join(", ")}]`,
    "",
    "[mcp_servers.mnemosyne.env]",
    `MNEMO_URL = ${str(server.url)}`,
    `MNEMO_KEY = ${str(server.key)}`,
  ];
  const merged = spliceMnemosyneTables(text, block);

  const after = parseTable(merged);
  if (
    "error" in after ||
    canonical(withoutMnemosyneServer(after.document)) !==
      canonical(withoutMnemosyneServer(before.document)) ||
    canonical(mnemosyneServer(after.document)) !== canonical(wanted)
  ) {
    return { ok: false, reason: t("install.codexEntryNotEditable") };
  }
  return { ok: true, text: merged, repaired };
}

/**
 * Register the MCP server in the Codex config at `configPath`.
 *
 * Nothing is written unless the merge verified, and the write is a same-directory
 * atomic replacement, so the file is the old config or the new one and never a
 * truncated one. The mode is forced to 0600: the file now holds an API key, and
 * the installer this replaces created it with the process umask.
 */
export function registerCodexMcpServer(input: {
  configPath: string;
  server: CodexMcpServer;
}): InstallResult & { repaired?: boolean } {
  const { configPath, server } = input;
  const fail = (reason: string): InstallResult => ({ status: "failed", path: configPath, reason });

  // A dotfiles symlink is followed here, once: the target is replaced, the link kept.
  const target = resolveWriteTarget(configPath);
  const identity = identifyFile(target);
  let original = "";
  if (identity) {
    try {
      original = readFileSync(target, "utf8");
    } catch {
      return fail(t("capture.configUnreadable"));
    }
  }

  const merge = mergeCodexMcpServer(original, server);
  if (!merge.ok) return fail(merge.reason);

  if (identity && merge.text === original) {
    try {
      // The old installer left the key in a file readable by everyone.
      chmodSync(target, 0o600);
    } catch {
      /* not ours to change — the content is already right */
    }
    return { status: "already-installed", path: configPath };
  }

  try {
    atomicReplace(target, merge.text, { expect: identity, mode: 0o600 });
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    return fail(t("capture.configReplaceFailed", { detail }));
  }
  return { status: "installed", path: configPath, repaired: merge.repaired };
}

function parseTable(text: string): { document: Record<string, unknown> } | { error: string } {
  try {
    return { document: parse(text) as Record<string, unknown> };
  } catch (cause) {
    if (!(cause instanceof TomlError)) return { error: String(cause) };
    // The first line only. The rest of a TomlError message quotes the lines
    // around the fault, and in this file one of them is `MNEMO_KEY = "..."`.
    return {
      error: t("install.codexInvalidToml", {
        line: String(cause.line),
        column: String(cause.column),
        message: cause.message.split("\n")[0]!,
      }),
    };
  }
}

/**
 * Undo what the regex-based installer did to this file on its second run.
 *
 * It deleted "from the mnemosyne header up to the next `[`", and the next `[`
 * was the one opening `args = [...]`. What survived is the array on a line of
 * its own, once per reinstall — a line this tool wrote, in a spelling only it
 * produced. Removing exactly those lines is the whole repair; the caller keeps
 * the result only if it then parses, so a file broken in any other way (or in
 * this way AND another) is left for its owner.
 */
function withoutLegacyLeftovers(text: string, args: string[]): string {
  const leftover = `[${args.map((arg) => JSON.stringify(arg)).join(", ")}]`;
  return text
    .split("\n")
    .filter((line) => line.trim() !== leftover)
    .join("\n");
}

/** `[mcp_servers.mnemosyne]` and its sub-tables, however the header is spaced or quoted. */
function isMnemosyneHeader(line: string): boolean {
  const header = TABLE_HEADER.exec(line);
  if (!header) return false;
  const path = header[1]!.replace(/[\s"']/g, "");
  return path === "mcp_servers.mnemosyne" || path.startsWith("mcp_servers.mnemosyne.");
}

const BLANK_OR_COMMENT = /^\s*(?:#.*)?$/;

/**
 * Put `block` where the mnemosyne tables are, or at the end when there are none.
 *
 * A run of consecutive mnemosyne tables is one span. It stops before the blank
 * lines and comments that lead into the next table, because a comment above
 * `[profiles.fast]` is about `[profiles.fast]`.
 */
function spliceMnemosyneTables(text: string, block: string[]): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let placed = false;
  let inside = false;
  let pending: string[] = []; // blank/comment lines seen inside a span, not yet attributed

  for (const line of lines) {
    if (TABLE_HEADER.test(line)) {
      const ours = isMnemosyneHeader(line);
      if (ours && !placed) {
        out.push(...block);
        placed = true;
      }
      // Between two of our own tables the gap is ours; before anyone else's it is theirs.
      if (!ours) out.push(...pending);
      pending = [];
      inside = ours;
      if (!ours) out.push(line);
      continue;
    }
    if (!inside) out.push(line);
    else if (BLANK_OR_COMMENT.test(line)) pending.push(line);
    else pending = [];
  }
  out.push(...pending);

  if (placed) return out.join("\n");
  // Appending a table last is safe by TOML's grammar: it can capture nothing.
  const body = text.endsWith("\n") || text === "" ? text : `${text}\n`;
  const separator = body === "" || body.endsWith("\n\n") ? "" : "\n";
  return `${body}${separator}${block.join("\n")}\n`;
}

function mnemosyneServer(document: Record<string, unknown>): unknown {
  const servers = document["mcp_servers"];
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return undefined;
  return (servers as Record<string, unknown>)["mnemosyne"];
}

/** A copy of the document with only `mcp_servers.mnemosyne` removed. */
function withoutMnemosyneServer(document: Record<string, unknown>): Record<string, unknown> {
  const servers = document["mcp_servers"];
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return document;
  const { mnemosyne: _removed, ...rest } = servers as Record<string, unknown>;
  // As in `withoutHooks`: a table that held nothing else is no table at all here.
  if (Object.keys(rest).length === 0) {
    const { mcp_servers: _dropped, ...withoutTable } = document;
    return withoutTable;
  }
  return { ...document, mcp_servers: rest };
}
