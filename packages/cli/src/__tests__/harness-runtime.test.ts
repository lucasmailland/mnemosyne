import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  captureHostHook,
  captureLegacyHook,
  computeCaptureArtifactHash,
  readCaptureConsent,
  readPendingEvents,
  readSessionState,
  resolveBinding,
  writeCaptureConsent,
} from "@mnemo-ai/harness";
import {
  computeTerminalDigestV1,
  type HarnessBatchV1,
  type HarnessEvent,
  type HarnessEventAck,
} from "@mnemo-ai/types";
import { harnessDeps, harnessLifecycleDeps } from "../commands.js";

const CLI_ENTRYPOINT = resolve(import.meta.dirname, "../../dist/index.js");
const PLUGIN_DIR = resolve(import.meta.dirname, "../../../plugin");

/** The digest a consent written by `mnemo capture` for this build records. */
function currentPackageHash(): string {
  const result = computeCaptureArtifactHash({ host: "claude-code", artifactRoot: PLUGIN_DIR });
  if ("error" in result) throw new Error(result.error);
  return result.hash;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const REBUILD = "run `pnpm --filter @mnemo-ai/cli build` (it copies the harness build in)";

/**
 * These tests drive the harness two ways at once: in process, through
 * `@mnemo-ai/harness` (packages/harness/dist), and through the spawned CLI, which
 * runs the copy in its own dist/harness. When the two builds differ, the two
 * halves disagree and every test fails somewhere unrelated — so say so up front.
 */
function assertCliBundlesHarness(cliRoot: string, harnessRoot: string): void {
  const bundled = join(cliRoot, "dist", "harness", "dist", "index.js");
  const built = join(harnessRoot, "dist", "index.js");
  for (const file of [join(cliRoot, "dist", "index.js"), bundled, built])
    if (!existsSync(file)) throw new Error(`${file} is missing: ${REBUILD}.`);
  const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const [inCli, inHarness] = [digest(bundled), digest(built)];
  if (inCli !== inHarness)
    throw new Error(
      `packages/cli/dist bundles a different @mnemo-ai/harness build than packages/harness/dist ` +
        `(sha256 ${inCli.slice(0, 12)} vs ${inHarness.slice(0, 12)}), so the spawned CLI and the ` +
        `in-process harness would disagree: ${REBUILD}.`
    );
}

interface MockServerState {
  server: Server;
  url: string;
  batches: HarnessBatchV1[];
  /** Authorization header of every events request, aligned with `batches`. */
  authorizations: string[];
  /** Record the batch, then drop the connection before any response. */
  dropResponse: boolean;
  probes: Array<Record<string, unknown>>;
  quiesces: Array<Record<string, unknown>>;
  /** Turns the legacy writer delivered through `/session/:id/turn`. */
  legacyTurns: Array<Record<string, unknown>>;
  statusOverride?: number;
  probeAvailable: boolean;
  probeCode?: string;
  quiesced: boolean;
  responseOverride?: (batch: HarnessBatchV1) => {
    protocolVersion: 1;
    workspaceId: string;
    acknowledgements: HarnessEventAck[];
  };
  close: () => Promise<void>;
  /** Take the server fully offline (connection refused) on the same port. */
  stop: () => Promise<void>;
  restart: () => Promise<void>;
}

async function startMockHarnessServer(workspaceId: string): Promise<MockServerState> {
  const batches: HarnessBatchV1[] = [];
  const authorizations: string[] = [];
  const probes: Array<Record<string, unknown>> = [];
  const quiesces: Array<Record<string, unknown>> = [];
  const legacyTurns: Array<Record<string, unknown>> = [];
  const state: {
    statusOverride?: number;
    probeAvailable: boolean;
    probeCode?: string;
    quiesced: boolean;
    dropResponse: boolean;
    responseOverride?: (batch: HarnessBatchV1) => {
      protocolVersion: 1;
      workspaceId: string;
      acknowledgements: HarnessEventAck[];
    };
  } = {
    probeAvailable: true,
    quiesced: false,
    dropResponse: false,
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.method === "POST" && req.url === "/harness/v1/probe") {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        probes.push(parsed);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            protocolVersion: 1,
            workspaceId,
            available: state.quiesced ? false : state.probeAvailable,
            ...(state.quiesced
              ? { code: "harness_workspace_quiesced" }
              : state.probeCode
                ? { code: state.probeCode }
                : {}),
          })
        );
        return;
      }
      if (req.method === "POST" && req.url === "/session/start") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "00000000-0000-4000-8000-0000000000aa" }));
        return;
      }
      if (req.method === "POST" && /^\/session\/[^/]+\/turn$/.test(req.url ?? "")) {
        legacyTurns.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/admin/harness/quiesce") {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        quiesces.push(parsed);
        state.quiesced = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            workspaceId,
            ingestionEnabled: false,
            quiesced: true,
            pendingCount: 0,
            liveLeaseCount: 0,
            inFlightCount: 0,
          })
        );
        return;
      }
      if (req.method === "POST" && req.url === "/harness/v1/events") {
        if (state.statusOverride && state.statusOverride !== 200) {
          res.writeHead(state.statusOverride, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `HTTP ${state.statusOverride}` }));
          return;
        }
        const parsed = JSON.parse(raw) as HarnessBatchV1;
        batches.push(parsed);
        authorizations.push(String(req.headers.authorization ?? ""));
        if (state.dropResponse) {
          // The server committed the batch; the client never hears about it.
          req.socket.destroy();
          return;
        }
        if (state.responseOverride) {
          const custom = state.responseOverride(parsed);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(custom));
          return;
        }
        const acknowledgements: HarnessEventAck[] = parsed.events.map((ev) => ({
          eventId: ev.eventId,
          status: "accepted",
          retryable: false,
          sessionId: "00000000-0000-4000-8000-000000000999",
          effectiveGeneration:
            "sourceGeneration" in ev && typeof ev.sourceGeneration === "number"
              ? ev.sourceGeneration
              : "requestedGeneration" in ev
                ? (ev.requestedGeneration ?? 0)
                : 0,
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            protocolVersion: 1,
            workspaceId,
            acknowledgements,
          })
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    server,
    url: `http://127.0.0.1:${port}`,
    batches,
    authorizations,
    probes,
    quiesces,
    legacyTurns,
    get dropResponse() {
      return state.dropResponse;
    },
    set dropResponse(val: boolean) {
      state.dropResponse = val;
    },
    get statusOverride() {
      return state.statusOverride;
    },
    set statusOverride(val: number | undefined) {
      state.statusOverride = val;
    },
    get probeAvailable() {
      return state.probeAvailable;
    },
    set probeAvailable(val: boolean) {
      state.probeAvailable = val;
    },
    get probeCode() {
      return state.probeCode;
    },
    set probeCode(val: string | undefined) {
      state.probeCode = val;
    },
    get quiesced() {
      return state.quiesced;
    },
    set quiesced(val: boolean) {
      state.quiesced = val;
    },
    get responseOverride() {
      return state.responseOverride;
    },
    set responseOverride(
      val:
        | ((batch: HarnessBatchV1) => {
            protocolVersion: 1;
            workspaceId: string;
            acknowledgements: HarnessEventAck[];
          })
        | undefined
    ) {
      state.responseOverride = val;
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        if (!server.listening) return resolveClose();
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
    stop: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
    restart: () =>
      new Promise<void>((resolveListen) => {
        server.listen(port, "127.0.0.1", () => resolveListen());
      }),
  };
}

