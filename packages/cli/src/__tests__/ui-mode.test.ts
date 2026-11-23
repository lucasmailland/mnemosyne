/**
 * PR1 (cli-uimode-full-coverage) — unit tests for the sole owner of
 * `uiMode` branching, emoji vocabulary, and stream choice.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { statusLine, resolveUiMode, type UiMode, type StatusKind } from "../ui-mode.js";

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "error") // banners are written to stderr (CLIENTS-18)
    .mockImplementation((...args: unknown[]) => lines.push(String(args[0])));
  return { lines, restore: () => spy.mockRestore() };
}

describe("resolveUiMode", () => {
  it("passes through each valid value unchanged", () => {
    expect(resolveUiMode("delight")).toBe("delight");
    expect(resolveUiMode("verbose")).toBe("verbose");
    expect(resolveUiMode("quiet")).toBe("quiet");
  });

  it("normalizes garbage, absent, or wrongly-typed values to delight (config.json is hand-editable)", () => {
    for (const raw of ["loud", "", 42, null, undefined, {}, ["delight"]]) {
      expect(resolveUiMode(raw)).toBe("delight");
    }
  });
});

const EMOJI: Record<StatusKind, string> = {
  write: "⬇️",
  read: "⬆️",
  destructive: "🗑️",
  admin: "🔑",
};

/** Mirrors the design's emission matrix precedence: json > quiet > verbose+read silent > verbose > delight. */
function expectedOutput(
  mode: UiMode,
  kind: StatusKind,
  json: boolean,
  pending: boolean
): string | null {
  if (json || mode === "quiet" || (mode === "verbose" && kind === "read")) return null;
  const suffix = pending ? "…" : "";
  if (mode === "verbose") return `✓ Did thing: some detail (abc123)${suffix}`;
  const line = `🧠 ${EMOJI[kind]}  [mnemosyne] Did thing: "some detail" (abc123)${suffix}`;
  return pending ? `${line}\n` : line;
}

describe("statusLine — full emission matrix (3 modes × 4 kinds × json on/off × pending)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("matches the expected output (or silence) for every combination", () => {
    const modes: UiMode[] = ["delight", "verbose", "quiet"];
    const kinds: StatusKind[] = ["read", "write", "destructive", "admin"];
    const { lines, restore } = captureLog();

    for (const mode of modes) {
      for (const kind of kinds) {
        for (const json of [false, true]) {
          for (const pending of [false, true]) {
            lines.length = 0;
            statusLine({
              mode,
              kind,
              action: "Did thing",
              detail: "some detail",
              id: "abc123",
              pending,
              json,
            });
            const expected = expectedOutput(mode, kind, json, pending);
            expect(lines, `mode=${mode} kind=${kind} json=${json} pending=${pending}`).toEqual(
              expected === null ? [] : [expected]
            );
          }
        }
      }
    }
    restore();
  });
});

describe("statusLine — mode defaults, optional fields, and byte-exact precedents", () => {
  afterEach(() => vi.restoreAllMocks());

  it("treats an undefined mode the same as delight", () => {
    const { lines, restore } = captureLog();
    statusLine({ kind: "write", action: "Saved" });
    restore();
    expect(lines).toEqual(["🧠 ⬇️  [mnemosyne] Saved"]);
  });

  it("omits the detail and id segments entirely when not provided", () => {
    const { lines, restore } = captureLog();
    statusLine({ mode: "verbose", kind: "admin", action: "Revoked" });
    restore();
    expect(lines).toEqual(["✓ Revoked"]);
  });

  it("reproduces cmdRecall's original delight header byte-for-byte via pending", () => {
    const { lines, restore } = captureLog();
    statusLine({
      mode: "delight",
      kind: "read",
      action: 'Recalling memories for "generics"',
      pending: true,
    });
    restore();
    expect(lines).toEqual([`🧠 ⬆️  [mnemosyne] Recalling memories for "generics"…\n`]);
  });

  it("reproduces cmdRemember's original delight confirmation byte-for-byte", () => {
    const { lines, restore } = captureLog();
    statusLine({
      mode: "delight",
      kind: "write",
      action: "Memory saved",
      detail: "TypeScript generics allow type-safe reuse",
      id: "fact-new-001",
    });
    restore();
    expect(lines).toEqual([
      '🧠 ⬇️  [mnemosyne] Memory saved: "TypeScript generics allow type-safe reuse" (fact-new-001)',
    ]);
  });

  it("uses the destructive (🗑️) and admin (🔑) emoji under delight", () => {
    const { lines, restore } = captureLog();
    statusLine({ mode: "delight", kind: "destructive", action: "Forgotten", id: "fact-1" });
    statusLine({ mode: "delight", kind: "admin", action: "Revoked", id: "key-1" });
    restore();
    expect(lines[0]).toContain("🗑️");
    expect(lines[1]).toContain("🔑");
  });
});
