/**
 * `--help` en un subcomando tiene que MOSTRAR ayuda, no ejecutar el comando.
 *
 * POR QUÉ ESTE TEST EXISTE
 * ------------------------
 * `mnemo install --help` corría la instalación completa. La flag no estaba
 * reconocida en ningún lado, así que caía al dispatch y `cmdInstall` la
 * ignoraba — `args.includes("--local")` es lo único que mira. El resultado fue
 * una instalación real para los cinco agentes detectados (claude-code, cursor,
 * opencode, codex, gemini-cli), escribiendo en ~/.cursor/mcp.json,
 * ~/.codex/config.toml y ~/.config/opencode/opencode.json, disparada por alguien
 * que sólo quería leer qué flags acepta el comando.
 *
 * Eso es lo que hace grave a este bug y no cosmético: `--help` es la forma
 * universal de preguntar ANTES de actuar. Un CLI que ejecuta cuando le
 * preguntás convierte la lectura de documentación en un efecto secundario, y
 * `install` es justo el comando cuyos efectos tocan archivos fuera del repo.
 *
 * EL CONTRATO
 * -----------
 *   - `--help`/`-h` en cualquier subcomando imprime la ayuda y sale sin correr
 *     nada
 *   - una flag desconocida en `install` es un error explícito, no silencio: el
 *     silencio es lo que dejó pasar `--help` en primer lugar
 *   - `install` sin flags y `install --local` siguen llegando al comando
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const { FAKE_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  return { FAKE_HOME: fs.mkdtempSync(os.tmpdir() + "/mnemo-help-flag-home-") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => FAKE_HOME };
});

import { main } from "../index.js";

// Config válida en el HOME falso: sin ella `install` sale temprano con "No API
// key found", y el test pasaría por el motivo equivocado.
mkdirSync(join(FAKE_HOME, ".mnemo"), { recursive: true });
writeFileSync(
  join(FAKE_HOME, ".mnemo", "config.json"),
  JSON.stringify({ url: "http://localhost:3939", apiKey: "mns_test_fake" })
);

async function runMain(
  argv: string[]
): Promise<{ out: string; errors: string; exitCode: string | null }> {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  // El env gana sobre el archivo; se limpia para que el HOME falso mande.
  delete process.env["MNEMO_URL"];
  delete process.env["MNEMO_KEY"];
  process.argv = ["node", "mnemo", ...argv];
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: string | null = null;
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => logs.push(args.map(String).join(" ")));
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => errors.push(args.map(String).join(" ")));
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    exitCode = String(code);
    throw new Error(`exit:${code}`);
  }) as (code?: string | number | null) => never);
  vi.stubGlobal("fetch", async () => {
    throw new Error("test: no network calls expected");
  });
  try {
    await main();
  } catch {
    // Esperado: process.exit() lanza.
  } finally {
    process.argv = originalArgv;
    process.env = originalEnv;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllGlobals();
  }
  return { out: logs.join("\n"), errors: errors.join("\n"), exitCode };
}

/**
 * Marcadores de que `cmdInstall` corrió de verdad. Cualquiera de los dos
 * significa que se pasó del parseo de flags y entró al comando: el primero es
 * su salida cuando encuentra agentes, el segundo cuando no encuentra ninguno.
 */
const INSTALL_RAN = /Detected agents:|No AI coding agents detected/;

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("--help nunca ejecuta el comando", () => {
  it("install --help muestra ayuda y NO instala", async () => {
    const { out, errors } = await runMain(["install", "--help"]);
    expect(out + errors).not.toMatch(INSTALL_RAN);
    expect(out).toMatch(/USAGE|COMMANDS|mnemo <command>/i);
  });

  it("install -h también", async () => {
    const { out, errors } = await runMain(["install", "-h"]);
    expect(out + errors).not.toMatch(INSTALL_RAN);
    expect(out).toMatch(/USAGE|COMMANDS|mnemo <command>/i);
  });

  it("recall --help no intenta hablar con el servidor", async () => {
    // recall exige config y haría fetch; el stub de fetch tira. Si --help se
    // respeta, nunca se llega ahí.
    const { out, errors } = await runMain(["recall", "--help"]);
    expect(errors).not.toMatch(/no network calls expected/);
    expect(out).toMatch(/USAGE|COMMANDS|mnemo <command>/i);
  });
});

describe("install rechaza flags que no conoce", () => {
  it("una flag desconocida es un error, no silencio", async () => {
    const { out, errors, exitCode } = await runMain(["install", "--dry-run"]);
    expect(errors).toMatch(/--dry-run/);
    expect(out).not.toMatch(INSTALL_RAN);
    expect(exitCode).toBe("2");
  });

  it("install sin flags sigue llegando al comando", async () => {
    // No-vacuidad: prueba que el guard de arriba rechaza por la flag y no
    // porque `install` esté roto de entrada.
    const { out, errors } = await runMain(["install"]);
    expect(out + errors).toMatch(INSTALL_RAN);
  });

  it("install --local sigue llegando al comando", async () => {
    const { out, errors } = await runMain(["install", "--local"]);
    expect(out + errors).toMatch(INSTALL_RAN);
  });
});
