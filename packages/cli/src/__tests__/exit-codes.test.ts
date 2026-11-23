/**
 * CLIENTS-18 — stdout is for the command's result, stderr for banners and
 * errors, and failures exit with the documented taxonomy (README "Exit codes").
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import {
  MnemosyneAPIError,
  MnemosyneNetworkError,
  MnemosyneTimeoutError,
} from "@mnemo-ai/client-ts";
import { main } from "../index.js";
import { EXIT, exitCodeForError } from "../exit-codes.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("exitCodeForError", () => {
  const api = (status: number) => new MnemosyneAPIError({ status, message: "x" });
  it("maps auth, not-found and transient failures to their documented codes", () => {
    expect(exitCodeForError(api(401))).toBe(EXIT.AUTH);
    expect(exitCodeForError(api(403))).toBe(EXIT.AUTH);
    expect(exitCodeForError(api(404))).toBe(EXIT.NOT_FOUND);
    for (const s of [408, 429, 500, 502, 503, 504]) {
      expect(exitCodeForError(api(s))).toBe(EXIT.TRANSIENT);
    }
    expect(exitCodeForError(new MnemosyneNetworkError("down", new Error("x")))).toBe(
      EXIT.TRANSIENT
    );
    expect(exitCodeForError(new MnemosyneTimeoutError(100))).toBe(EXIT.TRANSIENT);
  });
  it("falls back to 1 for everything else", () => {
    expect(exitCodeForError(api(400))).toBe(EXIT.GENERIC);
    expect(exitCodeForError(api(409))).toBe(EXIT.GENERIC);
    expect(exitCodeForError(new Error("boom"))).toBe(EXIT.GENERIC);
    expect(exitCodeForError("str")).toBe(EXIT.GENERIC);
  });
  it("uses distinct values and keeps 0/1", () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.GENERIC).toBe(1);
    expect(new Set(Object.values(EXIT)).size).toBe(Object.values(EXIT).length);
  });
});

describe("main() stream and exit-code contract", () => {
  let prevUrl: string | undefined;
  let prevKey: string | undefined;
  beforeAll(() => {
    prevUrl = process.env.MNEMO_URL;
    prevKey = process.env.MNEMO_KEY;
    process.env.MNEMO_URL = "http://localhost:3939";
    process.env.MNEMO_KEY = "mns_live_testkey00000000000000";
  });
  afterAll(() => {
    if (prevUrl === undefined) delete process.env.MNEMO_URL;
    else process.env.MNEMO_URL = prevUrl;
    if (prevKey === undefined) delete process.env.MNEMO_KEY;
    else process.env.MNEMO_KEY = prevKey;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function run(argv: string[], fetchImpl: typeof fetch) {
    const out: string[] = [];
    const err: string[] = [];
    const originalArgv = process.argv;
    process.argv = ["node", "mnemo", ...argv];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
    let exit: number | undefined;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exit = code;
      throw new Error(`exit:${code}`);
    }) as never);
    vi.stubGlobal("fetch", fetchImpl);
    try {
      await main();
    } catch (e) {
      if (exit === undefined) {
        const { exitCodeForError: f } = await import("../exit-codes.js");
        exit = f(e);
      }
    } finally {
      process.argv = originalArgv;
    }
    return { out: out.join("\n"), err: err.join("\n"), exit };
  }

  it("status --json prints only parseable JSON on stdout, no banner, no ANSI", async () => {
    const r = await run(["status", "--json"], async () => json(200, { status: "ok" }));
    expect(JSON.parse(r.out)).toEqual({ status: "ok" });
    expect(r.out).not.toContain("[mnemosyne]");
  });

  it("status without --json keeps the banner off stdout", async () => {
    const r = await run(["status"], async () => json(200, { status: "ok" }));
    expect(r.out).not.toContain("[mnemosyne]");
    expect(r.err).toContain("[mnemosyne]");
  });

  it("doctor --json prints the raw report on stdout and nothing else", async () => {
    const report = { status: "ok", checks: [{ name: "db", status: "ok" }] };
    const r = await run(["doctor", "--json"], async () => json(200, report));
    expect(JSON.parse(r.out)).toEqual(report);
    expect(r.err).not.toContain("[mnemosyne]");
  });

  it("doctor without --json keeps the banner off stdout", async () => {
    const r = await run(["doctor"], async () => json(200, { status: "ok", checks: [] }));
    expect(r.out).not.toContain("[mnemosyne]");
    expect(r.out).toContain("Mnemosyne Doctor");
  });

  it("recall (table mode) keeps the banner off stdout", async () => {
    const r = await run(["recall", "hello"], async () => json(200, { hits: [] }));
    expect(r.out).not.toContain("[mnemosyne]");
    expect(r.out).toContain("No results found.");
  });

  it("remember (plain) writes its confirmation to stderr only", async () => {
    const r = await run(["remember", "a fact"], async () => json(201, { id: "f1" }));
    expect(r.out).toBe("");
    expect(r.err).toContain("Memory saved");
  });

  it("usage errors exit 2", async () => {
    const r = await run(["recall"], async () => json(200, {}));
    expect(r.exit).toBe(EXIT.USAGE);
    const r2 = await run(["frobnicate"], async () => json(200, {}));
    expect(r2.exit).toBe(EXIT.USAGE);
  });

  it("401 and 403 exit 3, 404 exits 4", async () => {
    const mk = (s: number) => async () => json(s, { error: { message: "nope" } });
    expect((await run(["recall", "x"], mk(401))).exit).toBe(EXIT.AUTH);
    expect((await run(["recall", "x"], mk(403))).exit).toBe(EXIT.AUTH);
    expect((await run(["forget", "abc"], mk(404))).exit).toBe(EXIT.NOT_FOUND);
  });

  it("an unreachable server exits 5", async () => {
    const r = await run(["status"], async () => {
      throw new TypeError("fetch failed");
    });
    expect(r.exit).toBe(EXIT.TRANSIENT);
  });
});
