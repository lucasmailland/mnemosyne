/**
 * B1.3 — command → route map for the CLI's `COMMANDS` registry.
 *
 * CLI flags are ad-hoc `args.indexOf("--flag")` parsing with no
 * machine-readable schema (unlike the MCP tools' zod `inputSchema`), so the
 * per-command argv CANNOT be derived automatically. This file therefore
 * carries an explicit, reviewable `INVOCATIONS` fixture table — the design's
 * "the one place a fixture table is unavoidable" — but the OBLIGATION to
 * provide one is still enforced automatically: the completeness guard below
 * fails CI the moment a new `COMMANDS` entry ships with no matching
 * `INVOCATIONS` row, so a command can never silently launch with zero
 * coverage the way `cmdImport` originally did (Req 1/A1).
 *
 * A handful of commands are declared `skip` rather than exercised: they
 * mutate real host state (write `~/.mnemo/config.json` or `.mnemo.json` in
 * `process.cwd()`, spawn `docker`, spawn `claude mcp add`/detect installed
 * agent config directories, or block on interactive stdin) and would be
 * unsafe or non-deterministic to invoke from an automated test process.
 * `skip` still counts as "has a fixture" for the completeness guard — the
 * obligation is to make a reviewable DECISION about every command, not to
 * force a network call out of every one of them.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../commands.js";
import { expectRequest, type RecordedCall } from "./helpers/expect-request.js";

const mockConfig = { url: "http://localhost:3939", apiKey: "mk_test_routemap_abc123" };

type Invocation = { args: string[]; expectCalls?: boolean } | { skip: string };

/** One entry per `COMMANDS` key. `expectCalls` defaults to `true`. */
function invocations(importFilePath: string): Record<string, Invocation> {
  return {
    recall: { args: ["generics in TypeScript"] },
    remember: { args: ["TypeScript generics allow type-safe reuse"] },
    forget: { args: ["fact-id-abc123"] },
    status: { args: [], expectCalls: false }, // placeholder — real handling lives in index.ts's main()
    config: { args: [], expectCalls: false }, // placeholder — subcommands handled in index.ts
    help: { args: [], expectCalls: false }, // placeholder — handled in index.ts
    version: { args: [], expectCalls: false }, // prints CLI_VERSION, no network
    sessions: { args: [] },
    tasks: { args: [] },
    events: { args: [] },
    health: { args: [] },
    export: { args: [] },
    import: { args: [importFilePath] },
    login: { skip: "writes ~/.mnemo/config.json — real host side effect" },
    init: {
      skip: "spawns docker, prompts on stdin, or hits a real cloud setup endpoint",
    },
    install: {
      skip: "detects and mutates real installed-agent config directories on this host",
    },
    reset: { args: ["--workspace", "ws1", "--confirm"] },
    link: { skip: "writes .mnemo.json into process.cwd() — real host side effect" },
    list: { args: [] },
    search: { args: ["TypeScript", "generics"] },
    show: { args: ["fact-003"] },
    decide: { args: ["create", "--kind", "architecture", "--title", "t", "--body", "b"] },
    entity: { args: ["create", "--name", "Postgres", "--kind", "project"] },
    relate: { args: ["fact", "f1", "part_of", "entity", "e1"] },
    strategy: { args: ["create", "--trigger", "X happens", "--action", "do Y"] },
    workflow: { args: ["create", "--name", "Release", "--steps", '["step 1","step 2"]'] },
    skill: { args: ["create", "--name", "write-migration", "--prompt", "Do X"] },
    reasoning: {
      args: [
        "create",
        "--question",
        "how?",
        "--conclusion",
        "like this",
        "--chain",
        '[{"step":1,"reasoning":"..."}]',
      ],
    },
    hyperedge: { args: ["create", "--members", "a,b,c"] },
    episode: { args: ["start"] },
    pin: { args: ["f1"] },
    unpin: { args: ["f1"] },
    timeline: { args: [] },
    judge: { args: [] },
    purge: { args: ["f1", "--confirm"] },
    erase: { args: ["--actor", "key:k1", "--confirm", "key:k1"] },
    consolidate: { args: [] },
    remind: {
      args: ["create", "--content", "check the migration", "--trigger-at", "2026-08-01T00:00:00Z"],
    },
    completion: { args: ["bash"], expectCalls: false }, // pure local codegen, no network
    info: { args: [] },
    whoami: { args: [] },
    doctor: { args: [] },
    harness: {
      skip: "reads and mutates the real local capture queue under ~/.mnemo — host side effect",
    },
    workspace: { args: ["list"] },
    tenant: { args: ["show", "t1"] },
    user: { args: ["create", "--email", "a@example.com"] },
    token: { args: ["list", "t1", "u2"] },
    keys: { args: ["list"] },
    policy: { args: ["list"] },
  };
}

