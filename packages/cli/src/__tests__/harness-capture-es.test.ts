import { describe, it, expect, afterEach } from "vitest";
import { setLocale } from "../i18n/index.js";
import { runHarnessCommand, type HarnessCommandDeps } from "../harness-commands.js";
import { renderCaptureSummary } from "../capture-install.js";
import { parseInstallArgs } from "../install-args.js";

afterEach(() => {
  setLocale("en-US");
});

describe("install arguments in Spanish", () => {
  it("the install argument parser reports in Spanish and stays English by default", () => {
    setLocale("es-419");
    const es = parseInstallArgs(["--capture", "nope"]);
    expect(es.ok).toBe(false);
    if (!es.ok)
      expect(es.error).toBe(
        "--capture: host desconocido 'nope'. Hosts válidos: opencode, claude-code, codex."
      );
    setLocale("en-US");
    const en = parseInstallArgs(["--capture", "nope"]);
    if (!en.ok)
      expect(en.error).toBe(
        "--capture: unknown host 'nope'. Valid hosts: opencode, claude-code, codex."
      );
  });
});

describe("harness and capture output in Spanish", () => {
  function deps(): HarnessCommandDeps & { lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      out: (l) => void lines.push(l),
      err: (l) => void lines.push(l),
      confirm: async () => true,
      diagnose: async () => {
        throw new Error("unused");
      },
      listQueue: async () => ({ pending: [], quarantined: [] }),
      releaseRetry: async () => ({ released: 3, bindingChanged: false }),
      discardQueue: async () => ({ discarded: 0 }),
      probe: async () => ({ available: true, workspaceId: "w", persisted: false }),
      captureHook: async () => ({ durable: true }),
    };
  }

  it("queue and retry speak Spanish", async () => {
    setLocale("es-419");
    const d = deps();
    await runHarnessCommand(["queue"], d);
    await runHarnessCommand(["retry"], d);
    expect(d.lines).toEqual([
      "la cola está vacía (0 pendientes, 0 en cuarentena)",
      "se liberaron 3 registro(s) en cola para entregarlos",
    ]);
  });

  it("the harness help is localized and English by default", async () => {
    const d = deps();
    await runHarnessCommand([], d);
    expect(d.lines[0]).toContain("Show queued and quarantined records");
    setLocale("es-419");
    const d2 = deps();
    await runHarnessCommand([], d2);
    expect(d2.lines[0]).toContain("Muestra los registros en cola y en cuarentena");
  });

  it("the capture summary is localized", () => {
    setLocale("es-419");
    const lines = renderCaptureSummary([
      { host: "codex", mode: "mcp-only", reason: "r", consent: "declined", artifact: "skipped" },
    ] as never);
    expect(lines).toEqual([
      "",
      "Captura:",
      "  codex: no configurado (mcp-only)",
      "    motivo: r",
      "    rechazaste este",
    ]);
  });
});
