import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "../commands.js";
import { getLocale, setLocale } from "../i18n/index.js";
import { runMain } from "./helpers/run-main.js";

const { FAKE_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  return { FAKE_HOME: fs.mkdtempSync(os.tmpdir() + "/mnemo-locale-home-") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => FAKE_HOME };
});

const CONFIG = join(FAKE_HOME, ".mnemo", "config.json");
function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(join(FAKE_HOME, ".mnemo"), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(config));
}
const stored = () => JSON.parse(readFileSync(CONFIG, "utf-8")) as Record<string, unknown>;

beforeEach(() => writeConfig({ url: "http://localhost:3939", apiKey: "mns_test_fake" }));
afterAll(() => rmSync(FAKE_HOME, { recursive: true, force: true }));

describe("--locale", () => {
  it("an invalid value is a usage error (exit 2) listing the valid locales", async () => {
    const { errors, exitCode, out } = await runMain(["--locale", "fr", "--help"]);
    expect(exitCode).toBe("2");
    expect(errors).toContain("en-US, es-419");
    expect(out).toBe("");
  });

  it("the usage error is in the language the rest of the chain picks", async () => {
    const { errors } = await runMain(["--locale", "fr", "--help"], { MNEMO_LOCALE: "es-419" });
    expect(errors).toContain("Valores válidos: en-US, es-419");
  });

  it("after the subcommand it is NOT extracted, exactly like --workspace", async () => {
    // `recall --locale es --help` stays English: --locale is not a leading flag.
    const { out } = await runMain(["recall", "--locale", "es", "--help"]);
    expect(out).toMatch(/^USAGE$/m);
    // and it is not consumed: the unknown-command path would show it as `--locale`.
    const unknown = await runMain(["--locale"]);
    expect(unknown.errors).toContain("Unknown command '--locale'");
  });

  it("--version is unaffected by the locale", async () => {
    const en = await runMain(["--version"]);
    const es = await runMain(["--locale", "es-419", "--version"]);
    expect(es.out).toBe(en.out);
  });

  it("leaves --json output identical under es-419 (config get)", async () => {
    writeConfig({ url: "http://localhost:3939", apiKey: "mns_test_fake", uiMode: "quiet" });
    const en = await runMain(["config", "get"]);
    const es = await runMain(["--locale", "es-419", "config", "get"]);
    expect(es.out).toBe(en.out);
    expect(JSON.parse(es.out).uiMode).toBe("quiet");
  });

  it("translates index.ts errors and keeps the exit code", async () => {
    const en = await runMain(["nope"]);
    const es = await runMain(["--locale", "es-419", "nope"]);
    expect(en.errors).toBe("Error: Unknown command 'nope'. Run mnemo help.");
    expect(es.errors).toBe("Error: Comando desconocido 'nope'. Ejecuta mnemo help.");
    expect(es.exitCode).toBe(en.exitCode);
    expect(es.exitCode).toBe("2");
  });
});

describe("config locale", () => {
  it("rejects an unknown locale with the valid list", async () => {
    const { errors, exitCode } = await runMain(["config", "set", "locale", "fr"]);
    expect(exitCode).toBe("2");
    expect(errors).toBe("Error: Invalid locale 'fr'. Valid values: en-US, es-419");
    expect(stored()).not.toHaveProperty("locale");
  });

  it("stores the canonical tag and reads it back", async () => {
    await runMain(["config", "set", "locale", "es_MX.UTF-8"]);
    expect(stored().locale).toBe("es-419");
    expect((await runMain(["config", "get", "locale"])).out).toBe("es-419");
    expect(JSON.parse((await runMain(["config", "get"])).out).locale).toBe("es-419");
  });

  it("the valid-keys messages include locale", async () => {
    expect((await runMain(["config", "set", "nope", "x"])).errors).toContain(
      "uiMode, recallTimeoutMs, locale"
    );
    expect((await runMain(["config", "get", "nope"])).errors).toContain(
      "url, apiKey, uiMode, locale"
    );
  });

  it("config set confirms in the chosen language", async () => {
    const { errors } = await runMain(["--locale", "es-419", "config", "set", "url", "http://x"]);
    expect(errors).toContain("Se definió url = http://x");
  });

  it("without a stored locale, `config get` has no locale key (English output unchanged)", async () => {
    expect(JSON.parse((await runMain(["config", "get"])).out)).not.toHaveProperty("locale");
  });
});

describe("a malformed config locale", () => {
  it("a non-string locale in config.json cannot crash startup (--version, help, config get)", async () => {
    writeConfig({ url: "http://localhost:3939", apiKey: "mns_test_fake", locale: 123 });
    const v = await runMain(["--version"]);
    expect(v.exitCode).toBeNull();
    expect(v.out).toMatch(/^mnemo /);
    expect((await runMain(["--help"])).out).toMatch(/^USAGE$/m);
    expect((await runMain(["config", "get", "locale"])).out).toBe("(not set)");
  });

  it("config get locale prints the normalized value", async () => {
    writeConfig({ locale: "es_MX.UTF-8" });
    expect((await runMain(["config", "get", "locale"])).out).toBe("es-419");
  });
});

describe("clients ask in the process language", () => {
  it("createClient sends Accept-Language from the resolved locale", async () => {
    const seen: Array<string | null> = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("accept-language"));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      setLocale("es-419");
      await createClient("http://localhost:3939", "mns_test_fake").health();
      setLocale("en-US");
      await createClient("http://localhost:3939", "mns_test_fake").health();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen).toEqual(["es-419", "en-US"]);
    expect(getLocale()).toBe("en-US");
  });
});
