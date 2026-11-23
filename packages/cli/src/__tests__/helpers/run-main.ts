import { vi } from "vitest";

/**
 * Runs `main()` with a given argv and env overrides, capturing stdout/stderr
 * and the exit code. The caller must have mocked `node:os` homedir first (the
 * config file is read from there).
 */
export async function runMain(
  argv: string[],
  env: Record<string, string | undefined> = {}
): Promise<{ out: string; errors: string; exitCode: string | null }> {
  const { main } = await import("../../index.js");
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  delete process.env["MNEMO_URL"];
  delete process.env["MNEMO_KEY"];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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
    // process.exit() throws
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
