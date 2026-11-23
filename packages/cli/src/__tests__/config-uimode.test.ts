/**
 * PR1 (cli-uimode-full-coverage) — read-path regression tests.
 *
 * Before this fix, `index.ts`'s `loadConfig()` never populated `uiMode` on
 * the returned `Config`, so users who set `uiMode: quiet`/`verbose` in
 * `~/.mnemo/config.json` silently kept getting `delight` output forever.
 *
 * P110 — this file used to reuse main-dispatch.test.ts's backup/restore pattern
 * against the REAL ~/.mnemo/config.json. That pattern latches: `hadConfig` is a
 * bare existsSync, so once the file is left at zero bytes it reads back the
 * empty string, restores the empty string, and the developer's CLI stays
 * unconfigured forever. main-dispatch was fixed by supplying config through
 * MNEMO_URL/MNEMO_KEY; that does not work here, because these tests exercise
 * `uiMode`, which loadConfig reads only from the file.
 *
 * So this file gets a fake HOME instead. The mock must be hoisted above the
 * imports: index.ts computes CONFIG_FILE as a module-level constant at import
 * time, so setting anything in beforeAll is already too late — that is exactly
 * why the first attempt at this failed.
 */
import { isBanner } from "./helpers/banner-lines.js";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const { FAKE_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  return { FAKE_HOME: fs.mkdtempSync(os.tmpdir() + "/mnemo-uimode-home-") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => FAKE_HOME };
});

import { main } from "../index.js";

async function runMain(
  argv: string[],
  fetchImpl?: typeof fetch
): Promise<{ logs: string[]; errors: string[] }> {
  const originalArgv = process.argv;
  process.argv = ["node", "mnemo", ...argv];
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => logs.push(String(args[0])));
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const line = String(args[0]);
    if (isBanner(line)) logs.push(line);
    errors.push(line);
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new Error(`exit:${code}`);
  }) as (code?: string | number | null) => never);
  vi.stubGlobal(
    "fetch",
    fetchImpl ??
      (async () => {
        throw new Error("test: no network calls expected");
      })
  );

  try {
    await main();
  } catch {
    // Expected: process.exit() throws, or an internally-caught rejected fetch.
  } finally {
    process.argv = originalArgv;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllGlobals();
  }
  return { logs, errors };
}

function stubJson(pathSubstr: string, body: unknown): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url).includes(pathSubstr)) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${String(url)}`);
  }) as typeof fetch;
}

describe("uiMode read-path regression (config.json -> loadConfig -> requireConfig -> Config)", () => {
  // Entirely inside the fake HOME — nothing outside the tmpdir is read or written.
  const CONFIG_DIR = join(FAKE_HOME, ".mnemo");
  const CONFIG_FILE = join(CONFIG_DIR, "config.json");

  beforeAll(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(FAKE_HOME, { recursive: true, force: true });
  });

  function writeConfig(extra: Record<string, unknown> = {}): void {
    writeFileSync(
      CONFIG_FILE,
      JSON.stringify({
        url: "http://localhost:3939",
        apiKey: "mns_live_testkey00000000000000",
        ...extra,
      })
    );
  }

  const recallFetch = stubJson("/recall", {
    hits: [{ id: "fact-1", score: 0.9, content: "hello world" }],
  });
  const rememberFetch = stubJson("/remember", { id: "fact-new" });

  it("uiMode: quiet round-trips through requireConfig into recall's resolved Config, suppressing the header while the payload still prints", async () => {
    writeConfig({ uiMode: "quiet" });
    const { logs } = await runMain(["recall", "hello"], recallFetch);
    expect(logs.join("\n")).not.toContain("🧠");
    expect(logs.some((l) => l.includes("hello world"))).toBe(true);
  });

  it("uiMode: verbose round-trips through requireConfig into remember's resolved Config, showing a plain confirmation with no emoji", async () => {
    writeConfig({ uiMode: "verbose" });
    const { logs } = await runMain(["remember", "a fact worth keeping"], rememberFetch);
    const output = logs.join("\n");
    expect(output).toContain("✓");
    expect(output).not.toContain("🧠");
  });

  it("unset uiMode resolves to the delight default (regression guard: the bug used to make every mode look like this by accident)", async () => {
    writeConfig();
    const { logs } = await runMain(["recall", "hello"], recallFetch);
    expect(logs.join("\n")).toContain("🧠");
  });

  it("mnemo config get uiMode prints the stored value, not an 'unknown key' error; no-arg summary includes it too", async () => {
    writeConfig({ uiMode: "verbose" });
    const single = await runMain(["config", "get", "uiMode"]);
    expect(single.errors.join("\n")).not.toContain("Unknown config key");
    expect(single.logs).toEqual(["verbose"]);

    writeConfig({ uiMode: "quiet" });
    const summary = await runMain(["config", "get"]);
    expect(summary.logs.join("\n")).toContain('"uiMode": "quiet"');
  });

  it("mnemo config get uiMode prints '(not set)' when the key is absent from the file", async () => {
    writeConfig();
    const { logs } = await runMain(["config", "get", "uiMode"]);
    expect(logs).toEqual(["(not set)"]);
  });

  // PR8 (cli-uimode-full-coverage) — cmdConfigSet's confirmation line, migrated
  // onto statusLine using the uiMode in effect BEFORE the write it performs.
  describe("mnemo config set status line (PR8)", () => {
    it("delight: prints the tagged 🧠 confirmation", async () => {
      writeConfig({ uiMode: "delight" });
      const { logs } = await runMain(["config", "set", "url", "http://example.com"]);
      expect(logs).toEqual(["🧠 ⬇️  [mnemosyne] Set url = http://example.com"]);
    });

    it("verbose: prints the plain ✓ confirmation, preserving the original wording", async () => {
      writeConfig({ uiMode: "verbose" });
      const { logs } = await runMain(["config", "set", "url", "http://example.com"]);
      expect(logs).toEqual(["✓ Set url = http://example.com"]);
    });

    it("quiet: suppresses the confirmation entirely", async () => {
      writeConfig({ uiMode: "quiet" });
      const { logs } = await runMain(["config", "set", "url", "http://example.com"]);
      expect(logs).toEqual([]);
    });
  });
});