describe("the stale-bundle guard", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function packages(bundled: string | null, built: string): { cli: string; harness: string } {
    const root = mkdtempSync(join(tmpdir(), "mnemo-stale-bundle-"));
    roots.push(root);
    const cli = join(root, "cli");
    const harness = join(root, "harness");
    mkdirSync(join(cli, "dist", "harness", "dist"), { recursive: true });
    mkdirSync(join(harness, "dist"), { recursive: true });
    writeFileSync(join(cli, "dist", "index.js"), "");
    if (bundled !== null) writeFileSync(join(cli, "dist", "harness", "dist", "index.js"), bundled);
    writeFileSync(join(harness, "dist", "index.js"), built);
    return { cli, harness };
  }

  it("passes when the CLI bundles the harness build byte for byte", () => {
    const { cli, harness } = packages("export const v = 1;", "export const v = 1;");
    expect(() => assertCliBundlesHarness(cli, harness)).not.toThrow();
  });

  it("names the rebuild when the CLI bundles an older harness", () => {
    const { cli, harness } = packages("export const v = 1;", "export const v = 2;");
    expect(() => assertCliBundlesHarness(cli, harness)).toThrow(
      /bundles a different @mnemo-ai\/harness build.*pnpm --filter @mnemo-ai\/cli build/s
    );
  });

  it("names the build when the CLI has no bundle at all", () => {
    const { cli, harness } = packages(null, "export const v = 2;");
    expect(() => assertCliBundlesHarness(cli, harness)).toThrow(
      /is missing.*pnpm --filter @mnemo-ai\/cli build/s
    );
  });
});

