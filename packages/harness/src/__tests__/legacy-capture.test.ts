import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Module, { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { captureLegacyHook, drainLegacySpools } from "../legacy-capture.js";
import { enqueueVisibleMessage, readPendingEvents } from "../outbox.js";
import { ensureSecureHarnessPaths, withAdvisoryLock } from "../fs-security.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function home() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mnemo-harness-test-")));
  homes.push(dir);
  await mkdir(join(dir, ".mnemo/harness/capture"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(dir, ".mnemo/harness/capture/claude-code.json"),
    JSON.stringify({ version: 1, host: "claude-code", mode: "full" }),
    { mode: 0o600 }
  );
  return dir;
}

describe("durable legacy hook delivery", () => {
  it("keeps an offline spool bound to its original credential, including during drain", async () => {
    const dir = await home();
    const options = { home: dir, url: "http://controlled.test", apiKey: "original" };
    const payload = { session_id: "credential-bound", prompt: "private to workspace A" };
    await captureLegacyHook("UserPromptSubmit", payload, {
      ...options,
      request: async () => {
        throw new Error("offline");
      },
    });
    const sent: string[] = [];
    const request: typeof fetch = async (url) => {
      sent.push(String(url));
      return String(url).endsWith("/start")
        ? Response.json({ id: "s" }, { status: 201 })
        : new Response(null, { status: 204 });
    };
    const replacement = { ...options, apiKey: "workspace-B-key", request };
    expect(await captureLegacyHook("Stop", payload, replacement)).toMatchObject({ pending: 1 });
    expect(await drainLegacySpools(replacement)).toEqual({ delivered: 0, remaining: 1 });
    expect(sent).toEqual([]);
    expect(await drainLegacySpools({ ...options, request })).toEqual({
      delivered: 1,
      remaining: 0,
    });
  });

  it("replays after offline and lost ACK, rolls over once, and keeps identical prompts distinct", async () => {
    const dir = await home();
    const sessions = new Map<string, { id: string; status: string; generation: number }>();
    const accepted = new Set<string>();
    const turns: string[] = [];
    let offline = true,
      loseAck = true;
    const request: typeof fetch = async (input, init) => {
      if (offline) throw new Error("offline");
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.endsWith("/start")) {
        const key = `${body.sourceSessionId}:${body.sourceGeneration}`;
        const session = sessions.get(key) ?? {
          id: `segment-${sessions.size}`,
          status: "active",
          generation: body.sourceGeneration,
        };
        sessions.set(key, session);
        return Response.json({ ...session, sourceGeneration: session.generation }, { status: 201 });
      }
      const id = /session\/([^/]+)/.exec(url)![1];
      const session = [...sessions.values()].find((s) => s.id === id)!;
      if (!init?.method)
        return Response.json({ id, status: session.status, sourceGeneration: session.generation });
      if (session.status === "collapsed" && !accepted.has(body.sourceMessageId))
        return Response.json(
          { error: { details: { cause: "SESSION_TERMINAL" } } },
          { status: 409 }
        );
      if (!accepted.has(body.sourceMessageId)) {
        accepted.add(body.sourceMessageId);
        turns.push(body.sourceMessageId);
      }
      if (loseAck) {
        loseAck = false;
        throw new Error("timeout after commit");
      }
      return new Response(null, { status: 204 });
    };
    const options = { home: dir, url: "http://controlled.test", apiKey: "test", request };
    const event = { session_id: "conversation", prompt: "yes" };
    await captureLegacyHook("UserPromptSubmit", event, options);
    offline = false;
    await captureLegacyHook("Stop", { session_id: "conversation" }, options);
    await captureLegacyHook("Stop", { session_id: "conversation" }, options);
    [...sessions.values()][0].status = "collapsed";
    await Promise.all([
      captureLegacyHook("UserPromptSubmit", event, options),
      captureLegacyHook("UserPromptSubmit", event, options),
    ]);
    expect(sessions.size).toBe(2);
    expect(turns).toHaveLength(3);
    expect(new Set(turns).size).toBe(3);
    const mapping = JSON.parse(
      await readFile(join(dir, ".mnemo/sessions/conversation.json"), "utf8")
    );
    expect(mapping.mnemoSessionId).toBe("segment-1");
    await captureLegacyHook(
      "SessionStart",
      { session_id: "conversation", source: "resume" },
      options
    );
    await captureLegacyHook("PreCompact", { session_id: "conversation" }, options);
    expect(sessions.size).toBe(2);
  });

  it("retires a close request whose collapse committed but whose answer was lost", async () => {
    const dir = await home();
    const sessions: Array<{ id: string; status: string }> = [];
    const collapsed: string[] = [];
    let loseCollapseAck = true;
    const request: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/start")) {
        const body = JSON.parse(String(init!.body));
        const session = { id: `segment-${body.sourceGeneration}`, status: "active" };
        if (!sessions.some((s) => s.id === session.id)) sessions.push(session);
        return Response.json({ id: session.id }, { status: 201 });
      }
      const id = /session\/([^/]+)/.exec(url)![1];
      const session = sessions.find((s) => s.id === id)!;
      if (url.endsWith("/collapse")) {
        session.status = "collapsed";
        collapsed.push(id);
        if (loseCollapseAck) {
          loseCollapseAck = false;
          throw new Error("timeout after commit");
        }
        return Response.json({ ok: true });
      }
      if (!init?.method) return Response.json({ id, status: session.status });
      return new Response(null, { status: 204 });
    };
    const options = { home: dir, url: "http://controlled.test", apiKey: "test", request };
    await captureLegacyHook("SessionEnd", { session_id: "ended" }, options);
    expect(collapsed).toEqual(["segment-0"]);
    await captureLegacyHook("SessionStart", { session_id: "ended", source: "resume" }, options);
    await captureLegacyHook("Stop", { session_id: "ended" }, options);
    expect(collapsed).toEqual(["segment-0"]);
    expect(sessions.map((s) => s.status)).toEqual(["collapsed", "active"]);
  });

  it.each(["SessionStart", "UserPromptSubmit", "PostCompact"])(
    "retires an undelivered close intent on %s, including an offline resume",
    async (event) => {
      const dir = await home();
      let offline = false;
      const collapsed: string[] = [];
      const turns: string[] = [];
      let starts = 0;
      const request: typeof fetch = async (input, init) => {
        if (offline) throw new Error("offline");
        const url = String(input);
        if (url.endsWith("/start")) {
          starts++;
          return Response.json({ id: "active-segment" }, { status: 201 });
        }
        if (url.endsWith("/collapse")) collapsed.push(url);
        if (url.endsWith("/turn")) turns.push(JSON.parse(String(init?.body)).content);
        return Response.json({ id: "active-segment", status: "active" });
      };
      const options = { home: dir, url: "http://controlled.test", apiKey: "test", request };
      await captureLegacyHook("SessionStart", { session_id: "resuming" }, options);
      offline = true;
      await captureLegacyHook("SessionEnd", { session_id: "resuming" }, options);
      await captureLegacyHook(
        event,
        { session_id: "resuming", source: "resume", prompt: "resumed prompt" },
        options
      );
      offline = false;
      await captureLegacyHook("Stop", { session_id: "resuming" }, options);
      expect(collapsed).toEqual([]);
      expect(starts).toBe(1);
      expect(turns).toEqual(event === "UserPromptSubmit" ? ["resumed prompt"] : []);
      // The next real SessionEnd must still close the resumed generation.
      await captureLegacyHook("SessionEnd", { session_id: "resuming" }, options);
      expect(collapsed).toHaveLength(1);
    }
  );

  it("treats MNEMO_HARNESS_V1_ENABLED as a kill switch, never as consent (APP-034c)", async () => {
    const dir = await home();
    const turns: Array<{ role: string; content: string }> = [];
    const request: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/start")) return Response.json({ id: "s" }, { status: 201 });
      if (init?.body) turns.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    };
    const base = { home: dir, url: "http://controlled.test", apiKey: "test", request };
    const payload = { session_id: "c", prompt: "hello there" };
    // `false` stops a consented host.
    for (const value of ["false", "0", " FALSE "]) {
      expect(
        await captureLegacyHook("UserPromptSubmit", payload, {
          ...base,
          env: { MNEMO_HARNESS_V1_ENABLED: value },
        })
      ).toEqual({ pending: 0 });
    }
    expect(turns).toEqual([]);
    // `true` grants nothing without a marker.
    await rm(join(dir, ".mnemo/harness/capture/claude-code.json"));
    expect(
      await captureLegacyHook("UserPromptSubmit", payload, {
        ...base,
        env: { MNEMO_HARNESS_V1_ENABLED: "true" },
      })
    ).toEqual({ pending: 0 });
    expect(turns).toEqual([]);
  });

  it("reads assistant turns from transcripts under CLAUDE_CONFIG_DIR", async () => {
    const dir = await home();
    const config = join(dir, "claude-config");
    await mkdir(join(config, "projects"), { recursive: true, mode: 0o700 });
    const path = join(config, "projects/t.jsonl");
    const entry = (uuid: string, role: string, content: string) =>
      JSON.stringify({ uuid, message: { role, content } });
    await writeFile(path, entry("u", "user", "prompt") + "\n");
    const turns: string[] = [];
    const request: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/start")) return Response.json({ id: "s" }, { status: 201 });
      if (init?.body) turns.push(JSON.parse(String(init.body)).sourceMessageId);
      return new Response(null, { status: 204 });
    };
    const options = {
      home: dir,
      url: "http://controlled.test",
      apiKey: "test",
      request,
      env: { CLAUDE_CONFIG_DIR: config },
    };
    await captureLegacyHook("SessionStart", { session_id: "c", transcript_path: path }, options);
    await writeFile(
      path,
      [entry("u", "user", "prompt"), entry("r", "assistant", "answer")].join("\n") + "\n"
    );
    await captureLegacyHook("Stop", { session_id: "c", transcript_path: path }, options);
    expect(turns).toEqual(["transcript:r"]);
  });

  it("retains the spool and never starts a successor for binding or auth rejection", async () => {
    const dir = await home();
    let starts = 0;
    const request: typeof fetch = async (input) => {
      if (String(input).endsWith("/start")) {
        starts++;
        return Response.json({ id: "s", sourceGeneration: 0 }, { status: 201 });
      }
      return Response.json(
        { error: { details: { cause: "SESSION_BINDING_MISMATCH" } } },
        { status: 409 }
      );
    };
    const result = await captureLegacyHook(
      "UserPromptSubmit",
      { session_id: "c", prompt: "text" },
      { home: dir, url: "http://controlled.test", apiKey: "test", request }
    );
    expect(starts).toBe(1);
    expect(result.pending).toBe(1);
  });
  it("reconciles more than 20 assistant entries without clipping, tools or duplicate posts", async () => {
    const dir = await home();
    await mkdir(join(dir, ".claude/projects"), { recursive: true, mode: 0o700 });
    const path = join(dir, ".claude/projects/transcript.jsonl");
    const entry = (uuid: string, role: string, content: unknown) =>
      JSON.stringify({ uuid, message: { role, content } });
    const historical = [
      entry("history-user", "user", "old"),
      entry("history-assistant", "assistant", "before consent"),
    ];
    await writeFile(path, historical.join("\n") + "\n");
    const accepted: Array<{ sourceMessageId: string; role: string; content: string }> = [];
    const request: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/start"))
        return Response.json({ id: "s", sourceGeneration: 0 }, { status: 201 });
      if (!init?.method) return Response.json({ id: "s", status: "active" });
      accepted.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    };
    const options = { home: dir, url: "http://controlled.test", apiKey: "fixture", request };
    await captureLegacyHook("SessionStart", { session_id: "c", transcript_path: path }, options);
    expect(accepted).toEqual([]);
    const assistants = Array.from({ length: 25 }, (_, i) =>
      entry(`reply-${i}`, "assistant", [
        { type: "thinking", text: "PRIVATE THOUGHT" },
        { type: "tool_use", text: "PRIVATE TOOL" },
        {
          type: "text",
          text: i === 0 ? "a".repeat(14000) + " api_key=secret-value" : `reply ${i}`,
        },
      ])
    );
    await writeFile(
      path,
      [...historical, entry("current-user", "user", "prompt"), ...assistants].join("\n") + "\n"
    );
    await captureLegacyHook("Stop", { session_id: "c", transcript_path: path }, options);
    await captureLegacyHook("PreCompact", { session_id: "c", transcript_path: path }, options);
    expect(accepted).toHaveLength(25);
    expect(accepted.map((t) => t.sourceMessageId)).toEqual(
      assistants.map((_, i) => `transcript:reply-${i}`)
    );
    expect(accepted[0].content.length).toBeGreaterThan(14000);
    expect(JSON.stringify(accepted)).not.toMatch(/PRIVATE|secret-value|before consent/);
    expect(accepted[0].content).toContain("[REDACTED]");
  });

  it("rejects unsafe transcript paths and malformed or managed consent before capturing", async () => {
    const dir = await home();
    await mkdir(join(dir, ".claude"), { mode: 0o700 });
    const path = join(dir, ".claude/link.jsonl");
    const external = join(dir, "outside.jsonl");
    await writeFile(
      external,
      JSON.stringify({
        uuid: "secret",
        message: { role: "assistant", content: "must not upload" },
      }) + "\n"
    );
    await symlink(external, path);
    const turns: string[] = [];
    const request: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/start")) return Response.json({ id: "s" }, { status: 201 });
      if (init?.body) turns.push(String(init.body));
      return new Response(null, { status: 204 });
    };
    const options = {
      home: dir,
      url: "http://controlled.test",
      apiKey: "fixture",
      request,
      env: {},
    };
    await captureLegacyHook("Stop", { session_id: "c", transcript_path: path }, options);
    await captureLegacyHook("Stop", { session_id: "c", transcript_path: external }, options);
    expect(turns).toEqual([]);
    for (const marker of [
      {},
      { version: 1, host: "claude-code", mode: "full", writer: "managed" },
    ]) {
      await writeFile(
        join(dir, ".mnemo/harness/capture/claude-code.json"),
        JSON.stringify(marker),
        { mode: 0o600 }
      );
      expect(
        await captureLegacyHook("UserPromptSubmit", { session_id: "c", prompt: "hello" }, options)
      ).toEqual({ pending: 0 });
    }
    expect(turns).toEqual([]);
  });

  it("captures where the optional native fs-ext module cannot be loaded (bundled CLI)", async () => {
    const dir = await home();
    const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
    const original = loader._load;
    loader._load = function (request: string, ...rest: unknown[]) {
      if (request === "fs-ext")
        throw Object.assign(new Error("Cannot find module 'fs-ext'"), { code: "MODULE_NOT_FOUND" });
      return original.call(this, request, ...rest);
    };
    try {
      expect(() => createRequire(import.meta.url)("fs-ext")).toThrow(/fs-ext/);
      // A holder that died with the lock held must not wedge capture forever.
      const { createHash } = await import("node:crypto");
      const key = createHash("sha256")
        .update(JSON.stringify(["http://controlled.test", "", "nolib"]))
        .digest("hex");
      await mkdir(join(dir, ".mnemo/harness/locks"), { recursive: true, mode: 0o700 });
      await writeFile(
        join(dir, `.mnemo/harness/locks/legacy-${key}.excl`),
        JSON.stringify({ pid: 2 ** 22 + 12345, token: "dead", acquiredAt: Date.now() }), // determinism-ok: fresh lock, recovered by dead pid
        { mode: 0o600 }
      );
      const turns: string[] = [];
      const request: typeof fetch = async (url, init) => {
        if (String(url).endsWith("/start")) return Response.json({ id: "s" }, { status: 201 });
        if (init?.body) turns.push(JSON.parse(String(init.body)).content);
        return new Response(null, { status: 204 });
      };
      const options = { home: dir, url: "http://controlled.test", apiKey: "test", request };
      const results = await Promise.all([
        captureLegacyHook("UserPromptSubmit", { session_id: "nolib", prompt: "one" }, options),
        captureLegacyHook("UserPromptSubmit", { session_id: "nolib", prompt: "two" }, options),
      ]);
      expect(results.map((r) => r.pending)).toEqual([0, 0]);
      expect(turns.sort()).toEqual(["one", "two"]);
      const paths = await ensureSecureHarnessPaths({ home: dir });
      await withAdvisoryLock(paths, "runtime-managed", () =>
        enqueueVisibleMessage(
          {
            host: "claude-code",
            hostSessionId: "managed",
            clientInstanceId: "client",
            sourceGeneration: 0,
            hostMessageId: "message",
            role: "user",
            content: "managed prompt",
          },
          { home: dir }
        )
      );
      expect(await readPendingEvents({ home: dir })).toHaveLength(1);
    } finally {
      loader._load = original;
    }
  });
});
