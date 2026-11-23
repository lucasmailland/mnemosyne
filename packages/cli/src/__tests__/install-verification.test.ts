/**
 * autonomous-memory Requirement 6 — `mnemo install` self-verification.
 *
 * verifyClaudeCodeHooks() spawns each installed hook script with synthetic
 * stdin and MNEMO_URL/MNEMO_KEY stripped (every script's real network path
 * is gated on those being set, so this never touches a real server) and
 * confirms exit 0 + the executable bit. verifyMcpHandshake() sends a JSON-RPC
 * `initialize` request to a spawned process and checks for a non-empty
 * `instructions` field.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyClaudeCodeHooks, verifyMcpHandshake } from "../commands.js";

const REAL_SCRIPTS_DIR = join(import.meta.dirname, "../../../plugin/scripts");

describe("verifyClaudeCodeHooks", () => {
  const tmpDirs: string[] = [];
  const servers: Server[] = [];

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
    for (const server of servers) server.close();
    servers.length = 0;
  });

  function makeFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "mnemo-hooks-verify-"));
    tmpDirs.push(dir);
    const scriptsTarget = join(dir, "scripts");
    mkdirSync(scriptsTarget, { recursive: true });
    cpSync(REAL_SCRIPTS_DIR, scriptsTarget, { recursive: true });
    for (const f of [
      "session-start.sh",
      "session-stop.sh",
      "subagent-stop.sh",
      "user-prompt-submit.sh",
      "post-compaction.sh",
      "_helpers.sh",
      "_hook-output.sh",
      "legacy-lifecycle.sh",
    ]) {
      chmodSync(join(scriptsTarget, f), 0o755);
    }
    return dir;
  }

  it("passes for a correctly installed, executable set of real hook scripts", () => {
    const dir = makeFixture();
    const result = verifyClaudeCodeHooks(dir);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  }, 15000);

  it("catches a non-executable script (the exact npm-publish exec-bit bug)", () => {
    const dir = makeFixture();
    chmodSync(join(dir, "scripts", "session-start.sh"), 0o644);
    const result = verifyClaudeCodeHooks(dir);
    expect(result.ok).toBe(false);
    expect(
      result.failures.some((f) => f.includes("session-start.sh") && f.includes("not executable"))
    ).toBe(true);
  }, 15000);

  it("catches a bash syntax error in an installed script", () => {
    const dir = makeFixture();
    writeFileSync(join(dir, "scripts", "session-start.sh"), "#!/bin/bash\nif [ true ; then\n");
    chmodSync(join(dir, "scripts", "session-start.sh"), 0o755);
    const result = verifyClaudeCodeHooks(dir);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes("session-start.sh"))).toBe(true);
  }, 15000);

  it("accepts a sourced library left at its git mode 0644, but not one with a syntax error", () => {
    const dir = makeFixture();
    chmodSync(join(dir, "scripts", "_hook-output.sh"), 0o644);
    expect(verifyClaudeCodeHooks(dir).failures).toEqual([]);

    writeFileSync(join(dir, "scripts", "_hook-output.sh"), "if [ true ; then\n");
    const broken = verifyClaudeCodeHooks(dir);
    expect(broken.ok).toBe(false);
    expect(broken.failures.some((f) => f.startsWith("_hook-output.sh: syntax error"))).toBe(true);
  }, 15000);

  it("APP-037a — catches a syntax error that comes AFTER the hook sources _helpers.sh", () => {
    // The old probe ran each hook with MNEMO_INSTALL_VERIFY=1, and _helpers.sh
    // exits 0 on that before anything else runs — so every line after the
    // `source` was never even parsed, and this hook passed.
    const dir = makeFixture();
    writeFileSync(
      join(dir, "scripts", "session-start.sh"),
      '#!/bin/bash\nsource "$(dirname "$0")/_helpers.sh"\nif [ true ; then\n'
    );
    const result = verifyClaudeCodeHooks(dir);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.startsWith("session-start.sh: syntax error"))).toBe(true);
  }, 15000);

  it("APP-037a — never executes a hook, so it cannot reach a server or write anything", () => {
    const dir = makeFixture();
    const marker = join(dir, "ran");
    writeFileSync(join(dir, "scripts", "session-start.sh"), `#!/bin/bash\ntouch "${marker}"\n`);
    chmodSync(join(dir, "scripts", "session-start.sh"), 0o755);
    expect(verifyClaudeCodeHooks(dir).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  }, 15000);

  it("APP-037a — names jq and curl when the hooks' tools are not on PATH", () => {
    const dir = makeFixture();
    const bin = mkdtempSync(join(tmpdir(), "mnemo-verify-bin-"));
    tmpDirs.push(bin);

    const none = verifyClaudeCodeHooks(dir, bin);
    expect(none.ok).toBe(false);
    expect(none.failures.some((f) => f.startsWith("jq: not found on PATH"))).toBe(true);
    expect(none.failures.some((f) => f.startsWith("curl: not found on PATH"))).toBe(true);

    writeFileSync(join(bin, "jq"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(bin, "curl"), "not executable\n", { mode: 0o644 });
    const onlyJq = verifyClaudeCodeHooks(dir, bin);
    expect(onlyJq.failures.filter((f) => f.includes("not found on PATH"))).toEqual([
      expect.stringMatching(/^curl: not found on PATH/),
    ]);

    chmodSync(join(bin, "curl"), 0o755);
    expect(verifyClaudeCodeHooks(dir, bin).failures).toEqual([]);
  }, 15000);

  it("reports a missing scripts directory as a failure, not a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "mnemo-hooks-verify-empty-"));
    tmpDirs.push(dir);
    const result = verifyClaudeCodeHooks(dir);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain("scripts directory not found");
  });

  it("never invokes a real network call even with a broken/offline MNEMO_URL", () => {
    // Regression guard: if verification ever stopped stripping MNEMO_URL/KEY,
    // a script hitting an unreachable host would hang past the 5s timeout
    // and this test would time out instead of completing quickly.
    const dir = makeFixture();
    process.env.MNEMO_URL = "http://192.0.2.1:1"; // TEST-NET-1, guaranteed unreachable
    process.env.MNEMO_KEY = "mns_live_fake";
    try {
      const result = verifyClaudeCodeHooks(dir);
      expect(result.ok).toBe(true);
    } finally {
      delete process.env.MNEMO_URL;
      delete process.env.MNEMO_KEY;
    }
  }, 15000);

  it("ignores an on-disk ~/.mnemo/config.json, not just the environment", async () => {
    // The env-stripping guard above passed while the real hole stayed open:
    // every script falls back to `$HOME/.mnemo/config.json` (read_config in
    // _helpers.sh), so on any machine that had already run `mnemo install` the
    // probe read the operator's real credentials and POSTed a real capture to
    // their real server — then blocked on curl past its own timeout and called
    // the script broken. Point HOME at a directory that HAS a config, with an
    // unreachable host: if verification ever consults it again, this test spends
    // the script's full 8s curl budget and fails on the timeout.
    const dir = makeFixture();
    const fakeHome = mkdtempSync(join(tmpdir(), "mnemo-verify-fakehome-"));
    tmpDirs.push(fakeHome);
    mkdirSync(join(fakeHome, ".mnemo"), { recursive: true });

    // A real listener rather than an unreachable address, so "did it call out?"
    // is answered by what arrived here instead of by how long anything took.
    // The previous version timed the run, which measures the machine's load as
    // much as the code's behaviour.
    //
    // Ephemeral ports are recycled across the parallel suite, so a stray client
    // from another test file can hit this listener ("/" requests were seen).
    // The config URL therefore carries a unique path prefix and only requests
    // under it count: every script appends its API path to the configured URL.
    const PROBE_PREFIX = `/mnemo-verify-probe-${process.pid}-${Date.now()}`; // determinism-ok: unique path prefix, never asserted on
    const received: string[] = [];
    const server = createServer((request, response) => {
      if ((request.url ?? "").startsWith(PROBE_PREFIX)) received.push(request.url ?? "");
      response.statusCode = 200;
      response.end("{}");
    });
    servers.push(server);
    // `listen` is asynchronous: the address is null until it fires.
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    writeFileSync(
      join(fakeHome, ".mnemo", "config.json"),
      JSON.stringify({ url: `http://127.0.0.1:${port}${PROBE_PREFIX}`, apiKey: "mns_live_fake" })
    );

    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      for (let probe = 0; probe < 2; probe++) {
        const result = verifyClaudeCodeHooks(dir);
        expect(result.failures).toEqual([]);
        expect(result.ok).toBe(true);
      }

      // `verifyClaudeCodeHooks` is synchronous and the scripts background their
      // curl, so nothing can reach the listener until the event loop is free.
      // Waiting for it is not a performance assertion: waiting LONGER can only
      // make this test slower, never wrong, which is the opposite of the elapsed
      // -time check this replaced.
      for (let i = 0; i < 100 && received.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // The assertion that matters, and it is about REQUESTS, not elapsed time.
      expect(received).toEqual([]);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
  }, 20000);
});

describe("verifyMcpHandshake", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function writeFakeMcpServer(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mnemo-mcp-fake-"));
    tmpDirs.push(dir);
    const path = join(dir, "server.mjs");
    writeFileSync(path, script);
    return path;
  }

  it("succeeds when initialize returns a non-empty instructions field", async () => {
    const path = writeFakeMcpServer(`
      process.stdin.on("data", (chunk) => {
        const req = JSON.parse(chunk.toString());
        if (req.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { instructions: "do the thing" } }) + "\\n");
        }
      });
    `);
    const result = await verifyMcpHandshake(path, "http://localhost:3939", "mns_test_x", 3000);
    expect(result.ok).toBe(true);
  }, 10000);

  it("fails when instructions is empty", async () => {
    const path = writeFakeMcpServer(`
      process.stdin.on("data", (chunk) => {
        const req = JSON.parse(chunk.toString());
        if (req.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { instructions: "" } }) + "\\n");
        }
      });
    `);
    const result = await verifyMcpHandshake(path, "http://localhost:3939", "mns_test_x", 3000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("instructions");
  }, 10000);

  it("times out gracefully when the process never responds", async () => {
    const path = writeFakeMcpServer(`setInterval(() => {}, 1000);`);
    const result = await verifyMcpHandshake(path, "http://localhost:3939", "mns_test_x", 500);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/timeout/i);
  }, 10000);
});
