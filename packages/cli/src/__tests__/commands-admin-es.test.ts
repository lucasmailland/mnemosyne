import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { COMMANDS, fetchAndPrintSetupBanner } from "../commands.js";
import { setLocale } from "../i18n/index.js";

const config = {
  url: "http://localhost:3939",
  apiKey: "mk_test_abc_xyz",
  uiMode: "delight",
} as const;

let out: string[];
let err: string[];

function stubFetch(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
        text: async () => JSON.stringify(body),
      }) as unknown as Response
  );
}

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation(
    (...a: unknown[]) => void out.push(a.map(String).join(" "))
  );
  vi.spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => void err.push(a.map(String).join(" "))
  );
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
});

afterEach(() => {
  setLocale("en-US");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The same width the code pads with: `String#length` (padEnd counts UTF-16 units). */
const width = (s: string): number => s.length;

async function banner(): Promise<string[]> {
  stubFetch({ token: "tok", setupUrl: "http://localhost:3939/setup?token=tok" });
  await fetchAndPrintSetupBanner(3939);
  return out.join("\n").split("\n").filter(Boolean);
}

describe("setup banner", () => {
  it("has equal visible width on every translated line in Spanish", async () => {
    setLocale("es-419");
    const lines = await banner();
    expect(lines.join("\n")).toContain("ASISTENTE DE CONFIGURACIÓN DE MNEMOSYNE");
    expect(lines.join("\n")).toContain("El token vence en 15 minutos.");
    // The URL line too: it used to run 2 columns past the box (H7).
    const widths = new Set(lines.map(width));
    expect([...widths]).toEqual([width(lines[0]!)]);
    expect(lines).toHaveLength(6);
  });

  it("keeps the same widths in English, the URL line included", async () => {
    const lines = await banner();
    expect(new Set(lines.map(width)).size).toBe(1);
    expect(lines.join("\n")).toContain("MNEMOSYNE SETUP WIZARD");
  });
});

describe("setup banner with a real setup URL", () => {
  // A real token is a UUID, so the URL runs past the old 56-column box.
  const realUrl =
    "http://localhost:3939/dashboard/setup?token=d0522e17-bd87-4ced-bc38-2b9a499beea7";
  for (const locale of ["en-US", "es-419"] as const) {
    it(`fits every line, the URL included, in ${locale}`, async () => {
      setLocale(locale);
      stubFetch({ token: "d0522e17-bd87-4ced-bc38-2b9a499beea7", setupUrl: realUrl });
      await fetchAndPrintSetupBanner(3939);
      const lines = out.join("\n").split("\n").filter(Boolean);
      expect(lines.join("\n")).toContain(realUrl);
      expect(new Set(lines.map(width)).size).toBe(1);
    });
  }
});

describe("administration commands in Spanish", () => {
  it("install rejects an unknown option in Spanish", async () => {
    setLocale("es-419");
    await expect(COMMANDS.install!(["--bogus"], config)).rejects.toThrow("exit:2");
    expect(err[0]).toBe(
      "Error: Opción desconocida para 'install': --bogus.\n" +
        "Opciones válidas: --local, --accept-degraded, --capture. Ejecuta 'mnemo --help' para ver el uso."
    );
  });

  it("health (the server status) prints Spanish labels", async () => {
    setLocale("es-419");
    stubFetch({ status: "ok" });
    await COMMANDS.health!([], config);
    expect(err[0]).toContain("Comprobando el estado");
    expect(out[0]).toContain("Disponibilidad:");
    expect(out[1]).toContain("Detalle:");
  });

  it("tasks and keys print Spanish empty messages", async () => {
    setLocale("es-419");
    stubFetch({ items: [], keys: [] });
    await COMMANDS.tasks!([], config);
    expect(out).toContain("No se encontraron tareas.");
    out.length = 0;
    await COMMANDS.keys!(["list"], config);
    expect(out).toContain("No se encontraron claves de API.");
  });

  it("workspace list prints a translated, aligned table", async () => {
    setLocale("es-419");
    stubFetch({
      workspaces: [
        { workspaceId: "ws_1", workspaceName: "Principal", role: "admin", visibility: "private" },
      ],
    });
    await COMMANDS.workspace!(["list"], config);
    expect(out[0]).toMatch(/^ID {37}│ Nombre {25}│ Rol {6}│ Visibilidad$/);
    expect(out[2]).toMatch(/^ws_1 +│ Principal +│ admin +│ private$/);
  });

  it("keys show prints translated labels", async () => {
    setLocale("es-419");
    stubFetch({
      id: "k1",
      label: "",
      scopes: ["memory:read"],
      ipAllowlist: [],
      expiresAt: null,
      lastUsedAt: null,
      maxSensitivity: null,
      createdAt: "2026-01-01",
    });
    await COMMANDS.keys!(["show", "k1"], config);
    const text = out.join("\n");
    expect(text).toContain("Etiqueta:");
    expect(text).toContain("(ninguno)");
    expect(text).toContain("(sin restricciones)");
    expect(text).toContain("nunca");
  });

  it("an unknown keys subcommand is reported in Spanish", async () => {
    setLocale("es-419");
    await expect(COMMANDS.keys!(["nope"], config)).rejects.toThrow("exit:2");
    expect(err[0]).toBe(
      "Subcomando de keys desconocido 'nope'. Usa: list, create, revoke, show, rotate, scoped"
    );
  });
});