function stubJsonFetch(body: unknown = {}): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
    calls.push({ url: String(url), opts });
    return {
      ok: true,
      status: opts?.method === "POST" ? 201 : 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  return { calls };
}

describe("CLI command -> route map (B1.3)", () => {
  let dir: string;
  let importFilePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-route-map-"));
    importFilePath = join(dir, "fixture.jsonl.gz");
    writeFileSync(importFilePath, Buffer.from("fixture-bytes"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("has an invocation fixture (or explicit skip) for every COMMANDS entry", () => {
    const table = invocations(importFilePath);
    const missing = Object.keys(COMMANDS).filter((name) => !(name in table));
    expect(missing).toEqual([]);
  });

  it("has no dangling fixture for a command that no longer exists", () => {
    const table = invocations(importFilePath);
    const dangling = Object.keys(table).filter((name) => !(name in COMMANDS));
    expect(dangling).toEqual([]);
  });

  it("records the route each non-skipped command calls", async () => {
    const table = invocations(importFilePath);
    const routeMap: Record<string, Array<{ method: string; path: string }>> = {};
    const skipped: Record<string, string> = {};
    const unexpectedlySilent: string[] = [];

    for (const [name, invocation] of Object.entries(table)) {
      if ("skip" in invocation) {
        skipped[name] = invocation.skip;
        continue;
      }
      const { calls } = stubJsonFetch();
      const fn = COMMANDS[name];
      expect(fn, `COMMANDS.${name} is registered`).toBeDefined();
      try {
        await fn!(invocation.args, mockConfig);
      } catch {
        // Some fixtures intentionally exercise the "happy path" only; a
        // command that exits non-zero for this argv still may have issued
        // its request first (process.exit is stubbed to throw, not to kill
        // the process) — calls recorded so far are still meaningful.
      }
      const expectCalls = invocation.expectCalls ?? true;
      if (expectCalls && calls.length === 0) unexpectedlySilent.push(name);
      routeMap[name] = calls.map((c) => {
        const u = new URL(c.url);
        return { method: (c.opts?.method ?? "GET").toUpperCase(), path: u.pathname };
      });
    }

    expect(unexpectedlySilent).toEqual([]);

    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(routeMap).sort()) sorted[key] = routeMap[key];
    for (const key of Object.keys(skipped).sort()) sorted[`${key} (skipped)`] = skipped[key];

    await expect(JSON.stringify(sorted, null, 2) + "\n").toMatchFileSnapshot(
      "./command-routes.snapshot.json"
    );
  });

  it("sanity-checks a few representative recorded routes", async () => {
    const table = invocations(importFilePath);

    {
      const { calls } = stubJsonFetch();
      await COMMANDS.decide!(
        table.decide && "args" in table.decide ? table.decide.args : [],
        mockConfig
      );
      expectRequest(calls[0]!, { method: "POST", pathname: "/decisions" });
    }
    {
      const { calls } = stubJsonFetch();
      await COMMANDS.import!(
        table.import && "args" in table.import ? table.import.args : [],
        mockConfig
      );
      expectRequest(calls[0]!, { method: "POST", pathname: "/import" });
    }
    {
      const { calls } = stubJsonFetch({ keys: [] });
      await COMMANDS.keys!(table.keys && "args" in table.keys ? table.keys.args : [], mockConfig);
      expectRequest(calls[0]!, { method: "GET", pathname: "/admin/keys" });
    }
  });
});