describe("CLI harness runtime integration (P137)", () => {
  let tempRoot: string;
  let homeDir: string;
  let workspaceDir: string;
  let claudeDir: string;
  let mockServer: MockServerState;
  const workspaceId = "00000000-0000-4000-8000-000000000123";
  const apiKey = "mns_test_token_12345678901234567890";

  beforeAll(() =>
    assertCliBundlesHarness(resolve(CLI_ENTRYPOINT, "../.."), resolve(PLUGIN_DIR, "../harness"))
  );

  beforeEach(async () => {
    // The harness refuses state whose ancestors are not owned by the user;
    // vitest.config.ts points tmpdir() at the private per-user temp dir.
    tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "mnemo-cli-harness-runtime-")));
    chmodSync(tempRoot, 0o700);
    homeDir = join(tempRoot, "home");
    workspaceDir = join(tempRoot, "workspace");
    claudeDir = join(homeDir, ".claude");
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(claudeDir, "projects", "proj-1"), { recursive: true, mode: 0o700 });

    mockServer = await startMockHarnessServer(workspaceId);

    const mnemoDir = join(homeDir, ".mnemo");
    mkdirSync(mnemoDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(mnemoDir, "config.json"),
      JSON.stringify({
        url: mockServer.url,
        apiKey,
        workspaceId,
      }),
      { mode: 0o600 }
    );

    await resolveBinding(
      {
        serverUrl: mockServer.url,
        workspaceId,
        apiKey,
      },
      { home: homeDir }
    );
    await writeCaptureConsent(
      {
        host: "claude-code",
        mode: "full",
        consentedAt: "2026-04-01T00:00:00.000Z",
        hostVersion: "1.0.88",
        packageHash: currentPackageHash(),
        writer: "managed",
      },
      { home: homeDir }
    );
  });

  afterEach(async () => {
    try {
      await mockServer.close();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  function runCliHook(
    event: string,
    payload: Record<string, unknown>,
    env: Record<string, string> = {}
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return runCli(["harness", "hook", "claude-code", event], JSON.stringify(payload), env);
  }

  it.each(["flag", "project"])(
    "honours %s workspace selection when quiescing",
    async (selection) => {
      const otherWorkspace = "00000000-0000-4000-8000-000000000456";
      if (selection === "project")
        writeFileSync(
          join(workspaceDir, ".mnemo.json"),
          JSON.stringify({ workspaceId: otherWorkspace })
        );
      const args = selection === "flag" ? ["--workspace", otherWorkspace] : [];
      const result = await runCli([...args, "harness", "quiesce", "--yes"], "");
      expect(result.status).not.toBe(0);
      expect(mockServer.quiesces).toHaveLength(0);
      expect(mockServer.quiesced).toBe(false);
    },
    // Spawns the built CLI, like every other test here that has its own budget.
    15_000
  );

  function runCli(
    args: string[],
    stdin: string,
    env: Record<string, string> = {}
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [CLI_ENTRYPOINT, ...args], {
        cwd: workspaceDir,
        env: {
          ...process.env,
          HOME: homeDir,
          CLAUDE_CONFIG_DIR: claudeDir,
          MNEMO_URL: mockServer.url,
          MNEMO_KEY: apiKey,
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", rejectRun);
      child.once("close", (status) => {
        resolveRun({ status, stdout, stderr });
      });
      child.stdin.end(stdin);
    });
  }

  function allDeliveredEvents(): HarnessEvent[] {
    return mockServer.batches.flatMap((b) => b.events);
  }

  it("closes the effective successor generation after an inactivity redirect", async () => {
    const transcriptPath = join(claudeDir, "projects", "proj-1", "redirect.jsonl");
    writeFileSync(transcriptPath, "", { mode: 0o600 });
    let redirected = false;
    mockServer.responseOverride = (batch) => ({
      protocolVersion: 1,
      workspaceId,
      acknowledgements: batch.events.map((event) => ({
        eventId: event.eventId,
        status: "accepted",
        retryable: false,
        sessionId: "00000000-0000-4000-8000-000000000999",
        effectiveGeneration: redirected ? 1 : 0,
      })),
    });
    const hook = (event: string, prompt?: string) =>
      captureHostHook({
        host: "claude-code",
        event,
        home: homeDir,
        cwd: workspaceDir,
        claudeConfigDir: claudeDir,
        serverUrl: mockServer.url,
        apiKey,
        workspaceId,
        artifactRoot: PLUGIN_DIR,
        liveGateMode: "full",
        rawPayload: JSON.stringify({
          session_id: "redirect",
          transcript_path: transcriptPath,
          prompt,
        }),
      });
    const line = (uuid: string, content: string) =>
      JSON.stringify({
        uuid,
        timestamp: "2026-04-02T00:00:00.000Z",
        message: { role: "user", content },
      }) + "\n";
    await hook("SessionStart");
    await hook("UserPromptSubmit", "earlier prompt");
    writeFileSync(transcriptPath, line("u1", "earlier prompt"));
    await hook("Stop");
    redirected = true;
    await hook("UserPromptSubmit", "successor prompt");
    writeFileSync(transcriptPath, line("u1", "earlier prompt") + line("u2", "successor prompt"));
    await hook("SessionEnd");
    const appends = allDeliveredEvents().filter((e) => e.type === "turn.append");
    expect(appends).toHaveLength(2);
    const successor = appends.find((e) => e.content === "successor prompt")!;
    const end = allDeliveredEvents().find((e) => e.type === "session.end")!;
    expect(end).toMatchObject({
      sourceGeneration: 1,
      finalMessageSetDigest: computeTerminalDigestV1([
        {
          type: "M",
          hostMessageId: successor.hostMessageId,
          role: successor.role,
          contentHash: successor.contentHash,
        },
      ]),
    });
    // Five real hook captures, each fsyncing its outbox, state and lock files 35-55
    // times: ~2.5 s idle, 5.3 s under load against the default 5 s (APP-045). That
    // durability work is what is under test, so it gets a budget, not a stub.
  }, 15_000);

  it("captures SessionStart, UserPromptSubmit, Stop, PreCompact, and SessionEnd end-to-end without duplicating user prompts or retracting compacted turns", async () => {
    const transcriptPath = join(claudeDir, "projects", "proj-1", "sess-1.jsonl");
    writeFileSync(transcriptPath, "", { mode: 0o600 });

    // 1. SessionStart
    const startRes = await runCliHook("SessionStart", {
      session_id: "sess-1",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
    });
    expect(startRes.status).toBe(0);
    expect(allDeliveredEvents().map((e) => e.type)).toEqual(["session.start"]);

    // 2. UserPromptSubmit (turn 1) + duplicate hook redelivery before Stop
    const prompt1 = "How does workspace RLS work in Mnemosyne?";
    const ups1 = await runCliHook("UserPromptSubmit", {
      session_id: "sess-1",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
      prompt: prompt1,
    });
    expect(ups1.status).toBe(0);

    // Duplicate redelivery of the same open prompt should be a no-op
    const ups1Dup = await runCliHook("UserPromptSubmit", {
      session_id: "sess-1",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
      prompt: prompt1,
    });
    expect(ups1Dup.status).toBe(0);

    const userAppendsAfterUps = allDeliveredEvents().filter(
      (e): e is Extract<HarnessEvent, { type: "turn.append" }> =>
        e.type === "turn.append" && e.role === "user"
    );
    expect(userAppendsAfterUps).toHaveLength(1);
    expect(userAppendsAfterUps[0]?.content).toBe(prompt1);

    // 3. Stop (transcript now has user u1 + assistant thinking/tool_use + visible text a1)
    const transcriptTurn1 = [
      JSON.stringify({
        type: "user",
        uuid: "u-uuid-1",
        timestamp: "2026-04-02T00:00:01.000Z",
        message: { role: "user", content: prompt1 },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a-uuid-tool",
        timestamp: "2026-04-02T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a-uuid-1",
        timestamp: "2026-04-02T00:00:03.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal reasoning not for capture" },
            { type: "text", text: "Every mnemo_* table enforces FORCE ROW LEVEL SECURITY." },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(transcriptPath, `${transcriptTurn1}\n`, { mode: 0o600 });

    const stop1 = await runCliHook("Stop", {
      session_id: "sess-1",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
    });
    expect(stop1.status).toBe(0);

    const appendsAfterStop1 = allDeliveredEvents().filter(
      (e): e is Extract<HarnessEvent, { type: "turn.append" }> => e.type === "turn.append"
    );
    // Exactly 1 user turn (not duplicated by transcript UUID) and 1 assistant turn
    expect(appendsAfterStop1).toHaveLength(2);
    expect(appendsAfterStop1[0]?.role).toBe("user");
    expect(appendsAfterStop1[1]?.role).toBe("assistant");
    expect(appendsAfterStop1[1]?.content).toBe(
      "Every mnemo_* table enforces FORCE ROW LEVEL SECURITY."
    );
    // Session-continuity's origin travels on every append.
    expect(appendsAfterStop1.map((a) => [a.turnOrigin, a.turnOriginEvidence])).toEqual([
      ["unknown", "unclassified"],
      ["assistant", "role:assistant"],
    ]);

    // Claude Code may redeliver Stop. Replaying it against the same transcript is
    // a no-op: nothing new is appended, nothing is retracted.
    const eventsBeforeReplay = allDeliveredEvents().length;
    const stop1Replay = await runCliHook("Stop", {
      session_id: "sess-1",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
    });
    expect(stop1Replay.status).toBe(0);
    expect(allDeliveredEvents().length).toBe(eventsBeforeReplay);

    // 4. PreCompact seals current liveSet before host compacts the transcript
    const preCompact = await runCliHook("PreCompact", {
      session_id: "sess-1",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
    });
    expect(preCompact.status).toBe(0);

    // 5. After compaction, transcript only has a new turn (u-uuid-2 + a-uuid-2),
    // and user repeats the exact same question text in turn 2 (occurrenceIndex = 1)
    const ups2 = await runCliHook("UserPromptSubmit", {
      session_id: "sess-1",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
      prompt: prompt1,
    });
    expect(ups2.status).toBe(0);

    const compactedTranscript = [
      JSON.stringify({
        type: "user",
        uuid: "u-uuid-2",
        timestamp: "2026-04-02T00:01:01.000Z",
        message: { role: "user", content: prompt1 },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a-uuid-2",
        timestamp: "2026-04-02T00:01:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Second answer after compaction." }],
        },
      }),
    ].join("\n");
    writeFileSync(transcriptPath, `${compactedTranscript}\n`, { mode: 0o600 });

    const stop2 = await runCliHook("Stop", {
      session_id: "sess-1",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
    });
    expect(stop2.status).toBe(0);

    // Neither compacted turn 1 user nor assistant was retracted!
    const retractions = allDeliveredEvents().filter((e) => e.type === "turn.retract");
    expect(retractions).toHaveLength(0);

    // And the repeated prompt got a distinct hostMessageId
    const allAppends = allDeliveredEvents().filter(
      (e): e is Extract<HarnessEvent, { type: "turn.append" }> => e.type === "turn.append"
    );
    expect(allAppends).toHaveLength(4);
    expect(allAppends[0]?.hostMessageId).not.toBe(allAppends[2]?.hostMessageId);

    // 6. SessionEnd emits session.end with terminal digest covering all 4 live messages
    const endRes = await runCliHook("SessionEnd", {
      session_id: "sess-1",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
    });
    expect(endRes.status).toBe(0);
    const endEvents = allDeliveredEvents().filter(
      (e): e is Extract<HarnessEvent, { type: "session.end" }> => e.type === "session.end"
    );
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0]?.sourceGeneration).toBe(0);

    // 7. Resuming the session after SessionEnd opens generation 1
    const resumeRes = await runCliHook("SessionStart", {
      session_id: "sess-1",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
    });
    expect(resumeRes.status).toBe(0);
    const upsResume = await runCliHook("UserPromptSubmit", {
      session_id: "sess-1",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
      prompt: "Follow-up after resume",
    });
    expect(upsResume.status).toBe(0);
    const gen1Appends = allDeliveredEvents().filter(
      (e): e is Extract<HarnessEvent, { type: "turn.append" }> =>
        e.type === "turn.append" && e.sourceGeneration === 1
    );
    expect(gen1Appends).toHaveLength(1);
    expect(gen1Appends[0]?.content).toBe("Follow-up after resume");
  }, 60_000); // real spawns and fsyncs; 20 s was exceeded under a full parallel sweep

  it("never retroactively captures pre-consent transcript entries and rejects unsafe transcript paths", async () => {
    const transcriptPath = join(claudeDir, "projects", "proj-1", "sess-consent.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "user",
          uuid: "pre-u1",
          timestamp: "2026-03-31T23:50:00.000Z",
          message: { role: "user", content: "Private pre-consent prompt" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "pre-a1",
          timestamp: "2026-03-31T23:50:05.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Private pre-consent reply" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "post-a1",
          timestamp: "2026-04-02T00:00:05.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Post-consent visible reply" }],
          },
        }),
      ].join("\n") + "\n",
      { mode: 0o600 }
    );

    await runCliHook("SessionStart", {
      session_id: "sess-consent",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
    });
    await runCliHook("Stop", {
      session_id: "sess-consent",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
    });

    const appends = allDeliveredEvents().filter(
      (e): e is Extract<HarnessEvent, { type: "turn.append" }> => e.type === "turn.append"
    );
    expect(appends.map((a) => a.content)).toEqual(["Post-consent visible reply"]);

    // Unsafe transcript paths (outside claudeDir or symlinked) are rejected without failing the hook
    const outsidePath = join(tempRoot, "outside.jsonl");
    writeFileSync(
      outsidePath,
      JSON.stringify({
        type: "assistant",
        uuid: "outside-a1",
        message: { role: "assistant", content: [{ type: "text", text: "outside secret" }] },
      }) + "\n",
      { mode: 0o600 }
    );
    const symlinkPath = join(claudeDir, "projects", "proj-1", "symlink.jsonl");
    symlinkSync(outsidePath, symlinkPath);

    const beforeCount = allDeliveredEvents().length;
    expect(
      (
        await runCliHook("Stop", {
          session_id: "sess-consent",
          transcript_path: outsidePath,
          cwd: workspaceDir,
        })
      ).status
    ).toBe(0);
    expect(
      (
        await runCliHook("Stop", {
          session_id: "sess-consent",
          transcript_path: symlinkPath,
          cwd: workspaceDir,
        })
      ).status
    ).toBe(0);
    expect(allDeliveredEvents().length).toBe(beforeCount);
  }, 15_000);

  it("fragments >64 KiB UTF-8 assistant turns and delivers 22 assistant turns without truncation", async () => {
    const transcriptPath = join(claudeDir, "projects", "proj-1", "sess-large.jsonl");
    const largeAssistantReply = `START-${"🌅".repeat(18_000)}-END`; // >72 KiB UTF-8
    expect(Buffer.byteLength(largeAssistantReply, "utf8")).toBeGreaterThan(65_536);

    const lines: string[] = [
      JSON.stringify({
        type: "assistant",
        uuid: "large-a0",
        timestamp: "2026-04-02T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: largeAssistantReply }] },
      }),
    ];
    for (let i = 1; i <= 21; i += 1) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          uuid: `turn-a${i}`,
          timestamp: `2026-04-02T00:00:${String(i + 1).padStart(2, "0")}.000Z`,
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Assistant response number ${i}` }],
          },
        })
      );
    }
    writeFileSync(transcriptPath, `${lines.join("\n")}\n`, { mode: 0o600 });

    await runCliHook("SessionStart", {
      session_id: "sess-large",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
    });
    const stopRes = await runCliHook("Stop", {
      session_id: "sess-large",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
    });
    expect(stopRes.status).toBe(0);

    const appends = allDeliveredEvents().filter(
      (e): e is Extract<HarnessEvent, { type: "turn.append" }> => e.type === "turn.append"
    );
    const largeChunks = appends.filter((a) => a.hostMessageId === "large-a0");
    expect(largeChunks.length).toBe(2);
    expect(largeChunks[0]?.chunk).toEqual({
      version: 1,
      chunkIndex: 0,
      chunkCount: 2,
      messageContentHash: sha256Hex(largeAssistantReply),
    });
    expect(largeChunks[1]?.chunk).toEqual({
      version: 1,
      chunkIndex: 1,
      chunkCount: 2,
      messageContentHash: sha256Hex(largeAssistantReply),
    });
    expect(largeChunks.map((c) => c.content).join("")).toBe(largeAssistantReply);
    // Byte-for-byte: no fragment boundary splits a UTF-8 sequence.
    expect(
      Buffer.concat(largeChunks.map((c) => Buffer.from(c.content, "utf8"))).equals(
        Buffer.from(largeAssistantReply, "utf8")
      )
    ).toBe(true);
    for (const c of largeChunks) {
      expect(Buffer.byteLength(c.content, "utf8")).toBeLessThanOrEqual(65_536);
      expect(c.contentHash).toBe(sha256Hex(c.content));
      // Every fragment carries the message's origin, not just the first.
      expect(c.turnOrigin).toBe("assistant");
      expect(c.turnOriginEvidence).toBe("role:assistant");
    }

    const otherTurns = appends.filter((a) => a.hostMessageId !== "large-a0");
    expect(otherTurns).toHaveLength(21);
    expect(otherTurns.map((a) => a.content)).toEqual(
      Array.from({ length: 21 }, (_, i) => `Assistant response number ${i + 1}`)
    );
    expect(otherTurns.every((a) => a.turnOrigin === "assistant")).toBe(true);
    expect(await readPendingEvents({ home: homeDir })).toHaveLength(0);
  }, 60_000); // real spawns and fsyncs; 15 s was exceeded under a full parallel sweep

  it("leaves capture to the legacy writer unless the consent marker selects the managed one", async () => {
    await writeCaptureConsent(
      {
        host: "claude-code",
        mode: "full",
        consentedAt: "2026-04-01T00:00:00.000Z",
        hostVersion: "1.0.88",
        packageHash: currentPackageHash(),
      },
      { home: homeDir }
    );
    const transcriptPath = join(claudeDir, "projects", "proj-1", "sess-legacy.jsonl");
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "assistant",
        uuid: "legacy-a1",
        timestamp: "2026-04-02T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "legacy owns this" }] },
      })}\n`,
      { mode: 0o600 }
    );
    for (const [event, extra] of [
      ["SessionStart", {}],
      ["UserPromptSubmit", { prompt: "captured by exactly one writer" }],
      ["Stop", {}],
      ["SessionEnd", {}],
    ] as const) {
      const res = await runCliHook(event, {
        session_id: "sess-legacy",
        transcript_path: transcriptPath,
        cwd: workspaceDir,
        ...extra,
      });
      expect(res.status).toBe(0);
    }
    expect(mockServer.batches).toHaveLength(0);
    expect(await readPendingEvents({ home: homeDir })).toHaveLength(0);
  }, 15_000);

  it("survives a lost ACK, an offline restart, a credential rotation and a retried close without loss or duplication", async () => {
    const transcriptPath = join(claudeDir, "projects", "proj-1", "sess-crash.jsonl");
    writeFileSync(transcriptPath, "", { mode: 0o600 });
    const hook = (event: string, extra: Record<string, unknown> = {}, env = {}) =>
      runCliHook(
        event,
        { session_id: "sess-crash", transcript_path: transcriptPath, cwd: workspaceDir, ...extra },
        env
      );

    // 1. The server commits the batch, then the connection dies before the ACK.
    mockServer.dropResponse = true;
    expect((await hook("SessionStart")).status).toBe(0);
    expect(mockServer.batches).toHaveLength(1);
    const firstAttempt = mockServer.batches[0]!.events;
    expect(firstAttempt.map((e) => e.type)).toEqual(["session.start"]);
    // Durable before delivery, still durable after the lost ACK.
    const afterCrash = await readPendingEvents({ home: homeDir });
    expect(afterCrash.map((p) => p.event.eventId)).toEqual([firstAttempt[0]!.eventId]);
    mockServer.dropResponse = false;

    // 2. The server goes away entirely; each hook is a fresh process.
    await mockServer.stop();
    expect((await hook("UserPromptSubmit", { prompt: "Asked while offline" })).status).toBe(0);
    // Claude Code records the prompt in the transcript under its own uuid.
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "user",
        uuid: "crash-u1",
        timestamp: "2026-04-02T00:00:01.000Z",
        message: { role: "user", content: "Asked while offline" },
      })}\n`,
      { mode: 0o600 }
    );

    // 3. The API key is rotated while events are queued.
    const rotatedKey = "mns_test_token_rotated_9876543210abcdef";
    writeFileSync(
      join(homeDir, ".mnemo", "config.json"),
      JSON.stringify({ url: mockServer.url, apiKey: rotatedKey, workspaceId }),
      { mode: 0o600 }
    );
    const rotatedEnv = { MNEMO_KEY: rotatedKey };

    // 4. SessionEnd while offline, then retried by the host.
    expect((await hook("SessionEnd", {}, rotatedEnv)).status).toBe(0);
    expect((await hook("SessionEnd", {}, rotatedEnv)).status).toBe(0);
    const queued = await readPendingEvents({ home: homeDir });
    expect(queued.map((p) => p.event.type)).toEqual([
      "session.start",
      "turn.append",
      "session.end",
    ]);

    // 5. Restart and drain through the real CLI entry point.
    await mockServer.restart();
    const drain = await runCli(["harness", "drain"], "", rotatedEnv);
    expect(drain.status).toBe(0);
    expect(await readPendingEvents({ home: homeDir })).toHaveLength(0);

    const redelivered = mockServer.batches.slice(1).flatMap((b) => b.events);
    expect(redelivered.map((e) => e.type)).toEqual(["session.start", "turn.append", "session.end"]);
    // The lost-ACK event is replayed with the same identity, so the server dedupes it.
    expect(redelivered[0]?.eventId).toBe(firstAttempt[0]!.eventId);
    expect(redelivered[0]?.payloadHash).toBe(firstAttempt[0]!.payloadHash);
    // One close, delivered once; one prompt, not duplicated.
    expect(new Set(redelivered.map((e) => e.eventId)).size).toBe(redelivered.length);
    expect(
      redelivered
        .filter(
          (e): e is Extract<HarnessEvent, { type: "turn.append" }> => e.type === "turn.append"
        )
        .map((e) => e.content)
    ).toEqual(["Asked while offline"]);
    // Rotation changes the credential, not the destination or the session identity.
    expect(mockServer.authorizations.slice(1).every((h) => h === `Bearer ${rotatedKey}`)).toBe(
      true
    );
    expect(
      new Set(mockServer.batches.flatMap((b) => b.events).map((e) => e.clientInstanceId)).size
    ).toBe(1);
  }, 30_000);

  it("wires probe, queue list, retry, discard, disable, drain, quiesce, and uninstall to real state", async () => {
    const prevHome = process.env.HOME;
    const prevUrl = process.env.MNEMO_URL;
    const prevKey = process.env.MNEMO_KEY;
    process.env.HOME = homeDir;
    process.env.MNEMO_URL = mockServer.url;
    process.env.MNEMO_KEY = apiKey;

    try {
      const deps = await harnessDeps({ url: mockServer.url, apiKey, workspaceId });
      const lifeDeps = await harnessLifecycleDeps({ url: mockServer.url, apiKey, workspaceId });

      // 1. probe
      const probeRes = await deps.probe();
      expect(probeRes).toEqual({
        available: true,
        workspaceId,
        persisted: false,
      });
      expect(mockServer.probes).toHaveLength(1);

      // 2. Queue an event while server is temporarily failing (503)
      mockServer.statusOverride = 503;
      const transcriptPath = join(claudeDir, "projects", "proj-1", "sess-ops.jsonl");
      writeFileSync(transcriptPath, "", { mode: 0o600 });
      await runCliHook("SessionStart", {
        session_id: "sess-ops",
        transcript_path: transcriptPath,
        cwd: workspaceDir,
      });

      const queueBefore = await deps.listQueue();
      expect(queueBefore.pending).toHaveLength(1);

      // 3. retry refuses when binding has changed
      const mismatchDeps = await harnessDeps({
        url: "http://127.0.0.1:19999",
        apiKey,
        workspaceId,
      });
      expect(await mismatchDeps.releaseRetry()).toEqual({
        released: 0,
        bindingChanged: true,
      });

      // 4. retry releases and flushes when server recovers
      mockServer.statusOverride = 200;
      const retryRes = await deps.releaseRetry();
      expect(retryRes).toEqual({
        released: 1,
        bindingChanged: false,
      });
      expect((await deps.listQueue()).pending).toHaveLength(0);

      // 5. Queue another event while server is down, then test drain
      mockServer.statusOverride = 503;
      await runCliHook("UserPromptSubmit", {
        session_id: "sess-ops",
        transcript_path: transcriptPath,
        cwd: workspaceDir,
        prompt: "Queued before drain",
      });
      expect((await deps.listQueue()).pending).toHaveLength(1);

      mockServer.statusOverride = 200;
      const drainRes = await lifeDeps.drainQueue();
      expect(drainRes).toEqual({ remaining: 0, delivered: 1 });

      // 6. Queue another event and test discard
      mockServer.statusOverride = 503;
      await runCliHook("UserPromptSubmit", {
        session_id: "sess-ops",
        transcript_path: transcriptPath,
        cwd: workspaceDir,
        prompt: "Queued before discard",
      });
      expect((await deps.listQueue()).pending).toHaveLength(1);
      const discardRes = await deps.discardQueue({ reason: "operator test" });
      expect(discardRes).toEqual({ discarded: 1 });
      expect((await deps.listQueue()).pending).toHaveLength(0);

      // 7. Lifecycle state, disable, quiesce, and removeArtifacts
      expect((await lifeDeps.readState({ host: "claude-code" })).activated).toBe(true);
      await lifeDeps.disableHost({ host: "claude-code" });
      expect(await readCaptureConsent("claude-code", { home: homeDir })).toBeNull();

      mockServer.statusOverride = 200;
      const quiesceRes = await lifeDeps.quiesceWorkspace();
      expect(quiesceRes).toEqual({ quiesced: true, liveLeases: 0, inFlight: 0 });
      expect(await lifeDeps.readState({ host: "claude-code" })).toEqual({
        activated: false,
        queued: 0,
        quiesced: true,
      });

      mkdirSync(join(claudeDir, "plugins"), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(claudeDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            "mnemosyne@mnemosyne-local": { installPath: "/tmp/mnemo" },
            "other-plugin@official": { installPath: "/tmp/other" },
          },
        }),
        { mode: 0o600 }
      );
      const removeRes = await lifeDeps.removeArtifacts({ host: "claude-code" });
      expect(removeRes.removed.length).toBeGreaterThanOrEqual(1);
      expect(removeRes.preserved).toContain("other-plugin@official");
    } finally {
      process.env.HOME = prevHome;
      process.env.MNEMO_URL = prevUrl;
      process.env.MNEMO_KEY = prevKey;
    }
  }, 15_000);
  it("stops capture instead of sending a new destination's key to the bound server", async () => {
    const transcriptPath = join(claudeDir, "projects", "proj-1", "sess-move.jsonl");
    writeFileSync(transcriptPath, "", { mode: 0o600 });
    const payload = { session_id: "sess-move", transcript_path: transcriptPath, cwd: workspaceDir };
    expect((await runCliHook("SessionStart", payload)).status).toBe(0);
    expect(mockServer.batches).toHaveLength(1);

    const otherServer = await startMockHarnessServer(workspaceId);
    try {
      const movedKey = "mns_test_token_moved_000000000000000000";
      writeFileSync(
        join(homeDir, ".mnemo", "config.json"),
        JSON.stringify({ url: otherServer.url, apiKey: movedKey, workspaceId }),
        { mode: 0o600 }
      );
      const moved = await runCliHook(
        "UserPromptSubmit",
        { ...payload, prompt: "must not reach the old server" },
        { MNEMO_URL: otherServer.url, MNEMO_KEY: movedKey }
      );
      expect(moved.status).toBe(0);
      expect(mockServer.batches).toHaveLength(1);
      expect(mockServer.authorizations.every((h) => h === `Bearer ${apiKey}`)).toBe(true);
      expect(otherServer.batches).toHaveLength(0);
      expect(await readPendingEvents({ home: homeDir })).toHaveLength(0);

      const otherWorkspace = await runCliHook(
        "UserPromptSubmit",
        { ...payload, prompt: "must not land in the bound workspace" },
        { MNEMO_WORKSPACE_ID: "00000000-0000-4000-8000-000000000456" }
      );
      expect(otherWorkspace.status).toBe(0);
      expect(mockServer.batches).toHaveLength(1);
      expect(await readPendingEvents({ home: homeDir })).toHaveLength(0);
    } finally {
      await otherServer.close();
    }
  }, 15_000);

  it("counts, lists, drains, discards and uninstalls legacy writer spools", async () => {
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      await writeCaptureConsent(
        {
          host: "claude-code",
          mode: "user-only",
          consentedAt: "2026-04-01T00:00:00.000Z",
          hostVersion: "1.0.88",
          packageHash: currentPackageHash(),
        },
        { home: homeDir }
      );
      const spool = (prompt: string, session = "sess-legacy-spool") =>
        captureLegacyHook(
          "UserPromptSubmit",
          { session_id: session, prompt },
          {
            home: homeDir,
            url: mockServer.url,
            apiKey,
            workspaceId,
            request: async () => new Response("{}", { status: 503 }),
          }
        );
      expect((await spool("spooled by the legacy writer")).pending).toBe(1);
      expect((await spool("and a second offline turn")).pending).toBe(2);
      expect(await readPendingEvents({ home: homeDir })).toHaveLength(0);

      const lifeDeps = await harnessLifecycleDeps({ url: mockServer.url, apiKey, workspaceId });
      const deps = await harnessDeps({ url: mockServer.url, apiKey, workspaceId });
      expect((await lifeDeps.readState({ host: "claude-code" })).queued).toBe(2);
      const listed = await deps.listQueue();
      expect(listed.pending.map((p) => p.type)).toEqual(["legacy.turn", "legacy.turn"]);
      expect(JSON.stringify(listed)).not.toContain("offline turn");

      // Capture turned off first: the legacy hook now refuses to run, so only the
      // drain can still deliver what it spooled.
      expect((await lifeDeps.disableHost({ host: "claude-code" })).disabled).toBe(true);
      const drained = await lifeDeps.drainQueue();
      expect(drained).toEqual({ remaining: 0, delivered: 2 });
      expect(mockServer.legacyTurns.map((t) => t.content)).toEqual([
        "spooled by the legacy writer",
        "and a second offline turn",
      ]);
      expect((await lifeDeps.readState({ host: "claude-code" })).queued).toBe(0);

      await writeCaptureConsent(
        {
          host: "claude-code",
          mode: "user-only",
          consentedAt: "2026-04-01T00:00:00.000Z",
          hostVersion: "1.0.88",
          packageHash: currentPackageHash(),
        },
        { home: homeDir }
      );
      expect((await spool("discarded on request", "sess-legacy-discard")).pending).toBe(1);
      expect(await deps.discardQueue({ reason: "test" })).toEqual({ discarded: 1 });
      expect((await deps.listQueue()).pending).toHaveLength(0);

      expect((await spool("left for uninstall", "sess-legacy-uninstall")).pending).toBe(1);
      expect((await lifeDeps.readState({ host: "claude-code" })).queued).toBe(1);
      const removed = await lifeDeps.removeArtifacts({ host: "claude-code" });
      expect(removed.removed.some((path) => /legacy-[0-9a-f]{64}\.json$/.test(path))).toBe(true);
      expect((await lifeDeps.readState({ host: "claude-code" })).queued).toBe(0);
    } finally {
      process.env.HOME = prevHome;
    }
  }, 15_000);

  it("stops capturing at the consented mode once the capture artifacts change", async () => {
    await writeCaptureConsent(
      {
        host: "claude-code",
        mode: "full",
        consentedAt: "2026-04-01T00:00:00.000Z",
        hostVersion: "1.0.88",
        packageHash: "0".repeat(64),
        writer: "managed",
      },
      { home: homeDir }
    );
    const transcriptPath = join(claudeDir, "projects", "proj-1", "sess-requal.jsonl");
    writeFileSync(transcriptPath, "", { mode: 0o600 });
    const payload = {
      session_id: "sess-requal",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
    };
    expect((await runCliHook("SessionStart", payload)).status).toBe(0);
    expect(
      (await runCliHook("UserPromptSubmit", { ...payload, prompt: "not qualified" })).status
    ).toBe(0);
    expect(mockServer.batches).toHaveLength(0);
    expect(await readPendingEvents({ home: homeDir })).toHaveLength(0);
  }, 15_000);

  it("publishes the acknowledged server session where the plugin hooks read it", async () => {
    const transcriptPath = join(claudeDir, "projects", "proj-1", "sess-map.jsonl");
    writeFileSync(transcriptPath, "", { mode: 0o600 });
    const payload = { session_id: "sess-map", transcript_path: transcriptPath, cwd: workspaceDir };
    expect((await runCliHook("SessionStart", payload)).status).toBe(0);
    const mapping = JSON.parse(
      readFileSync(join(homeDir, ".mnemo", "sessions", "sess-map.json"), "utf8")
    ) as Record<string, unknown>;
    expect(mapping).toMatchObject({
      mnemoSessionId: "00000000-0000-4000-8000-000000000999",
      workspaceId,
      serverUrl: mockServer.url,
      sourceGeneration: 0,
    });
  }, 15_000);

  it("keeps a prompt captured while an overlapping Stop rewrites the runtime record", async () => {
    const transcriptPath = join(claudeDir, "projects", "proj-1", "sess-race.jsonl");
    writeFileSync(transcriptPath, "", { mode: 0o600 });
    const payload = { session_id: "sess-race", transcript_path: transcriptPath, cwd: workspaceDir };
    const hook = (event: string, extra: Record<string, unknown> = {}) =>
      captureHostHook({
        host: "claude-code",
        event,
        rawPayload: JSON.stringify({ ...payload, ...extra }),
        home: homeDir,
        cwd: workspaceDir,
        claudeConfigDir: claudeDir,
        serverUrl: mockServer.url,
        apiKey,
        workspaceId,
        artifactRoot: PLUGIN_DIR,
        liveGateMode: "full",
      });
    await hook("SessionStart");
    await Promise.all([hook("Stop"), hook("UserPromptSubmit", { prompt: "overlapping prompt" })]);

    const stateDir = join(homeDir, ".mnemo", "harness", "state");
    const runtimeFile = readdirSync(stateDir).find((name) => /^runtime-.*\.json$/.test(name));
    const runtime = JSON.parse(readFileSync(join(stateDir, runtimeFile!), "utf8")) as {
      provisionalPrompts: unknown[];
    };
    expect(runtime.provisionalPrompts).toHaveLength(1);
  }, 15_000);

  it("keeps a resumed conversation's earlier messages out of its successor generation", async () => {
    const transcriptPath = join(claudeDir, "projects", "proj-1", "sess-resume.jsonl");
    const line = (uuid: string, role: "user" | "assistant", text: string, ts: string) =>
      `${JSON.stringify({
        type: role,
        uuid,
        timestamp: ts,
        message: { role, content: role === "user" ? text : [{ type: "text", text }] },
      })}\n`;
    writeFileSync(transcriptPath, "", { mode: 0o600 });
    const payload = {
      session_id: "sess-resume",
      transcript_path: transcriptPath,
      cwd: workspaceDir,
    };
    expect((await runCliHook("SessionStart", payload)).status).toBe(0);
    expect((await runCliHook("UserPromptSubmit", { ...payload, prompt: "first ask" })).status).toBe(
      0
    );
    writeFileSync(
      transcriptPath,
      line("r-u1", "user", "first ask", "2026-04-02T00:00:01.000Z") +
        line("r-a1", "assistant", "first answer", "2026-04-02T00:00:02.000Z"),
      { mode: 0o600 }
    );
    expect((await runCliHook("Stop", payload)).status).toBe(0);
    expect((await runCliHook("SessionEnd", payload)).status).toBe(0);

    expect((await runCliHook("SessionStart", { ...payload, source: "resume" })).status).toBe(0);
    expect(
      (await runCliHook("UserPromptSubmit", { ...payload, prompt: "second ask" })).status
    ).toBe(0);
    writeFileSync(
      transcriptPath,
      line("r-u1", "user", "first ask", "2026-04-02T00:00:01.000Z") +
        line("r-a1", "assistant", "first answer", "2026-04-02T00:00:02.000Z") +
        line("r-u2", "user", "second ask", "2026-04-02T00:00:03.000Z") +
        line("r-a2", "assistant", "second answer", "2026-04-02T00:00:04.000Z"),
      { mode: 0o600 }
    );
    expect((await runCliHook("Stop", payload)).status).toBe(0);
    expect((await runCliHook("SessionEnd", payload)).status).toBe(0);

    const appends = allDeliveredEvents().filter(
      (e): e is Extract<HarnessEvent, { type: "turn.append" }> => e.type === "turn.append"
    );
    const generationsOf = (content: string) =>
      appends.filter((e) => e.content === content).map((e) => e.sourceGeneration);
    expect(generationsOf("first answer")).toEqual([0]);
    expect(generationsOf("second answer")).toEqual([1]);
  }, 30_000);
});
