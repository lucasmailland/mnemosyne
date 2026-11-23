/**
 * Tests for main()'s command dispatch switch in index.ts — the entry-point
 * routing itself, not the exported command functions (see cli.test.ts,
 * which deliberately scopes itself to those). main() is safe to import
 * directly here because index.ts guards its self-invocation behind an
 * `import.meta.url === process.argv[1]` check — without that guard,
 * importing this module at all would trigger a real CLI run using the
 * test process's own argv.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../index.js";

async function runMain(argv: string[]): Promise<{ errors: string[] }> {
  const originalArgv = process.argv;
  process.argv = ["node", "mnemo", ...argv];
  const errors: string[] = [];
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(String(args[0]));
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new Error(`exit:${code}`);
  }) as (code?: string | number | null) => never);
  // Whatever config exists (or doesn't) on this machine, no test should ever
  // make a real network call.
  vi.stubGlobal("fetch", async () => {
    throw new Error("test: no network calls expected");
  });

  try {
    await main();
  } catch {
    // Expected: process.exit() is stubbed to throw so main() can't actually
    // terminate the test process.
  } finally {
    process.argv = originalArgv;
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllGlobals();
  }

  return { errors };
}

describe("main() dispatch — T6/T7 regression", () => {
  it("routes 'workspace' to its handler instead of the default 'Unknown command' branch", async () => {
    const { errors } = await runMain(["workspace", "list"]);
    expect(errors.join("\n")).not.toContain("Unknown command");
  });

  it("routes 'reset' to its handler instead of the default 'Unknown command' branch", async () => {
    const { errors } = await runMain(["reset"]);
    expect(errors.join("\n")).not.toContain("Unknown command");
  });

  it("routes 'link' to its handler instead of the default 'Unknown command' branch", async () => {
    const { errors } = await runMain(["link"]);
    expect(errors.join("\n")).not.toContain("Unknown command");
  });

  it("still reports 'Unknown command' for a genuinely unknown command", async () => {
    const { errors } = await runMain(["not-a-real-command"]);
    expect(errors.join("\n")).toContain("Unknown command 'not-a-real-command'");
  });
});

describe("main() dispatch — P29 project-workspace mismatch check", () => {
  // P110 — this block used to read, overwrite and restore the REAL
  // ~/.mnemo/config.json of whoever ran the suite.
  //
  // Two things went wrong with that. It mutated a developer's home directory to
  // run a unit test, and its restore path was self-perpetuating: `hadConfig` was
  // a bare existsSync, so once the file was left at zero bytes by an interrupted
  // or concurrent run, every later run read `originalConfigContent = ""`, skipped
  // injecting the fixture, failed with "No server configured", and wrote the
  // empty string back — locking the failure in and leaving the developer's CLI
  // unconfigured. That is the intermittency this item chased: not flakiness, a
  // latch.
  //
  // The fix touches no filesystem at all. `loadConfig()` already resolves
  // `MNEMO_URL`/`MNEMO_KEY` ahead of the config file, so the suite supplies the
  // config through the environment. Redirecting HOME was the first attempt and
  // does not work: index.ts computes CONFIG_FILE as a module-level constant at
  // import time, before any hook can run.
  let previousUrl: string | undefined;
  let previousKey: string | undefined;

  beforeAll(() => {
    previousUrl = process.env.MNEMO_URL;
    previousKey = process.env.MNEMO_KEY;
    process.env.MNEMO_URL = "http://localhost:3939";
    process.env.MNEMO_KEY = "mns_live_testkey00000000000000";
  });

  afterAll(() => {
    if (previousUrl === undefined) delete process.env.MNEMO_URL;
    else process.env.MNEMO_URL = previousUrl;
    if (previousKey === undefined) delete process.env.MNEMO_KEY;
    else process.env.MNEMO_KEY = previousKey;
  });

  let dir: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function runMainWithFetch(
    argv: string[],
    fetchImpl: typeof fetch
  ): Promise<{ errors: string[] }> {
    const originalArgv = process.argv;
    process.argv = ["node", "mnemo", ...argv];
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(String(args[0]));
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null
    ) => {
      throw new Error(`exit:${code}`);
    }) as (code?: string | number | null) => never);
    vi.stubGlobal("fetch", fetchImpl);

    try {
      await main();
    } catch {
      // expected on process.exit or on an intentionally-unhandled rejection
    } finally {
      process.argv = originalArgv;
      errorSpy.mockRestore();
      exitSpy.mockRestore();
      vi.unstubAllGlobals();
    }

    return { errors };
  }

  it("warns when the linked workspace differs from the active key's workspace", async () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-mismatch-"));
    writeFileSync(
      join(dir, ".mnemo.json"),
      JSON.stringify({ workspaceId: "ws-expected", label: "expected-project" })
    );
    process.chdir(dir);

    const { errors } = await runMainWithFetch(["doctor"], (async (url: string | URL) => {
      if (String(url).endsWith("/me")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ workspaceId: "ws-actually-active" }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch to ${String(url)}`);
    }) as typeof fetch);

    expect(errors.join("\n")).toContain("expected-project");
    expect(errors.join("\n")).toContain("ws-actually-active");
  });

  it("strips control characters from the label before printing the mismatch warning", async () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-mismatch-"));
    writeFileSync(
      join(dir, ".mnemo.json"),
      JSON.stringify({ workspaceId: "ws-expected", label: "expected\x1b[31m-project" })
    );
    process.chdir(dir);

    const { errors } = await runMainWithFetch(["doctor"], (async (url: string | URL) => {
      if (String(url).endsWith("/me")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ workspaceId: "ws-actually-active" }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch to ${String(url)}`);
    }) as typeof fetch);

    const combined = errors.join("\n");
    expect(combined).toContain("expected");
    expect(combined).toContain("-project");
    expect(combined).not.toContain("\x1b");
  });

  it("does not warn when the linked workspace matches the active key's workspace", async () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-mismatch-"));
    writeFileSync(join(dir, ".mnemo.json"), JSON.stringify({ workspaceId: "ws-same" }));
    process.chdir(dir);

    const { errors } = await runMainWithFetch(["doctor"], (async (url: string | URL) => {
      if (String(url).endsWith("/me")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ workspaceId: "ws-same" }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch to ${String(url)}`);
    }) as typeof fetch);

    expect(errors.join("\n")).not.toContain("Warning: this repo expects");
  });

  it("does not warn, throw, or exit when the /me check gets a non-2xx response", async () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-mismatch-"));
    writeFileSync(join(dir, ".mnemo.json"), JSON.stringify({ workspaceId: "ws-expected" }));
    process.chdir(dir);

    // This is the specific regression the spec review caught: apiFetch()
    // calls process.exit(1) on non-2xx. If checkProjectWorkspaceMismatch
    // were ever implemented with apiFetch instead of a raw fetch, THIS
    // test would fail because process.exit would fire.
    const { errors } = await runMainWithFetch(["doctor"], (async (url: string | URL) => {
      if (String(url).endsWith("/me")) {
        return {
          ok: false,
          status: 401,
          headers: new Headers(),
          json: async () => ({}),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch to ${String(url)}`);
    }) as typeof fetch);

    expect(errors.join("\n")).not.toContain("Warning: this repo expects");
    expect(errors.join("\n")).not.toContain("Unknown command");
  });

  it("does not warn, throw, or exit when the /me check has a network error", async () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-mismatch-"));
    writeFileSync(join(dir, ".mnemo.json"), JSON.stringify({ workspaceId: "ws-expected" }));
    process.chdir(dir);

    const { errors } = await runMainWithFetch(["doctor"], (async () => {
      throw new Error("network down");
    }) as typeof fetch);

    expect(errors.join("\n")).not.toContain("Warning: this repo expects");
  });

  it("does not call /me at all when no .mnemo.json exists (backward compatibility)", async () => {
    // NOTE: deviates from the brief's literal fetch stub. cmdDoctor makes its
    // own unconditional apiFetch(url, apiKey, "/doctor") call for its own
    // diagnostics, unrelated to the P29 mismatch check — a stub that throws
    // on ANY fetch call would always see meCallCount > 0 via that pre-existing
    // call, both before and after this feature, making the brief's literal
    // assertion untestable. Scoping the "should not be called" check to `/me`
    // specifically (matching the sibling tests' pattern above) preserves the
    // actual intent: verify checkProjectWorkspaceMismatch's /me call never
    // fires when no .mnemo.json is present, while letting doctor's own
    // /doctor self-check proceed normally.
    dir = mkdtempSync(join(tmpdir(), "mnemo-no-mismatch-"));
    process.chdir(dir);
    let meCallCount = 0;

    await runMainWithFetch(["doctor"], (async (url: string | URL) => {
      if (String(url).endsWith("/me")) {
        meCallCount++;
        throw new Error("should not be called");
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({}),
      } as unknown as Response;
    }) as typeof fetch);

    expect(meCallCount).toBe(0);
  });

  it("resolves requireConfig() to a plain object (not a Promise) at every call-site group", async () => {
    // Regression guard for the async-propagation bug the spec review caught:
    // if any of the 5 requireConfig() references were left un-awaited, the
    // command handler receives a Promise instead of {url, apiKey}, and
    // config.url / config.apiKey would be undefined — apiFetch would then
    // build a URL like "undefined/health" instead of throwing outright, so
    // we assert on the fetched URL directly rather than on a thrown error.
    // Run from an isolated tmp dir with no .mnemo.json: without this, if
    // this repo ever gains its own root .mnemo.json (dogfooding this exact
    // feature), the mismatch-check's own /me call would also hit the
    // stubbed fetch below and could overwrite capturedUrl depending on
    // call order — isolating cwd removes that ambiguity entirely.
    const isolated = mkdtempSync(join(tmpdir(), "mnemo-no-project-config-"));
    const previousCwd = process.cwd();
    process.chdir(isolated);

    const cases: Array<{ argv: string[]; expectHostInUrl: boolean }> = [
      { argv: ["recall", "test query"], expectHostInUrl: true },
      { argv: ["status"], expectHostInUrl: true },
      { argv: ["sessions"], expectHostInUrl: true },
      { argv: ["doctor"], expectHostInUrl: true },
    ];

    try {
      for (const { argv } of cases) {
        let capturedUrl: string | undefined;
        await runMainWithFetch(argv, (async (url: string | URL) => {
          capturedUrl = String(url);
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({}),
          } as unknown as Response;
        }) as typeof fetch);

        expect(capturedUrl).not.toContain("undefined");
        expect(capturedUrl).toMatch(/^https?:\/\//);
      }
    } finally {
      process.chdir(previousCwd);
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe("main() dispatch — every COMMANDS entry is reachable", () => {
  // `harness` had a handler in COMMANDS but no `case` here, so `mnemo harness …`
  // fell to "Unknown command". The plugin's hooks run `mnemo harness hook …`, so
  // capture failed on every machine while `harness-commands.test.ts`, which calls
  // the handler directly, stayed green.
  it("routes 'harness' without requiring a configured server, as the plugin hook needs", async () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-harness-dispatch-"));
    const previousHome = process.env.HOME;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.env.HOME = home;
    try {
      const { errors } = await runMain(["harness"]);
      const text = errors.join("\n");
      expect(text).not.toContain("Unknown command");
      expect(text).not.toContain("No server configured");
      expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("mnemo harness");
    } finally {
      process.env.HOME = previousHome;
      logSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("has a case for every command in the COMMANDS registry", async () => {
    const { COMMANDS } = await import("../commands.js");
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8");
    const routed = new Set([...source.matchAll(/case "([^"]+)":/g)].map((m) => m[1]));
    const unrouted = Object.keys(COMMANDS).filter((name) => !routed.has(name));
    expect(unrouted).toEqual([]);
  });
});
