/**
 * `mnemo config set recallTimeoutMs <ms>` — la mitad usable de la clave.
 *
 * `recallTimeoutMs` la consume el hook user-prompt-submit.sh (vía
 * get_recall_timeout en _helpers.sh) para acotar el recall automático. Existe
 * porque el presupuesto estaba clavado en 1.5s, medido contra el stack local:
 * contra un servidor remoto con embeddings de Bedrock el mismo recall cuesta
 * entre 0.53s y 1.82s según pegue la caché, así que el corte caía en el medio
 * de la distribución y el recall fallaba de forma intermitente.
 *
 * Pero `cmdConfigSet` valida contra una lista blanca de claves. Sin agregarla
 * ahí, la única forma de configurarla es editar ~/.mnemo/config.json a mano —
 * y una opción que exige editar JSON a mano no está realmente entregada.
 *
 * El contrato:
 *   - un entero positivo se acepta y se persiste COMO NÚMERO (no string: el
 *     helper valida con la regex /^[0-9]+$/ sobre lo que devuelve jq, y
 *     `"3000"` con comillas la pasaría igual, pero el archivo quedaría con dos
 *     tipos distintos para la misma clave según quién la escribió)
 *   - lo no numérico, el cero y el negativo se rechazan ACÁ, con un mensaje,
 *     en vez de escribir un valor que el hook va a descartar en silencio
 *   - la clave sigue siendo opcional: nada de esto le cambia el default a
 *     quien nunca la setea
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const { FAKE_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  return { FAKE_HOME: fs.mkdtempSync(os.tmpdir() + "/mnemo-recall-timeout-home-") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => FAKE_HOME };
});

import { main } from "../index.js";

const CONFIG_FILE = join(FAKE_HOME, ".mnemo", "config.json");

async function runMain(argv: string[]): Promise<{ logs: string[]; errors: string[] }> {
  const originalArgv = process.argv;
  process.argv = ["node", "mnemo", ...argv];
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => logs.push(String(args[0])));
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => errors.push(String(args[0])));
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new Error(`exit:${code}`);
  }) as (code?: string | number | null) => never);
  try {
    await main();
  } catch {
    // Esperado: process.exit() lanza.
  } finally {
    process.argv = originalArgv;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { logs, errors };
}

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("mnemo config set recallTimeoutMs", () => {
  it("acepta un entero positivo y lo persiste como número", async () => {
    const { errors } = await runMain(["config", "set", "recallTimeoutMs", "3000"]);
    expect(errors.join("\n")).not.toMatch(/Unknown config key/);
    expect(readConfig()["recallTimeoutMs"]).toBe(3000);
  });

  it("rechaza un valor no numérico en vez de escribir algo que el hook descarta", async () => {
    await runMain(["config", "set", "recallTimeoutMs", "3000"]);
    const { errors } = await runMain(["config", "set", "recallTimeoutMs", "rapido"]);
    expect(errors.join("\n")).toMatch(/recallTimeoutMs/);
    // El valor previo, válido, sobrevive al intento fallido.
    expect(readConfig()["recallTimeoutMs"]).toBe(3000);
  });

  it("rechaza cero — para curl significa 'sin límite', lo contrario de lo que se pidió", async () => {
    await runMain(["config", "set", "recallTimeoutMs", "3000"]);
    const { errors } = await runMain(["config", "set", "recallTimeoutMs", "0"]);
    expect(errors.join("\n")).toMatch(/recallTimeoutMs/);
    expect(readConfig()["recallTimeoutMs"]).toBe(3000);
  });

  it("sigue aceptando las claves de siempre — la lista blanca se amplió, no se reemplazó", async () => {
    const { errors } = await runMain(["config", "set", "url", "https://mnemosyne.example.com"]);
    expect(errors.join("\n")).not.toMatch(/Unknown config key/);
    expect(readConfig()["url"]).toBe("https://mnemosyne.example.com");
  });
});
