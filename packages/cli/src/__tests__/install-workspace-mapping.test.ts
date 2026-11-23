/**
 * `mnemo install` tiene que escribir el workspace REAL en workspaces.json.
 *
 * POR QUÉ
 * -------
 * Escribía el literal `"unknown"` y anunciaba `✅ Workspace mapping saved for
 * project: <nombre>` — un falso verde de manual. El servidor sabe la respuesta
 * y siempre la supo: `GET /me` devuelve `workspaceId` para la key que el
 * instalador ya tiene en la mano. Nunca la preguntó.
 *
 * Lo que rompe: `get_workspace_id()` (packages/plugin/scripts/_helpers.sh) lee
 * ese archivo para saber a qué workspace pertenece el proyecto. Con `"unknown"`
 * los hooks quedan con un id que no existe, y el instalador ya dijo que estaba
 * todo bien. El usuario no tiene motivo para ir a mirar.
 *
 * EL CONTRATO
 * -----------
 *   - con /me disponible, el mapping guarda el workspaceId que devuelve
 *   - una entrada previa con "unknown" se CORRIGE; el guard `if (!wsData[p])`
 *     original la dejaba clavada para siempre, así que quien ya la tiene rota
 *     no se cura reinstalando
 *   - si /me no contesta, NO se inventa un valor ni se anuncia éxito: se dice
 *     qué pasó. Un mapping ausente es recuperable; uno mentiroso no se nota.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const { FAKE_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  return { FAKE_HOME: fs.mkdtempSync(os.tmpdir() + "/mnemo-install-ws-home-") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => FAKE_HOME };
});

import { main } from "../index.js";
import { detectProjectName } from "../commands.js";

const REAL_WS = "dcb01cb3-97da-410f-a074-d81bea9eb7b1";
const WS_FILE = join(FAKE_HOME, ".mnemo", "workspaces.json");

/**
 * `install` sale temprano ("No AI coding agents detected") antes de escribir el
 * mapping si no encuentra ningún agente. Un `.cursor/` vacío alcanza para que
 * detecte uno — y es el más inocuo: todo lo que escribe cae dentro del HOME
 * falso.
 */
function seedHome(): void {
  mkdirSync(join(FAKE_HOME, ".mnemo"), { recursive: true });
  mkdirSync(join(FAKE_HOME, ".cursor"), { recursive: true });
  writeFileSync(
    join(FAKE_HOME, ".mnemo", "config.json"),
    JSON.stringify({ url: "http://localhost:3939", apiKey: "mns_test_fake" })
  );
}

/** fetch que responde /me y deja pasar el resto como 200 vacío. */
function fetchWithMe(me: Record<string, unknown> | null): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/me")) {
      if (me === null) {
        return { ok: false, status: 503, headers: new Headers(), text: async () => "down" };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => me,
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({}),
    };
  }) as unknown as typeof fetch;
}

async function runInstall(fetchImpl: typeof fetch): Promise<string> {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  delete process.env["MNEMO_URL"];
  delete process.env["MNEMO_KEY"];
  process.argv = ["node", "mnemo", "install"];
  const logs: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(" ")));
  const warnSpy = vi
    .spyOn(console, "warn")
    .mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(" ")));
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(" ")));
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((c?: string | number | null) => {
    throw new Error(`exit:${c}`);
  }) as (c?: string | number | null) => never);
  vi.stubGlobal("fetch", fetchImpl);
  try {
    await main();
  } catch {
    /* exit lanza */
  } finally {
    process.argv = originalArgv;
    process.env = originalEnv;
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllGlobals();
  }
  return logs.join("\n");
}

function readWorkspaces(): Record<string, { workspaceId?: string }> {
  if (!existsSync(WS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(WS_FILE, "utf8"));
  } catch {
    return {};
  }
}

beforeEach(() => {
  rmSync(join(FAKE_HOME, ".mnemo"), { recursive: true, force: true });
  seedHome();
});

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

// Each run spawns `which` four times and `git` twice, and the first loads the
// install path's lazy imports: 0.2 s idle, 4.4 s measured under load.
describe("mnemo install — mapping de workspace", { timeout: 30_000 }, () => {
  it("guarda el workspaceId que devuelve /me, no 'unknown'", async () => {
    await runInstall(fetchWithMe({ workspaceId: REAL_WS, workspaceName: "first-test" }));
    const ws = readWorkspaces();
    const ids = Object.values(ws).map((v) => v.workspaceId);
    expect(ids).not.toContain("unknown");
    expect(ids).toContain(REAL_WS);
  });

  it("corrige una entrada previa que quedó en 'unknown'", async () => {
    // The entry is keyed by the project install detects (git remote or checkout name), so a
    // clone under any name or remote seeds the entry install will actually rewrite.
    const project = await detectProjectName(process.cwd());
    writeFileSync(
      WS_FILE,
      JSON.stringify({ [project]: { workspaceId: "unknown", url: "http://localhost:3939" } })
    );
    await runInstall(fetchWithMe({ workspaceId: REAL_WS }));
    const ids = Object.values(readWorkspaces()).map((v) => v.workspaceId);
    expect(ids).not.toContain("unknown");
  });

  it("si /me no contesta no inventa un valor ni anuncia éxito", async () => {
    const out = await runInstall(fetchWithMe(null));
    const ids = Object.values(readWorkspaces()).map((v) => v.workspaceId);
    expect(ids).not.toContain("unknown");
    expect(out).not.toMatch(/✅ Workspace mapping saved/);
  });
});
