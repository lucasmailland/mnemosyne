/**
 * `mnemo install`'s argv reaches the parser, and a rejected argv stops the
 * command before it touches anything.
 *
 * `install` writes to files outside the repository — ~/.cursor/mcp.json,
 * ~/.codex/config.toml, ~/.config/opencode/opencode.json. A flag it does not
 * understand must therefore refuse, not proceed with a default: doing something
 * other than what was asked is worse than doing nothing. That is the same
 * property `--help` needed, one flag later.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { FAKE_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  return { FAKE_HOME: fs.mkdtempSync(os.tmpdir() + "/mnemo-install-flags-home-") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => FAKE_HOME };
});

import { main } from "../index.js";

// Without a key in the fake HOME, install exits early on "No API key found" and
// every test below would pass for the wrong reason.
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
    /* expected: process.exit throws */
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

/** Either line means cmdInstall got past flag parsing and started working. */
const INSTALL_RAN = /Detected agents:|No AI coding agents detected/;

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("a rejected argv stops before any install side effect", () => {
  it.each([
    ["an unknown host", ["install", "--capture", "vscode"], /vscode/],
    ["a missing host list", ["install", "--capture"], /comma-separated host list/],
    [
      "a swallowed following flag",
      ["install", "--capture", "--local"],
      /comma-separated host list/,
    ],
    [
      "a repeated --capture",
      ["install", "--capture", "codex", "--capture", "opencode"],
      /only be given once/,
    ],
    [
      "--accept-degraded alone",
      ["install", "--accept-degraded"],
      /only means something with --capture/,
    ],
    ["an unknown flag", ["install", "--wat"], /Unknown option for 'install'/],
  ])("refuses %s", async (_name, argv, expected) => {
    const { out, errors, exitCode } = await runMain(argv);
    expect(errors).toMatch(expected);
    expect(exitCode).toBe("2");
    expect(out + errors).not.toMatch(INSTALL_RAN);
  });
});

describe("behaviour without --capture is unchanged", () => {
  it("still reaches the command with no flags", async () => {
    const { out, errors } = await runMain(["install"]);
    expect(out + errors).toMatch(INSTALL_RAN);
  });

  it("still reaches the command with --local", async () => {
    const { out, errors } = await runMain(["install", "--local"]);
    expect(out + errors).toMatch(INSTALL_RAN);
  });

  it("still treats --help as a question, not an instruction", async () => {
    const { out, errors } = await runMain(["install", "--help"]);
    expect(out + errors).not.toMatch(INSTALL_RAN);
  });
});
