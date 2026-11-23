/**
 * PR1 (cli-uimode-full-coverage) — sole owner of `uiMode` branching, the
 * emoji vocabulary, and the stream choice for CLI status lines. Every
 * command that prints a status/header line (as opposed to its actual
 * JSON/table payload) routes through `statusLine()` instead of
 * an inline `console.log`, so this is the one file a reviewer audits for
 * convention drift. Payload printing is never touched by this module.
 */

export type UiMode = "delight" | "verbose" | "quiet";
export type StatusKind = "read" | "write" | "destructive" | "admin";

const VALID_MODES: ReadonlySet<string> = new Set<UiMode>(["delight", "verbose", "quiet"]);

/**
 * Normalizes a raw `uiMode` value from `~/.mnemo/config.json` into the closed
 * `UiMode` set. The file is hand-editable, so a typo or absent key degrades
 * to the default instead of bricking every command — never throws/exits.
 */
export function resolveUiMode(raw: unknown): UiMode {
  return typeof raw === "string" && VALID_MODES.has(raw) ? (raw as UiMode) : "delight";
}

export interface StatusLineOptions {
  /** `config.uiMode`; `undefined` is treated the same as `"delight"`. */
  mode?: UiMode | undefined;
  kind: StatusKind;
  /** e.g. "Memory saved", "Recalling memories", "Workspace created". */
  action: string;
  /** preview / target / subject. */
  detail?: string | undefined;
  id?: string | undefined;
  /** Read headers: appends "…" and reproduces the recall header's trailing blank line. */
  pending?: boolean;
  /** `true` → emit nothing, in any mode (keeps `--json` byte-identical across modes). */
  json?: boolean;
}

// Closed emoji set (D8): one per StatusKind, not one per command.
const KIND_EMOJI: Record<StatusKind, string> = {
  write: "⬇️",
  read: "⬆️",
  destructive: "🗑️",
  admin: "🔑",
};

/**
 * Emits (or suppresses) exactly one status line on STDERR (CLIENTS-18: stdout
 * carries only the command's result, so `--json` and pipes stay clean), in this precedence order:
 * `json` overrides everything; `quiet` suppresses all kinds; `verbose`
 * suppresses `read` headers only (the payload IS the confirmation for
 * reads) but prints a plain `✓` line for the other three kinds; `delight`
 * always prints the tagged `🧠` line.
 */
export function statusLine(options: StatusLineOptions): void {
  const { kind, action, detail, id, pending = false, json = false } = options;
  if (json) return;

  const mode = options.mode ?? "delight";
  if (mode === "quiet") return;
  if (mode === "verbose" && kind === "read") return;

  const suffix = pending ? "…" : "";

  if (mode === "verbose") {
    const detailPart = detail ? `: ${detail}` : "";
    const idPart = id ? ` (${id})` : "";
    console.error(`✓ ${action}${detailPart}${idPart}${suffix}`);
    return;
  }

  const emoji = KIND_EMOJI[kind];
  const detailPart = detail ? `: "${detail}"` : "";
  const idPart = id ? ` (${id})` : "";
  const line = `🧠 ${emoji}  [mnemosyne] ${action}${detailPart}${idPart}${suffix}`;
  // pending reproduces cmdRecall's original header byte-for-byte: the embedded
  // trailing "\n" plus console.log's own newline == one blank line before the payload.
  console.error(pending ? `${line}\n` : line);
}
