import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { COMMANDS } from "../commands.js";
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

describe("memory commands in Spanish", () => {
  it("remember saves with a Spanish status line", async () => {
    setLocale("es-419");
    stubFetch({ id: "fact_1" });
    await COMMANDS.remember!(["hola mundo"], config);
    expect(err[0]).toBe('🧠 ⬇️  [mnemosyne] Recuerdo guardado: "hola mundo" (fact_1)');
  });

  it("forget and the missing-id usage error", async () => {
    setLocale("es-419");
    stubFetch({});
    await COMMANDS.forget!(["fact_9"], config);
    expect(err[0]).toContain("Olvidado");
    err.length = 0;
    await expect(COMMANDS.forget!([], config)).rejects.toThrow("exit:2");
    expect(err[0]).toBe("Error: Uso: mnemo forget <id>");
  });

  it("list prints the empty message and recall prints the header and no-results line", async () => {
    setLocale("es-419");
    stubFetch({ items: [], hits: [] });
    await COMMANDS.list!([], config);
    expect(out).toContain("No se encontraron hechos.");
    out.length = 0;
    err.length = 0;
    await COMMANDS.recall!(["algo"], config);
    expect(err[0]).toContain('Recuperando recuerdos para "algo"');
    expect(out).toContain("No se encontraron resultados.");
  });

  it("recall table header is localized and aligned", async () => {
    setLocale("es-419");
    stubFetch({ hits: [{ id: "a", score: 0.5, content: "x" }] });
    await COMMANDS.recall!(["algo"], config);
    expect(out[0]).toMatch(/^id {37}│ puntaje {2}│ enunciado$/);
  });

  it("decide, entity and episode subcommand errors", async () => {
    setLocale("es-419");
    await expect(COMMANDS.decide!(["nope"], config)).rejects.toThrow("exit:2");
    expect(err[0]).toContain("Subcomando de decide desconocido 'nope'");
    err.length = 0;
    await expect(COMMANDS.episode!(["nope"], config)).rejects.toThrow("exit:2");
    expect(err[0]).toContain("Subcomando de episode desconocido 'nope'");
  });

  it("English stays the default", async () => {
    stubFetch({ items: [] });
    await COMMANDS.list!([], config);
    expect(out).toContain("No facts found.");
  });
});
