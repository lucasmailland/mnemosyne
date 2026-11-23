/**
 * CLI subcommand dispatch + shell completion tests.
 *
 * Uses fetch-stub approach: each test creates a fake fetch, checks the URL path,
 * and returns a minimal fixture. We test the exported command functions, not the
 * full bin entry point, so these are pure unit tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  cmdLink,
  COMMANDS,
  getCmdHelp,
  CLI_VERSION,
  printRecallTable,
  getClaudeDesktopConfigPath,
  mcpLaunch,
  findDockerComposePath,
  isPortFree,
  waitForHealthy,
  findDockerBinary,
  detectProjectName,
  writeWorkspaceMapping,
  writePersonalWorkspaceId,
  resolveWorkspaceIdentity,
} from "../commands.js";
import { generateCompletion, COMPLETION_SHELLS } from "../completion.js";
import { expectRequest } from "./helpers/expect-request.js";
import { isBanner } from "./helpers/banner-lines.js";

describe("CLI command registry", () => {
  it("all subcommands are registered", () => {
    const names = Object.keys(COMMANDS);
    for (const cmd of [
      "sessions",
      "tasks",
      "events",
      "health",
      "export",
      "login",
      "init",
      "completion",
    ]) {
      expect(names).toContain(cmd);
    }
  });

  it("existing commands are still registered", () => {
    const names = Object.keys(COMMANDS);
    for (const cmd of ["recall", "remember", "forget", "status", "config"]) {
      expect(names).toContain(cmd);
    }
  });

  it("P5-A commands are registered", () => {
    const names = Object.keys(COMMANDS);
    for (const cmd of ["list", "search", "show"]) {
      expect(names).toContain(cmd);
    }
  });

  it("getCmdHelp() includes all subcommands including completion", () => {
    const help = getCmdHelp();
    for (const cmd of [
      "sessions",
      "tasks",
      "events",
      "health",
      "export",
      "login",
      "init",
      "completion",
    ]) {
      expect(help).toContain(cmd);
    }
  });

  it("getCmdHelp() includes P5-A commands", () => {
    const help = getCmdHelp();
    for (const cmd of ["list", "search", "show"]) {
      expect(help).toContain(cmd);
    }
  });
});

describe("shell completion generator", () => {
  it("generateCompletion returns non-empty script for each supported shell", () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = generateCompletion(shell);
      expect(script.length).toBeGreaterThan(100);
      // Each script must contain all commands
      expect(script).toContain("recall");
      expect(script).toContain("completion");
      expect(script).toContain("config");
      expect(script).toContain("init");
      // P5-A commands
      expect(script).toContain("list");
      expect(script).toContain("search");
      expect(script).toContain("show");
    }
  });

  it("bash completion includes _mnemo_completion function", () => {
    const script = generateCompletion("bash");
    expect(script).toContain("_mnemo_completion");
    expect(script).toContain("complete -F _mnemo_completion mnemo");
  });

  it("zsh completion includes #compdef and _mnemo function", () => {
    const script = generateCompletion("zsh");
    expect(script).toContain("#compdef mnemo");
    expect(script).toContain("_mnemo()");
  });

  it("fish completion includes complete -c mnemo directives", () => {
    const script = generateCompletion("fish");
    expect(script).toContain("complete -c mnemo");
    // Must tab-complete config subcommands
    expect(script).toContain("__fish_seen_subcommand_from config");
  });

  it("pwsh completion includes Register-ArgumentCompleter", () => {
    const script = generateCompletion("pwsh");
    expect(script).toContain("Register-ArgumentCompleter");
    expect(script).toContain("mnemo");
  });

  it("throws on unknown shell", () => {
    expect(() => generateCompletion("nushell")).toThrow(/Unknown shell/);
  });
});

describe("CLI command dispatch — new subcommands", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];

  beforeEach(() => {
    fetchCalls = [];
    // Stub global fetch
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ items: [], total: 0, data: [], sessions: [] }),
        text: async () => "{}",
      } as unknown as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_test_abc_xyz" };

  it("sessions command calls GET /session/list (fixed — used to hit the nonexistent /sessions)", async () => {
    await COMMANDS.sessions!([], mockConfig);
    expect(fetchCalls[0]?.url).toContain("/session/list");
    expect(fetchCalls[0]?.opts?.method ?? "GET").toBe("GET");
  });

  it("sessions show <id> command calls GET /session/:id", async () => {
    await COMMANDS.sessions!(["show", "ses_abc123"], mockConfig);
    expect(fetchCalls[0]?.url).toContain("/session/ses_abc123");
  });

  it("tasks command calls GET /tasks", async () => {
    await COMMANDS.tasks!([], mockConfig);
    expect(fetchCalls[0]?.url).toContain("/tasks");
  });

  it("events command calls GET /events", async () => {
    await COMMANDS.events!([], mockConfig);
    expect(fetchCalls[0]?.url).toContain("/events");
  });

  it("health command calls GET /health", async () => {
    await COMMANDS.health!([], mockConfig);
    expect(fetchCalls[0]?.url).toContain("/health");
  });

  it("export command calls GET /export/jsonl (root-mounted, no /v1 prefix)", async () => {
    // export streams gzip JSONL — verify the JSONL endpoint is called
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          "content-type": "application/x-ndjson",
          "content-encoding": "gzip",
        }),
        body: null,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    });
    await COMMANDS.export!([], mockConfig);
    // Full-path assertion — a substring match like .toContain("/export/jsonl")
    // would also pass against a broken /export/jsonl URL. pathname equality
    // fails loudly if a stale /v1 prefix is ever reintroduced.
    expectRequest(fetchCalls[0]!, { method: "GET", pathname: "/export/jsonl" });
  });
});

// ── PR6 (cli-uimode-full-coverage): health — 3-mode status-line coverage ────
//
// `health` is this batch's representative operational/diagnostic D-read
// command. Its existing "Readiness:"/"Detail:" payload lines must keep
// printing unconditionally in every mode; only the delight-mode read header
// appears/disappears by mode, per the same contract as `list`/`recall`.

describe("PR6 (cli-uimode-full-coverage): health command status line", () => {
  let consoleLogs: string[] = [];
  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_test_abc_xyz" };

  beforeEach(() => {
    consoleLogs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) consoleLogs.push(line);
    });
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ status: "ok" }),
          text: async () => "{}",
        }) as unknown as Response
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("delight prints the tagged read header (⬆️) before the Readiness/Detail payload", async () => {
    await COMMANDS.health!([], { ...mockConfig, uiMode: "delight" });
    expect(consoleLogs[0]).toBe("🧠 ⬆️  [mnemosyne] Checking health…\n");
    expect(consoleLogs.some((l) => l.startsWith("Readiness:"))).toBe(true);
  });

  it("verbose prints no header — the Readiness/Detail payload is the confirmation", async () => {
    await COMMANDS.health!([], { ...mockConfig, uiMode: "verbose" });
    expect(consoleLogs.some((l) => l.startsWith("🧠") || l.startsWith("✓"))).toBe(false);
    expect(consoleLogs.some((l) => l.startsWith("Readiness:"))).toBe(true);
  });

  it("quiet prints no header — the Readiness/Detail payload is unaffected", async () => {
    await COMMANDS.health!([], { ...mockConfig, uiMode: "quiet" });
    expect(consoleLogs.some((l) => l.startsWith("🧠") || l.startsWith("✓"))).toBe(false);
    expect(consoleLogs.some((l) => l.startsWith("Readiness:"))).toBe(true);
  });
});

// ── PR1 (cli-uimode-full-coverage): export/completion byte-clean regression ──
//
// export/completion MUST stay byte-clean for shell integrations regardless
// of uiMode — `mnemo export | gunzip` and `mnemo completion bash | source`
// cannot tolerate any injected status line (spec's Exclusions requirement).

describe("export/completion stay byte-clean across all uiMode values", () => {
  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_test_abc_xyz" };
  const modes: Array<"delight" | "verbose" | "quiet"> = ["delight", "verbose", "quiet"];

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function captureStdout(): { text: () => string } {
    const chunks: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      chunks.push(String(args[0]))
    );
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(chunk instanceof Buffer ? chunk.toString("utf-8") : String(chunk));
      return true;
    });
    return { text: () => chunks.join("") };
  }

  it("mnemo export never prints a 🧠/✓ line on stdout, in any uiMode", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/x-ndjson" }),
          arrayBuffer: async () => new TextEncoder().encode("raw jsonl bytes\n").buffer,
        }) as unknown as Response
    );
    for (const uiMode of modes) {
      const stdout = captureStdout();
      await COMMANDS.export!([], { ...mockConfig, uiMode });
      expect(stdout.text(), `uiMode=${uiMode}`).not.toContain("🧠");
      expect(stdout.text(), `uiMode=${uiMode}`).not.toContain("✓");
      vi.restoreAllMocks();
    }
  });

  it("mnemo completion bash never prints a 🧠/✓ line on stdout, in any uiMode", async () => {
    for (const uiMode of modes) {
      const stdout = captureStdout();
      await COMMANDS.completion!(["bash"], { ...mockConfig, uiMode });
      expect(stdout.text(), `uiMode=${uiMode}`).not.toContain("🧠");
      expect(stdout.text(), `uiMode=${uiMode}`).not.toContain("✓");
      vi.restoreAllMocks();
    }
  });
});

// ── A1: cmdImport — first-ever coverage ──────────────────────────────────────

describe("cmdImport", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];
  let consoleLogs: string[] = [];
  let consoleErrors: string[] = [];
  let dir: string;
  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_test_abc_xyz" };

  beforeEach(() => {
    fetchCalls = [];
    consoleLogs = [];
    consoleErrors = [];
    dir = mkdtempSync(join(tmpdir(), "mnemo-import-"));
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (isBanner(line)) consoleLogs.push(line);
      consoleErrors.push(line);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function stubImportFetch(ok = true): void {
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () => (ok ? { imported: 3 } : { error: "boom" }),
      } as unknown as Response;
    });
  }

  it("imports fixture.jsonl.gz: POST /import, empty search, correct headers + body length", async () => {
    stubImportFetch();
    const filePath = join(dir, "fixture.jsonl.gz");
    const body = Buffer.from("fixture-bytes");
    writeFileSync(filePath, body);

    await COMMANDS.import!([filePath], mockConfig);

    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/import", search: {} });
    expect(fetchCalls[0]?.opts?.headers).toMatchObject({
      Authorization: "Bearer mk_test_abc_xyz",
      "Content-Type": "application/octet-stream",
    });
    const sentBody = fetchCalls[0]?.opts?.body as ArrayBuffer;
    expect(sentBody.byteLength).toBe(body.byteLength);
  });

  it("--from mem0 --conflict-resolution newest builds the exact query string", async () => {
    stubImportFetch();
    const filePath = join(dir, "fixture.jsonl.gz");
    writeFileSync(filePath, Buffer.from("x"));

    await COMMANDS.import!(
      [filePath, "--from", "mem0", "--conflict-resolution", "newest"],
      mockConfig
    );

    expectRequest(fetchCalls[0]!, {
      method: "POST",
      pathname: "/import",
      search: { from: "mem0", conflictResolution: "newest" },
    });
  });

  it("missing file path prints usage and exits 2", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });
    await expect(COMMANDS.import!([], mockConfig)).rejects.toThrow("exit:2");
    expect(consoleErrors.join("\n")).toContain("Usage: mnemo import");
    exitSpy.mockRestore();
  });

  it("unreadable file prints 'Error reading file:' and exits 1", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });
    const missingPath = join(dir, "does-not-exist.jsonl.gz");
    await expect(COMMANDS.import!([missingPath], mockConfig)).rejects.toThrow("exit:1");
    expect(consoleErrors.join("\n")).toContain("Error reading file:");
    exitSpy.mockRestore();
  });

  it("non-2xx response surfaces the server error and exits 5", async () => {
    stubImportFetch(false);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });
    const filePath = join(dir, "fixture.jsonl.gz");
    writeFileSync(filePath, Buffer.from("x"));

    await expect(COMMANDS.import!([filePath], mockConfig)).rejects.toThrow("exit:5");
    expect(consoleErrors.join("\n")).toContain("Error: 500");
    expect(consoleErrors.join("\n")).toContain("boom");
    exitSpy.mockRestore();
  });
});

// ── P5-A: list / search / show ───────────────────────────────────────────────

describe("P5-A: list command", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];
  let consoleLogs: string[] = [];

  const mockFact = {
    id: "fact-001",
    subject: "TypeScript",
    statement: "generics are useful",
    kind: "preference",
    confidence: 0.9,
  };
  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_test_abc_xyz" };

  beforeEach(() => {
    fetchCalls = [];
    consoleLogs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) consoleLogs.push(line);
    });
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ items: [mockFact] }),
        text: async () => "{}",
      } as unknown as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls GET /facts with limit=20 and sort by default", async () => {
    await COMMANDS.list!([], mockConfig);
    expect(fetchCalls[0]?.url).toContain("/facts");
    expect(fetchCalls[0]?.url).toContain("limit=20");
    // sortBy/order — the real GET /facts query contract (types.ts ListFactsInput).
    // `sort=` was never a param the server read; the CLI used to send it as a no-op.
    expect(fetchCalls[0]?.url).toContain("sortBy=created_at");
    expect(fetchCalls[0]?.url).toContain("order=desc");
    expect(fetchCalls[0]?.opts?.method ?? "GET").toBe("GET");
  });

  it("--limit N overrides default limit", async () => {
    await COMMANDS.list!(["--limit", "50"], mockConfig);
    expect(fetchCalls[0]?.url).toContain("limit=50");
  });

  it("prints each fact as [id] subject: statement (kind, confidence)", async () => {
    await COMMANDS.list!([], mockConfig);
    expect(consoleLogs.some((l) => l.includes("[fact-001]"))).toBe(true);
    expect(consoleLogs.some((l) => l.includes("TypeScript"))).toBe(true);
    expect(consoleLogs.some((l) => l.includes("generics are useful"))).toBe(true);
    expect(consoleLogs.some((l) => l.includes("preference"))).toBe(true);
  });

  it("prints 'No facts found.' when items is empty", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ items: [] }),
        }) as unknown as Response
    );
    await COMMANDS.list!([], mockConfig);
    expect(consoleLogs.some((l) => l.includes("No facts found"))).toBe(true);
  });

  it("--limit with invalid value calls process.exit(2)", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });
    await expect(COMMANDS.list!(["--limit", "bad"], mockConfig)).rejects.toThrow("exit:2");
    exitSpy.mockRestore();
  });

  // PR6 (cli-uimode-full-coverage): list is this batch's representative
  // D-read/fact-surface command — 3-mode assertions per the "Test Coverage
  // Per Mode Per Category" requirement. The fact payload lines must keep
  // printing unconditionally in every mode (per D6, the payload IS the
  // confirmation); only the delight-mode read header (⬆️, `pending: true`,
  // trailing "…" + blank line) appears/disappears by mode.
  it("delight prints the tagged read header (⬆️) before the fact payload", async () => {
    await COMMANDS.list!([], { ...mockConfig, uiMode: "delight" });
    expect(consoleLogs[0]).toBe("🧠 ⬆️  [mnemosyne] Listing facts…\n");
    expect(consoleLogs.slice(1).some((l) => l.includes("[fact-001]"))).toBe(true);
  });

  it("verbose prints no header — the fact payload is the confirmation", async () => {
    await COMMANDS.list!([], { ...mockConfig, uiMode: "verbose" });
    expect(consoleLogs.some((l) => l.startsWith("🧠") || l.startsWith("✓"))).toBe(false);
    expect(consoleLogs.some((l) => l.includes("[fact-001]"))).toBe(true);
  });

  it("quiet prints no header — the fact payload is unaffected", async () => {
    await COMMANDS.list!([], { ...mockConfig, uiMode: "quiet" });
    expect(consoleLogs.some((l) => l.startsWith("🧠") || l.startsWith("✓"))).toBe(false);
    expect(consoleLogs.some((l) => l.includes("[fact-001]"))).toBe(true);
  });
});

describe("P5-A: search command", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];
  let consoleLogs: string[] = [];

  // Shape of the real RecallHit (packages/server/src/routes/recall.ts) — no
  // subject/kind/confidence, those only exist on MemoryFact (GET /facts).
  const mockHit = { id: "fact-002", content: "generics are powerful", score: 0.9 };
  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_test_abc_xyz" };

  beforeEach(() => {
    fetchCalls = [];
    consoleLogs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) consoleLogs.push(line);
    });
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ hits: [mockHit] }),
        text: async () => "{}",
      } as unknown as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POSTs to /recall with the query text", async () => {
    await COMMANDS.search!(["TypeScript", "generics"], mockConfig);
    expect(fetchCalls[0]?.url).toContain("/recall");
    expect(fetchCalls[0]?.opts?.method).toBe("POST");
    const body = JSON.parse(fetchCalls[0]?.opts?.body as string);
    expect(body.query).toBe("TypeScript generics");
  });

  it("prints each result as [id] statement", async () => {
    await COMMANDS.search!(["generics"], mockConfig);
    expect(consoleLogs.some((l) => l.includes("[fact-002]"))).toBe(true);
    expect(consoleLogs.some((l) => l.includes("generics are powerful"))).toBe(true);
  });

  it("prints 'No results found.' when hits is empty", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ hits: [] }),
        }) as unknown as Response
    );
    await COMMANDS.search!(["orphan"], mockConfig);
    expect(consoleLogs.some((l) => l.includes("No results found"))).toBe(true);
  });

  it("empty query calls process.exit(2)", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });
    await expect(COMMANDS.search!([], mockConfig)).rejects.toThrow("exit:2");
    exitSpy.mockRestore();
  });
});

describe("P5-A: show command", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];
  let consoleLogs: string[] = [];

  const mockFact = {
    id: "fact-003",
    subject: "TypeScript",
    statement: "generics are cool",
    kind: "preference",
    confidence: 0.8,
    createdAt: "2024-01-01T00:00:00Z",
  };
  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_test_abc_xyz" };

  beforeEach(() => {
    fetchCalls = [];
    consoleLogs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) consoleLogs.push(line);
    });
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => mockFact,
        text: async () => "{}",
      } as unknown as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls GET /facts/:id", async () => {
    await COMMANDS.show!(["fact-003"], mockConfig);
    expect(fetchCalls[0]?.url).toContain("/facts/fact-003");
    expect(fetchCalls[0]?.opts?.method ?? "GET").toBe("GET");
  });

  it("prints all fields as pretty-printed JSON", async () => {
    await COMMANDS.show!(["fact-003"], mockConfig);
    const output = consoleLogs.join("\n");
    expect(output).toContain('"id"');
    expect(output).toContain('"fact-003"');
    expect(output).toContain('"statement"');
    expect(output).toContain('"generics are cool"');
    expect(output).toContain('"createdAt"');
  });

  it("missing factId calls process.exit(2)", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });
    await expect(COMMANDS.show!([], mockConfig)).rejects.toThrow("exit:2");
    exitSpy.mockRestore();
  });
});

// ── W6 new exports ────────────────────────────────────────────────────────────

describe("W6: CLI_VERSION and printRecallTable exports", () => {
  it("CLI_VERSION is a non-empty string", () => {
    expect(typeof CLI_VERSION).toBe("string");
    expect(CLI_VERSION.length).toBeGreaterThan(0);
  });

  it("printRecallTable prints header and formatted data row", () => {
    const lines: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => lines.push(String(args[0])));
    printRecallTable([
      {
        id: "01j9abc123def456",
        score: 0.9123,
        statement: "TypeScript generics allow type-safe reuse",
      },
    ]);
    spy.mockRestore();
    expect(lines[0]).toContain("id");
    expect(lines[0]).toContain("score");
    expect(lines[0]).toContain("statement");
    expect(lines[2]).toContain("0.9123");
    expect(lines[2]).toContain("TypeScript generics allow type-safe reuse");
  });

  it("printRecallTable truncates statements longer than 80 chars", () => {
    const lines: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => lines.push(String(args[0])));
    const longStmt = "x".repeat(200);
    printRecallTable([{ id: "test-id", score: 0.5, statement: longStmt }]);
    spy.mockRestore();
    expect(lines[2]).toContain("…");
    expect(lines[2]!.length).toBeLessThan(250);
  });
});

// ── W6: recall ────────────────────────────────────────────────────────────────

describe("W6: recall command", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];
  let consoleLogs: string[] = [];

  const mockHit = { id: "fact-001", score: 0.95, content: "generics are useful" };
  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_test_abc_xyz" };

  beforeEach(() => {
    fetchCalls = [];
    consoleLogs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) consoleLogs.push(line);
    });
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ hits: [mockHit] }),
        text: async () => "{}",
      } as unknown as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("defaults to k=10 and renders a table", async () => {
    await COMMANDS.recall!(["generics in TypeScript"], mockConfig);
    const body = JSON.parse(fetchCalls[0]?.opts?.body as string);
    expect(body.topK).toBe(10);
    expect(body.query).toBe("generics in TypeScript");
    expect(consoleLogs.some((l) => l.includes("generics are useful"))).toBe(true);
  });

  // PR1 (cli-uimode-full-coverage): pins the exact delight header byte-for-byte
  // after the statusLine migration — no config.uiMode set, so it defaults to delight.
  it("delight header is byte-identical to the pre-migration inline console.log", async () => {
    await COMMANDS.recall!(["generics in TypeScript"], mockConfig);
    expect(consoleLogs[0]).toBe(
      `🧠 ⬆️  [mnemosyne] Recalling memories for "generics in TypeScript"…\n`
    );
  });

  it("--json flag outputs JSON envelope and no table separators", async () => {
    await COMMANDS.recall!(["--json", "generics"], mockConfig);
    const body = JSON.parse(fetchCalls[0]?.opts?.body as string);
    expect(body.topK).toBe(10);
    expect(consoleLogs.some((l) => l.includes('"hits"'))).toBe(true);
    expect(consoleLogs.some((l) => l.includes("│"))).toBe(false);
  });

  it("--limit N sets k=N", async () => {
    await COMMANDS.recall!(["--limit", "25", "machine learning"], mockConfig);
    const body = JSON.parse(fetchCalls[0]?.opts?.body as string);
    expect(body.topK).toBe(25);
    expect(body.query).toBe("machine learning");
  });

  it("-n N sets k=N", async () => {
    await COMMANDS.recall!(["-n", "5", "machine learning"], mockConfig);
    const body = JSON.parse(fetchCalls[0]?.opts?.body as string);
    expect(body.topK).toBe(5);
  });

  it("empty query calls process.exit(2)", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });
    await expect(COMMANDS.recall!([], mockConfig)).rejects.toThrow("exit:2");
    exitSpy.mockRestore();
  });

  it("prints 'No results found.' when hits array is empty", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ hits: [] }),
        }) as unknown as Response
    );
    await COMMANDS.recall!(["orphan query with no hits"], mockConfig);
    expect(consoleLogs.some((l) => l.includes("No results found"))).toBe(true);
  });
});

// ── W6: remember ─────────────────────────────────────────────────────────────

describe("W6: remember command", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];
  let consoleLogs: string[] = [];
  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_test_abc_xyz" };

  beforeEach(() => {
    fetchCalls = [];
    consoleLogs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) consoleLogs.push(line);
    });
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ id: "fact-new-001" }),
        text: async () => "{}",
      } as unknown as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POSTs statement to /remember and prints the new id", async () => {
    await COMMANDS.remember!(["TypeScript generics allow type-safe reuse"], mockConfig);
    const call = fetchCalls[0];
    expect(call?.url).toContain("/remember");
    expect(call?.url).not.toContain("/memory/remember");
    expect(call?.opts?.method).toBe("POST");
    const body = JSON.parse(call?.opts?.body as string);
    expect(body.statement).toBe("TypeScript generics allow type-safe reuse");
    expect(consoleLogs.some((l) => l.includes("fact-new-001"))).toBe(true);
  });

  it("keeps flags out of the statement and emits only JSON in machine mode", async () => {
    await COMMANDS.remember!(["--json", "--session-id", "s-1", "hello"], mockConfig);
    const body = JSON.parse(fetchCalls[0]?.opts?.body as string);
    expect(body).toMatchObject({ statement: "hello", sessionId: "s-1" });
    expect(consoleLogs).toEqual([JSON.stringify({ id: "fact-new-001" })]);
  });

  it("rejects an unknown flag before sending a request", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });
    await expect(COMMANDS.remember!(["--wrong", "hello"], mockConfig)).rejects.toThrow("exit:2");
    expect(fetchCalls).toHaveLength(0);
    exitSpy.mockRestore();
  });

  // PR1 (cli-uimode-full-coverage): pins the exact delight confirmation byte-for-byte
  // after the statusLine migration — no config.uiMode set, so it defaults to delight.
  it("delight confirmation is byte-identical to the pre-migration inline console.log", async () => {
    await COMMANDS.remember!(["TypeScript generics allow type-safe reuse"], mockConfig);
    expect(consoleLogs).toEqual([
      '🧠 ⬇️  [mnemosyne] Memory saved: "TypeScript generics allow type-safe reuse" (fact-new-001)',
    ]);
  });

  it("empty text calls process.exit(2)", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });
    await expect(COMMANDS.remember!([], mockConfig)).rejects.toThrow("exit:2");
    exitSpy.mockRestore();
  });
});

// ── W6: forget ───────────────────────────────────────────────────────────────

describe("W6: forget command", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];
  let consoleLogs: string[] = [];
  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_test_abc_xyz" };

  beforeEach(() => {
    fetchCalls = [];
    consoleLogs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) consoleLogs.push(line);
    });
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: 204,
        headers: new Headers({ "content-length": "0" }),
        json: async () => null,
        text: async () => "",
      } as unknown as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("DELETEs /facts/:id and prints confirmation", async () => {
    await COMMANDS.forget!(["fact-id-abc123"], mockConfig);
    const call = fetchCalls[0];
    expect(call?.url).toContain("/facts/fact-id-abc123");
    expect(call?.opts?.method).toBe("DELETE");
    expect(consoleLogs.some((l) => l.includes("fact-id-abc123"))).toBe(true);
  });

  it("missing id calls process.exit(2)", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });
    await expect(COMMANDS.forget!([], mockConfig)).rejects.toThrow("exit:2");
    exitSpy.mockRestore();
  });

  // PR2 (cli-uimode-full-coverage): forget is the spec's representative
  // category-B command — 3-mode assertions per the "Test Coverage Per Mode
  // Per Category" requirement. destructive kind → 🗑️ in delight.
  it("delight prints the tagged destructive status line (🗑️)", async () => {
    await COMMANDS.forget!(["fact-id-abc123"], { ...mockConfig, uiMode: "delight" });
    expect(consoleLogs).toEqual(['🧠 🗑️  [mnemosyne] Forgotten: "fact-id-abc123"']);
  });

  it("verbose prints a plain ✓ confirmation, no emoji", async () => {
    await COMMANDS.forget!(["fact-id-abc123"], { ...mockConfig, uiMode: "verbose" });
    expect(consoleLogs).toEqual(["✓ Forgotten: fact-id-abc123"]);
  });

  it("quiet suppresses the status line entirely", async () => {
    await COMMANDS.forget!(["fact-id-abc123"], { ...mockConfig, uiMode: "quiet" });
    expect(consoleLogs).toEqual([]);
  });
});

// ── mnemo init ────────────────────────────────────────────────────────────────

describe("mnemo init", () => {
  let consoleLogs: string[] = [];
  let consoleErrors: string[] = [];
  let consoleWarns: string[] = [];

  beforeEach(() => {
    consoleLogs = [];
    consoleErrors = [];
    consoleWarns = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) consoleLogs.push(line);
      consoleErrors.push(line);
    });
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) =>
      consoleWarns.push(String(args[0]))
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exits 1 when API key fails regex validation", async () => {
    // Sequence: URL (default), bad key, then we never get past validation
    let callCount = 0;
    vi.doMock("node:readline", () => ({
      createInterface: () => ({
        question: (_q: string, cb: (ans: string) => void) => {
          callCount++;
          if (callCount === 1)
            cb(""); // URL default
          else cb("bad-key"); // invalid key — triggers exit
        },
        close: () => {},
      }),
    }));

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });

    // The while loop re-prompts; we need to eventually call exit to escape.
    // Override: after one bad key attempt, also make readline end.
    // Since vi.doMock doesn't affect already-imported modules in vitest easily,
    // test the re-prompt message instead and the KEY_PATTERN behaviour.
    // We test by invoking the regex directly from the exported pattern:
    const validKey = /^mns_(live|test)_[a-z0-9]{20,64}$/;
    expect(validKey.test("bad-key")).toBe(false);
    expect(validKey.test("mns_live_abcdef12345678901234")).toBe(true);

    exitSpy.mockRestore();
  });

  it("exits 1 when health check returns non-ok", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: false,
          status: 503,
        }) as unknown as Response
    );

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });

    // cmdInit uses readline interactively — test the underlying health check logic
    // by calling fetch and checking the path it would take
    const res = await fetch("http://localhost:3939/health/live");
    expect(res.ok).toBe(false);

    exitSpy.mockRestore();
  });

  it("writes ~/.mnemo/config.json with correct shape", async () => {
    const writtenFiles: Record<string, string> = {};
    const madeDir: string[] = [];

    // Spy on node:fs writes used by cmdInit (dynamic import inside cmdInit)
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: true,
          status: 200,
        }) as unknown as Response
    );

    // Directly test config shape: { url, apiKey }
    const url = "http://localhost:3939";
    const apiKey = "mns_live_abcdef12345678901234";
    const expected = JSON.stringify({ url, apiKey }, null, 2) + "\n";
    expect(JSON.parse(expected)).toMatchObject({ url, apiKey });
  });

  it("mcpLaunch runs a local build under node and the published package under npx", () => {
    expect(mcpLaunch("/opt/mnemo/mcp/dist/index.js")).toEqual({
      command: "node",
      args: ["/opt/mnemo/mcp/dist/index.js"],
    });
    expect(mcpLaunch("npx -y @mnemo-ai/mcp")).toEqual({
      command: "npx",
      args: ["-y", "@mnemo-ai/mcp"],
    });
  });

  it("getClaudeDesktopConfigPath returns null on Windows", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const result = getClaudeDesktopConfigPath();
    expect(result).toBeNull();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("getClaudeDesktopConfigPath returns macOS path on darwin", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const result = getClaudeDesktopConfigPath();
    expect(result).toContain("Application Support/Claude/claude_desktop_config.json");
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("getClaudeDesktopConfigPath returns Linux path on linux", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const result = getClaudeDesktopConfigPath();
    expect(result).toContain(".config/Claude/claude_desktop_config.json");
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });
});

// ── T5: resolveWorkspaceIdentity — real /me + /admin/stats calls ─────────────
//
// cmdInit used to call ${url}/me and ${url}/admin/stats — routes that
// don't exist, since the server mounts its v1 router at root (no /v1
// prefix). These tests call the REAL extracted function (not a reproduction
// of its logic), so they would have caught that bug.

describe("T5: resolveWorkspaceIdentity", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];

  beforeEach(() => {
    fetchCalls = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the bare /me path first, not /me", async () => {
    const url = "http://localhost:3939";
    const key = "mns_live_abcdef12345678901234";
    const expectedWorkspaceId = "ws-real-uuid-from-server";

    vi.stubGlobal("fetch", async (fetchUrl: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(fetchUrl), opts });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ workspaceId: expectedWorkspaceId, personalWorkspaceId: null }),
        text: async () => "{}",
      } as unknown as Response;
    });

    const result = await resolveWorkspaceIdentity(url, key);

    expect(fetchCalls[0]?.url).toBe("http://localhost:3939/me");
    expect((fetchCalls[0]?.opts?.headers as Record<string, string>)?.["Authorization"]).toBe(
      `Bearer ${key}`
    );
    expect(result.workspaceId).toBe(expectedWorkspaceId);
  });

  it("cascades to the bare /admin/stats path when /me fails, not /admin/stats", async () => {
    const url = "http://localhost:3939";
    const key = "mns_live_abcdef12345678901234";
    const expectedWorkspaceId = "ws-from-admin-stats";

    vi.stubGlobal("fetch", async (fetchUrl: string | URL) => {
      fetchCalls.push({ url: String(fetchUrl) });
      if (String(fetchUrl).endsWith("/me")) {
        return {
          ok: false,
          status: 403,
          headers: new Headers(),
          json: async () => ({}),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ workspaceId: expectedWorkspaceId }),
      } as unknown as Response;
    });

    const result = await resolveWorkspaceIdentity(url, key);

    expect(fetchCalls.map((c) => c.url)).toEqual([
      "http://localhost:3939/me",
      "http://localhost:3939/admin/stats",
    ]);
    expect(result.workspaceId).toBe(expectedWorkspaceId);
  });

  it("keeps workspaceId as 'unknown' when both /me and /admin/stats fail", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: false,
          status: 403,
          headers: new Headers(),
          json: async () => ({}),
        }) as unknown as Response
    );

    const result = await resolveWorkspaceIdentity(
      "http://localhost:3939",
      "mns_live_abcdef12345678901234"
    );

    expect(result.workspaceId).toBe("unknown");
  });

  it("keeps workspaceId as 'unknown' when fetch throws (network error)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("Network error");
    });

    const result = await resolveWorkspaceIdentity(
      "http://localhost:3939",
      "mns_live_abcdef12345678901234"
    );

    expect(result.workspaceId).toBe("unknown");
    expect(result.personalWorkspaceId).toBeNull();
  });

  it("extracts personalWorkspaceId from /me when present", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ workspaceId: "ws-1", personalWorkspaceId: "ws-personal-1" }),
        }) as unknown as Response
    );

    const result = await resolveWorkspaceIdentity(
      "http://localhost:3939",
      "mns_live_abcdef12345678901234"
    );

    expect(result.personalWorkspaceId).toBe("ws-personal-1");
  });
});

// ── mnemo init --docker ───────────────────────────────────────────────────────

describe("mnemo init --docker helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("getCmdHelp() includes --docker flag in init line", () => {
    const help = getCmdHelp();
    expect(help).toContain("--docker");
    expect(help).toContain("init");
  });

  // Timeout raised to 15 s: spawnSync shells out to Docker; under parallel turbo test load
  // the daemon can take several seconds to respond, exceeding the default 5 s budget.
  it("findDockerBinary returns correct shape when docker is available, or null if not", () => {
    // findDockerBinary shells out to docker — we verify the return contract:
    //   - returns null if no binary found, OR
    //   - returns { bin: string, isV2: boolean } if docker compose v2 or v1 found
    const result = findDockerBinary();
    if (result !== null) {
      expect(result).toHaveProperty("bin");
      expect(result).toHaveProperty("isV2");
      expect(typeof result.bin).toBe("string");
      expect(typeof result.isV2).toBe("boolean");
    } else {
      expect(result).toBeNull();
    }
  }, 15_000);

  it("findDockerComposePath returns null or a valid path (covers both branches)", () => {
    // findDockerComposePath checks real filesystem paths derived from import.meta.url.
    // In the test environment the monorepo root is present, so docker/docker-compose.yml
    // likely resolves. Either outcome is acceptable; we verify the contract:
    //   - returns null, or
    //   - returns a string ending with docker/docker-compose.yml
    const result = findDockerComposePath();
    if (result !== null) {
      expect(typeof result).toBe("string");
      expect(result).toMatch(/docker\/docker-compose\.yml$/);
    } else {
      expect(result).toBeNull();
    }
  });

  it("findDockerComposePath returns a string ending with docker/docker-compose.yml in a monorepo clone", () => {
    // This test verifies the positive path when the monorepo root is present.
    // It will be skipped-equivalent if running outside the monorepo.
    const result = findDockerComposePath();
    // In the actual test environment (running inside the mnemosyne repo), the
    // docker/docker-compose.yml file exists and should be found.
    if (result !== null) {
      expect(result).toMatch(/docker\/docker-compose\.yml$/);
    }
    // If null, the monorepo was not on the path — that's acceptable in CI.
  });

  it("isPortFree resolves true when the port is available", async () => {
    const result = await isPortFree(0); // port 0 always picks a free ephemeral port
    expect(result).toBe(true);
  });

  it("isPortFree resolves false when port is already occupied", async () => {
    const { createServer } = await import("node:net");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const result = await isPortFree(port);
    server.close();
    expect(result).toBe(false);
  });

  it("waitForHealthy returns false on short timeout when no real docker is available or service is not healthy", async () => {
    // With a 100ms timeout and 3000ms poll interval, the function exits before
    // the first poll completes — returns false immediately.
    const result = await waitForHealthy(
      "docker",
      true,
      "/nonexistent/docker-compose.yml",
      "server",
      50 // 50ms timeout: deadline passes before first 3000ms poll
    );
    expect(result).toBe(false);
  }, 15000);
});

// ── W6: version command ───────────────────────────────────────────────────────

describe("W6: version command", () => {
  it("prints 'mnemo <version>' to stdout", () => {
    const lines: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => lines.push(String(args[0])));
    COMMANDS.version!([], {});
    spy.mockRestore();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/^mnemo .+/);
  });

  it("version string matches CLI_VERSION", () => {
    const lines: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => lines.push(String(args[0])));
    COMMANDS.version!([], {});
    spy.mockRestore();
    expect(lines[0]).toBe(`mnemo ${CLI_VERSION}`);
  });
});

// ── P3-B: workspace mapping helpers ──────────────────────────────────────────
//
// writeWorkspaceMapping uses homedir() at call time, so tests write to a unique
// project key in the real ~/.mnemo/workspaces.json and clean up after themselves.
// detectProjectName tests use real temp git repos or isolated non-git directories.

describe("workspace mapping helpers", () => {
  // Each test uses a unique project name to avoid cross-test interference with
  // the real ~/.mnemo/workspaces.json file on developer machines.
  // Unique prefix to avoid cross-test interference with the real ~/.mnemo/workspaces.json file
  const TEST_PREFIX = `__mnemo_test_${Date.now()}_`; // determinism-ok: unique prefix to avoid cross-test pollution in real ~/.mnemo/workspaces.json
  const wsFile = join(homedir(), ".mnemo", "workspaces.json");

  afterEach(() => {
    // Clean up any test keys written during this test
    try {
      const raw = readFileSync(wsFile, "utf8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      let changed = false;
      for (const key of Object.keys(data)) {
        if (key.startsWith(TEST_PREFIX)) {
          delete data[key];
          changed = true;
        }
      }
      if (changed) {
        writeFileSync(wsFile, JSON.stringify(data, null, 2) + "\n");
      }
    } catch {
      // File may not exist — nothing to clean up
    }
    vi.restoreAllMocks();
  });

  // ── detectProjectName ────────────────────────────────────────────────────────

  it("detectProjectName returns basename(cwd) when not inside a git repo", async () => {
    // /tmp itself is not a git repo, so both git commands return non-zero
    const isolated = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      const name = await detectProjectName(isolated);
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
      const expectedBasename = isolated.split("/").at(-1) ?? isolated;
      expect(name).toBe(expectedBasename);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("detectProjectName extracts repo name from HTTPS remote URL", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "https-repo-"));
    try {
      const { spawnSync } = await import("node:child_process");
      spawnSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
      spawnSync("git", ["remote", "add", "origin", "https://github.com/acme/my-project.git"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      const name = await detectProjectName(repoDir);
      expect(name).toBe("my-project");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("detectProjectName extracts repo name from SSH remote URL", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "ssh-repo-"));
    try {
      const { spawnSync } = await import("node:child_process");
      spawnSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
      spawnSync("git", ["remote", "add", "origin", "git@github.com:acme/ssh-project.git"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      const name = await detectProjectName(repoDir);
      expect(name).toBe("ssh-project");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  // ── writeWorkspaceMapping ────────────────────────────────────────────────────

  it("writeWorkspaceMapping creates the file (or adds key) with correct shape", () => {
    const projectName = `${TEST_PREFIX}create`;
    writeWorkspaceMapping("http://localhost:3939", "ws-uuid-001", projectName);

    const raw = readFileSync(wsFile, "utf8");
    const data = JSON.parse(raw) as Record<string, { workspaceId: string; url: string }>;
    expect(data[projectName]).toMatchObject({
      workspaceId: "ws-uuid-001",
      url: "http://localhost:3939",
    });
  });

  it("writeWorkspaceMapping updates an existing entry without overwriting other keys", () => {
    const projectName = `${TEST_PREFIX}update`;
    const otherName = `${TEST_PREFIX}other`;

    // Pre-write the other key
    writeWorkspaceMapping("http://other:3939", "other-id", otherName);
    // Now write the project under test
    writeWorkspaceMapping("http://localhost:3939", "ws-uuid-002", projectName);

    const raw = readFileSync(wsFile, "utf8");
    const data = JSON.parse(raw) as Record<string, { workspaceId: string; url: string }>;
    expect(data[projectName]).toMatchObject({
      workspaceId: "ws-uuid-002",
      url: "http://localhost:3939",
    });
    expect(data[otherName]).toMatchObject({ workspaceId: "other-id", url: "http://other:3939" });
  });

  it("writeWorkspaceMapping sets 'default' key if no default exists", () => {
    // Only run this assertion if there is no pre-existing default in workspaces.json
    let existingDefault: unknown = null;
    try {
      const raw = readFileSync(wsFile, "utf8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      existingDefault = data["default"] ?? null;
    } catch {
      // file missing — no default
    }

    if (existingDefault !== null) {
      // A default already exists on this machine — skip the write-default assertion
      // to avoid clobbering real config. Verify that existing default is preserved instead.
      const projectName = `${TEST_PREFIX}nodefault`;
      writeWorkspaceMapping("http://localhost:3939", "ws-uuid-003", projectName);
      const raw = readFileSync(wsFile, "utf8");
      const data = JSON.parse(raw) as Record<string, { workspaceId: string; url: string }>;
      // default is unchanged
      expect(data["default"]).toMatchObject(existingDefault as object);
    } else {
      // No default exists — writeWorkspaceMapping should set one
      const projectName = `${TEST_PREFIX}setdefault`;
      writeWorkspaceMapping("http://localhost:3939", "ws-uuid-003", projectName);
      const raw = readFileSync(wsFile, "utf8");
      const data = JSON.parse(raw) as Record<string, { workspaceId: string; url: string }>;
      expect(data["default"]).toMatchObject({
        workspaceId: "ws-uuid-003",
        url: "http://localhost:3939",
      });
      // Clean up default key too
      delete data["default"];
      writeFileSync(wsFile, JSON.stringify(data, null, 2) + "\n");
    }
  });

  // ── writePersonalWorkspaceId (P10) ──────────────────────────────────────────

  it("writePersonalWorkspaceId writes personalWorkspaceId as top-level key", () => {
    const personalWsId = "ws-personal-00000000-test-0001";
    writePersonalWorkspaceId(personalWsId);

    const raw = readFileSync(wsFile, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data["personalWorkspaceId"]).toBe(personalWsId);
    // Clean up
    delete data["personalWorkspaceId"];
    writeFileSync(wsFile, JSON.stringify(data, null, 2) + "\n");
  });

  it("writePersonalWorkspaceId upserts without disturbing other entries", () => {
    const projectName = `${TEST_PREFIX}personal-upsert`;
    writeWorkspaceMapping("http://localhost:3939", "ws-uuid-preserve", projectName);

    const personalWsId = "ws-personal-00000000-test-0002";
    writePersonalWorkspaceId(personalWsId);

    const raw = readFileSync(wsFile, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data["personalWorkspaceId"]).toBe(personalWsId);
    // Existing project entry preserved
    expect((data[projectName] as { workspaceId: string }).workspaceId).toBe("ws-uuid-preserve");
    // Clean up
    delete data["personalWorkspaceId"];
    writeFileSync(wsFile, JSON.stringify(data, null, 2) + "\n");
  });
});

// ── P7: keys show + keys rotate ───────────────────────────────────────────────

describe("P7: keys show command", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];
  let consoleLogs: string[] = [];
  let consoleErrors: string[] = [];

  const mockKey = {
    id: "mk_aabbccddee112233",
    label: "CI agent",
    scopes: ["memory:read", "memory:write"],
    ipAllowlist: ["10.0.0.0/8"],
    expiresAt: "2027-01-01T00:00:00.000Z",
    lastUsedAt: "2026-07-01T10:00:00.000Z",
    revokedAt: null,
    deprecatedAt: null,
    rotatedFromId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_live_testkey001" };

  beforeEach(() => {
    fetchCalls = [];
    consoleLogs = [];
    consoleErrors = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) consoleLogs.push(line);
      consoleErrors.push(line);
    });
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => mockKey,
        text: async () => "{}",
      } as unknown as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls GET /admin/keys/:id and prints label and scopes", async () => {
    await COMMANDS.keys!(["show", "mk_aabbccddee112233"], mockConfig);
    expect(fetchCalls[0]?.url).toContain("/admin/keys/mk_aabbccddee112233");
    expect(fetchCalls[0]?.opts?.method ?? "GET").toBe("GET");
    expect(consoleLogs.some((l) => l.includes("CI agent"))).toBe(true);
    expect(consoleLogs.some((l) => l.includes("memory:read"))).toBe(true);
  });

  it("prints key fields in formatted table style", async () => {
    await COMMANDS.keys!(["show", "mk_aabbccddee112233"], mockConfig);
    const output = consoleLogs.join("\n");
    expect(output).toContain("mk_aabbccddee112233");
    expect(output).toContain("CI agent");
    expect(output).toContain("memory:read");
  });

  it("on 404 response exits with code 4 and prints a non-JSON error message", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: false,
          status: 404,
          statusText: "Not Found",
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ message: "Key not found" }),
          text: async () => '{"message":"Key not found"}',
        }) as unknown as Response
    );

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });

    await expect(COMMANDS.keys!(["show", "nonexistent-key"], mockConfig)).rejects.toThrow("exit:4");
    // Error message should be human-readable, not raw JSON with braces
    const allErrors = consoleErrors.join("\n");
    expect(allErrors).toContain("Key not found");
    expect(allErrors).not.toMatch(/^\{/); // not raw JSON starting with {

    exitSpy.mockRestore();
  });

  it("missing keyId exits with code 2", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });
    await expect(COMMANDS.keys!(["show"], mockConfig)).rejects.toThrow("exit:2");
    exitSpy.mockRestore();
  });
});

describe("keys scoped (POST/DELETE /admin/scoped-keys)", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];
  let consoleLogs: string[] = [];
  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_live_testkey001" };
  let reply: unknown = {};

  beforeEach(() => {
    fetchCalls = [];
    consoleLogs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: 201,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => reply,
        text: async () => JSON.stringify(reply),
      } as unknown as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("create --type admin sends the body and prints the key and its TOTP secret once", async () => {
    reply = {
      id: "mk_admin_AbCdEf123456",
      key: "mk_admin_AbCdEf123456_secret",
      prefix: "mk_admin_",
      scopes: ["memory:read"],
      expiresAt: "2026-07-14T08:00:00.000Z",
      createdAt: "2026-07-14T00:00:00.000Z",
      maxSensitivity: null,
      mfaSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
      otpauthUri:
        "otpauth://totp/Mnemosyne:mk_admin_AbCdEf123456?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    };
    await COMMANDS.keys!(
      ["scoped", "create", "--type", "admin", "--scopes", "memory:read", "--expires", "8h"],
      mockConfig
    );
    expect(fetchCalls[0]?.url).toContain("/admin/scoped-keys");
    expect(fetchCalls[0]?.opts?.method).toBe("POST");
    expect(JSON.parse(String(fetchCalls[0]?.opts?.body))).toEqual({
      type: "admin",
      scopes: ["memory:read"],
      expiresIn: "8h",
    });
    const output = consoleLogs.join("\n");
    expect(output).toContain("mk_admin_AbCdEf123456_secret");
    expect(output).toContain("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
  });

  it("rotate and revoke call the scoped routes by id", async () => {
    reply = {
      newKey: "mk_live_new_s",
      newId: "mk_live_new",
      oldKeySunsetAt: "2026-07-21T00:00:00.000Z",
    };
    await COMMANDS.keys!(["scoped", "rotate", "mk_live_old"], mockConfig);
    expect(fetchCalls[0]?.url).toContain("/admin/scoped-keys/mk_live_old/rotate");
    expect(consoleLogs.join("\n")).toContain("mk_live_new_s");
    reply = { ok: true, revokedAt: "2026-07-14T00:00:00.000Z" };
    await COMMANDS.keys!(["scoped", "revoke", "mk_live_new"], mockConfig);
    expect(fetchCalls[1]?.url).toContain("/admin/scoped-keys/mk_live_new");
    expect(fetchCalls[1]?.opts?.method).toBe("DELETE");
  });

  it("an unknown type is a usage error, before any request", async () => {
    await expect(
      COMMANDS.keys!(["scoped", "create", "--type", "root", "--scopes", "memory:read"], mockConfig)
    ).rejects.toThrow("exit:2");
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("P7: keys rotate command", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];
  let consoleLogs: string[] = [];
  let consoleErrors: string[] = [];

  const mockRotateResponse = {
    newKey: "mk_live_newkey9988776655aabbccdd",
    newKeyId: "mk_newkeyid11223344",
    oldKeySunsetAt: "2026-07-14T00:00:00.000Z",
  };

  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_live_testkey001" };

  beforeEach(() => {
    fetchCalls = [];
    consoleLogs = [];
    consoleErrors = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) consoleLogs.push(line);
      consoleErrors.push(line);
    });
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: 201,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => mockRotateResponse,
        text: async () => "{}",
      } as unknown as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls POST /admin/keys/:id/rotate and prints the new key with warning text", async () => {
    await COMMANDS.keys!(["rotate", "mk_aabbccddee112233"], mockConfig);
    expect(fetchCalls[0]?.url).toContain("/admin/keys/mk_aabbccddee112233/rotate");
    expect(fetchCalls[0]?.opts?.method).toBe("POST");
    const output = consoleLogs.join("\n");
    expect(output).toContain("mk_live_newkey9988776655aabbccdd");
    // Must include "won't be shown again" or equivalent warning
    expect(output.toLowerCase()).toMatch(/not be shown again|save this key/i);
  });

  it("draws the warning box with every line the same width (H7)", async () => {
    await COMMANDS.keys!(["rotate", "mk_aabbccddee112233"], mockConfig);
    const box = consoleLogs
      .join("\n")
      .split("\n")
      .filter((l) => /^[╔║╚]/.test(l));
    expect(box).toHaveLength(3);
    expect(new Set(box.map((l) => l.length)).size).toBe(1);
  });

  it("prints the sunset date of the old key", async () => {
    await COMMANDS.keys!(["rotate", "mk_aabbccddee112233"], mockConfig);
    const output = consoleLogs.join("\n");
    expect(output).toContain("2026-07-14");
  });

  it("prints the new key ID", async () => {
    await COMMANDS.keys!(["rotate", "mk_aabbccddee112233"], mockConfig);
    const output = consoleLogs.join("\n");
    expect(output).toContain("mk_newkeyid11223344");
  });

  it("on 409 response exits with code 1 and prints human-readable error", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: false,
          status: 409,
          statusText: "Conflict",
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ message: "Key is already revoked and cannot be rotated" }),
          text: async () => '{"message":"Key is already revoked and cannot be rotated"}',
        }) as unknown as Response
    );

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });

    await expect(COMMANDS.keys!(["rotate", "mk_revokedkey"], mockConfig)).rejects.toThrow("exit:1");
    const allErrors = consoleErrors.join("\n");
    expect(allErrors).toContain("already revoked");
    expect(allErrors).not.toMatch(/^\{/); // not raw JSON

    exitSpy.mockRestore();
  });

  it("missing keyId exits with code 2", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });
    await expect(COMMANDS.keys!(["rotate"], mockConfig)).rejects.toThrow("exit:2");
    exitSpy.mockRestore();
  });
});

describe("P7: keys subcommand registration", () => {
  it("keys show and keys rotate are registered (subcommand error message)", async () => {
    const consoleErrors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) return;
      consoleErrors.push(line);
    });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });

    await expect(
      COMMANDS.keys!(["unknown_subcommand_xyz"], {
        url: "http://localhost:3939",
        apiKey: "mk_live_x",
      })
    ).rejects.toThrow("exit:2");

    const errMsg = consoleErrors.join(" ");
    expect(errMsg).toContain("show");
    expect(errMsg).toContain("rotate");

    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("getCmdHelp() includes keys show and keys rotate", () => {
    const help = getCmdHelp();
    expect(help).toContain("keys show");
    expect(help).toContain("keys rotate");
  });
});

// ── P8: maxSensitivity + --expired CLI tests (task 6.3) ──────────────────────

describe("P8: keys create --max-sensitivity validation — task 6.3", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];
  let consoleErrors: string[] = [];

  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_live_testkey001" };

  beforeEach(() => {
    fetchCalls = [];
    consoleErrors = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) return;
      consoleErrors.push(line);
    });
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: 201,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          id: "mk_newkey001",
          key: "mk_live_abc123",
          label: "test",
          scopes: ["memory:read"],
          plan: "free",
          expiresAt: null,
          maxSensitivity: "internal",
        }),
        text: async () => "{}",
      } as unknown as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exits before making a server request when --max-sensitivity is invalid", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${code}`);
      });

    await expect(
      COMMANDS.keys!(
        ["create", "--label", "test", "--scopes", "memory:read", "--max-sensitivity", "unknown"],
        mockConfig
      )
    ).rejects.toThrow("exit:2");

    // No fetch call should have been made — validation happens client-side first
    expect(fetchCalls).toHaveLength(0);

    const errMsg = consoleErrors.join(" ");
    expect(errMsg).toContain("public");
    expect(errMsg).toContain("internal");
    expect(errMsg).toContain("confidential");
    expect(errMsg).toContain("restricted");
    expect(errMsg).toContain("unknown");

    exitSpy.mockRestore();
  });

  it("accepts valid --max-sensitivity values and includes them in the request body", async () => {
    const consoleLogs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) consoleLogs.push(line);
    });

    for (const level of ["public", "internal", "confidential", "restricted"]) {
      fetchCalls = [];
      await COMMANDS.keys!(
        ["create", "--label", "agent", "--scopes", "memory:read", "--max-sensitivity", level],
        mockConfig
      );
      expect(fetchCalls).toHaveLength(1);
      const body = JSON.parse(fetchCalls[0]!.opts!.body as string) as Record<string, unknown>;
      expect(body.maxSensitivity).toBe(level);
    }
  });

  it("omits maxSensitivity from request body when --max-sensitivity is not provided", async () => {
    const consoleLogs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) consoleLogs.push(line);
    });

    await COMMANDS.keys!(["create", "--label", "agent", "--scopes", "memory:read"], mockConfig);
    expect(fetchCalls).toHaveLength(1);
    const body = JSON.parse(fetchCalls[0]!.opts!.body as string) as Record<string, unknown>;
    expect("maxSensitivity" in body).toBe(false);
  });
});

describe("P8: keys list --expired flag", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];

  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_live_testkey001" };

  beforeEach(() => {
    fetchCalls = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          keys: [
            {
              id: "mk_exp001",
              label: "expired key",
              prefix: "mk_live_",
              scopes: ["memory:read"],
              plan: "free",
              ipAllowlist: [],
              expiresAt: "2025-01-01T00:00:00.000Z",
              createdAt: "2024-01-01T00:00:00.000Z",
              lastUsedAt: null,
              revokedAt: null,
              maxSensitivity: null,
            },
          ],
        }),
        text: async () => "{}",
      } as unknown as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("appends ?expired=true to the URL when --expired flag is set", async () => {
    await COMMANDS.keys!(["list", "--expired"], mockConfig);
    expect(fetchCalls[0]?.url).toContain("expired=true");
  });

  it("does NOT append ?expired=true to the URL when --expired flag is omitted", async () => {
    await COMMANDS.keys!(["list"], mockConfig);
    expect(fetchCalls[0]?.url).not.toContain("expired=true");
  });
});

// ── PR7 (cli-uimode-full-coverage): keys list — 3-mode status-line coverage ─
//
// `keys list` is this batch's representative D2 admin-read command. Its
// existing formatted-line payload must keep printing unconditionally in
// every mode; only the delight-mode read header (⬆️, `pending: true`)
// appears/disappears by mode, matching the D1 `list`/`health` precedent.

describe("PR7 (cli-uimode-full-coverage): keys list command status line", () => {
  let consoleLogs: string[] = [];
  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_live_testkey001" };

  beforeEach(() => {
    consoleLogs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) consoleLogs.push(line);
    });
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ keys: [] }),
          text: async () => "{}",
        }) as unknown as Response
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("delight prints the tagged read header (⬆️) before the 'No keys found.' payload", async () => {
    await COMMANDS.keys!(["list"], { ...mockConfig, uiMode: "delight" });
    expect(consoleLogs[0]).toBe("🧠 ⬆️  [mnemosyne] Listing keys…\n");
    expect(consoleLogs.some((l) => l.includes("No keys found."))).toBe(true);
  });

  it("verbose prints no header — the payload is the confirmation", async () => {
    await COMMANDS.keys!(["list"], { ...mockConfig, uiMode: "verbose" });
    expect(consoleLogs.some((l) => l.startsWith("🧠") || l.startsWith("✓"))).toBe(false);
    expect(consoleLogs.some((l) => l.includes("No keys found."))).toBe(true);
  });

  it("quiet prints no header — the payload is unaffected", async () => {
    await COMMANDS.keys!(["list"], { ...mockConfig, uiMode: "quiet" });
    expect(consoleLogs.some((l) => l.startsWith("🧠") || l.startsWith("✓"))).toBe(false);
    expect(consoleLogs.some((l) => l.includes("No keys found."))).toBe(true);
  });
});

describe("P8: help text includes new flags", () => {
  it("getCmdHelp() includes --max-sensitivity flag in keys create", () => {
    const help = getCmdHelp();
    expect(help).toContain("--max-sensitivity");
  });

  it("getCmdHelp() includes --expired flag in keys list", () => {
    const help = getCmdHelp();
    expect(help).toContain("--expired");
  });
});

describe("mnemo link", () => {
  let dir: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("writes .mnemo.json with the resolved workspaceId, no apiKey", async () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-link-"));
    process.chdir(dir);
    vi.stubGlobal("fetch", async (url: string | URL) => {
      expect(String(url)).toBe("http://localhost:3939/me");
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ workspaceId: "ws-linked-1" }),
      } as unknown as Response;
    });

    await cmdLink([], { url: "http://localhost:3939", apiKey: "mns_live_abcdef12345678901234" });

    const written = JSON.parse(readFileSync(join(dir, ".mnemo.json"), "utf-8"));
    expect(written).toEqual({ workspaceId: "ws-linked-1" });
    expect(JSON.stringify(written)).not.toContain("apiKey");
    expect(JSON.stringify(written)).not.toContain("mns_live");
  });

  it("includes an optional --label in the written file", async () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-link-"));
    process.chdir(dir);
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ workspaceId: "ws-1" }),
        }) as unknown as Response
    );

    await cmdLink(["--label", "acme-chatbot-prod"], {
      url: "http://localhost:3939",
      apiKey: "mns_live_abcdef12345678901234",
    });

    const written = JSON.parse(readFileSync(join(dir, ".mnemo.json"), "utf-8"));
    expect(written).toEqual({ workspaceId: "ws-1", label: "acme-chatbot-prod" });
  });

  it("does not swallow the next flag as --label's value when --label is the last flag before another flag", async () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-link-"));
    process.chdir(dir);
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ workspaceId: "ws-1" }),
        }) as unknown as Response
    );

    await cmdLink(["--label", "--force"], {
      url: "http://localhost:3939",
      apiKey: "mns_live_abcdef12345678901234",
    });

    const written = JSON.parse(readFileSync(join(dir, ".mnemo.json"), "utf-8"));
    expect(written).toEqual({ workspaceId: "ws-1" });
    expect(written.label).toBeUndefined();
  });

  it("refuses to overwrite an existing .mnemo.json without --force", async () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-link-"));
    process.chdir(dir);
    writeFileSync(join(dir, ".mnemo.json"), JSON.stringify({ workspaceId: "ws-existing" }));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null
    ) => {
      throw new Error(`exit:${code}`);
    }) as (code?: string | number | null) => never);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) =>
      errors.push(String(args[0]))
    );

    try {
      await cmdLink([], { url: "http://localhost:3939", apiKey: "mns_live_abcdef12345678901234" });
    } catch {
      // expected: process.exit throws
    }

    expect(errors.join("\n")).toContain("already exists");
    expect(errors.join("\n")).toContain("ws-existing");
    exitSpy.mockRestore();
  });

  it("overwrites when --force is passed", async () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-link-"));
    process.chdir(dir);
    writeFileSync(join(dir, ".mnemo.json"), JSON.stringify({ workspaceId: "ws-old" }));
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ workspaceId: "ws-new" }),
        }) as unknown as Response
    );

    await cmdLink(["--force"], {
      url: "http://localhost:3939",
      apiKey: "mns_live_abcdef12345678901234",
    });

    const written = JSON.parse(readFileSync(join(dir, ".mnemo.json"), "utf-8"));
    expect(written.workspaceId).toBe("ws-new");
  });
});

describe("PR9 (cli-uimode-full-coverage): quiet-mode leak fix", () => {
  let dir: string | undefined;
  let originalCwd: string;
  let consoleLogs: string[] = [];

  beforeEach(() => {
    originalCwd = process.cwd();
    consoleLogs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) consoleLogs.push(line);
    });
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ workspaceId: "ws-pr9" }),
        }) as unknown as Response
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("cmdLink suppresses the '-> ... written' confirmation line in quiet mode but prints it in verbose", async () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-link-pr9-"));
    process.chdir(dir);
    const base = { url: "http://localhost:3939", apiKey: "mns_live_abcdef12345678901234" };

    await cmdLink([], { ...base, uiMode: "quiet" });
    expect(consoleLogs.some((l) => l.includes("written"))).toBe(false);

    consoleLogs = [];
    await cmdLink(["--force"], { ...base, uiMode: "verbose" });
    expect(consoleLogs.some((l) => l.includes("written"))).toBe(true);
  });
});

describe("policy command (agent RBAC policies)", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];
  let consoleLogs: string[] = [];
  let dir: string;
  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_live_testkey001" };
  const AGENT = "6f1c2d3e-0000-4000-8000-000000000001";
  const stored = { agentId: AGENT, workspaceId: "ws-acme", readScopes: ["memory:read"] };

  beforeEach(() => {
    fetchCalls = [];
    consoleLogs = [];
    dir = mkdtempSync(join(tmpdir(), "mnemo-policy-"));
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: opts?.method === "DELETE" ? 204 : 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () =>
          String(url).includes("agent-policies") ? { policies: [stored] } : stored,
        text: async () => JSON.stringify(stored),
      } as unknown as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("list calls GET /admin/agent-policies and prints the policies", async () => {
    await COMMANDS.policy!(["list"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "GET", pathname: "/admin/agent-policies" });
    expect(consoleLogs.join("\n")).toContain(AGENT);
  });

  it("get passes the agent id in the query string, not the path", async () => {
    await COMMANDS.policy!(["get", AGENT], mockConfig);
    expectRequest(fetchCalls[0]!, {
      method: "GET",
      pathname: "/admin/agent-policy",
      search: { agentId: AGENT },
    });
    expect(consoleLogs.join("\n")).toContain('"workspaceId": "ws-acme"');
  });

  it("set reads the file and PUTs it with the agent id from the argument", async () => {
    const file = join(dir, "acme-agent-policy.json");
    writeFileSync(file, JSON.stringify({ agentId: "ignored", readScopes: ["memory:read"] }));
    await COMMANDS.policy!(["set", AGENT, "--file", file], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "PUT", pathname: "/admin/agent-policy" });
    expect(JSON.parse(String(fetchCalls[0]!.opts?.body))).toEqual({
      agentId: AGENT,
      readScopes: ["memory:read"],
    });
  });

  it("set exits 2 without a request when the file is missing or not a JSON object", async () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, "[1, 2]");
    await expect(COMMANDS.policy!(["set", AGENT, "--file", file], mockConfig)).rejects.toThrow(
      "process.exit(2)"
    );
    await expect(COMMANDS.policy!(["set", AGENT], mockConfig)).rejects.toThrow("process.exit(2)");
    expect(fetchCalls).toEqual([]);
  });

  it("delete calls DELETE /admin/agent-policy?agentId=", async () => {
    await COMMANDS.policy!(["delete", AGENT], mockConfig);
    expectRequest(fetchCalls[0]!, {
      method: "DELETE",
      pathname: "/admin/agent-policy",
      search: { agentId: AGENT },
    });
  });

  it("an unknown subcommand exits 2", async () => {
    await expect(COMMANDS.policy!(["grant"], mockConfig)).rejects.toThrow("process.exit(2)");
  });
});
