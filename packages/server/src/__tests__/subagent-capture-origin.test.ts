/** SS05/SS06 — parent correlation (404 on ceiling) and carried subagent provenance. */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { createHash } from "node:crypto";
import type { MnemoSession, SessionTurn, StorageAdapter } from "@mnemo-ai/types";
import { mountCapture } from "../routes/capture.js";
import { buildMountHarness } from "./_mountHarness.js";
import { logger } from "../logging.js";

const PLAINTEXT_KEY = "mns_live_subagentcaptureorigin01";
const WS_ID = "00000000-0000-0000-0000-dd0000000001";
const OTHER_WS_ID = "00000000-0000-0000-0000-dd0000000002";
const NOW = new Date("2026-08-11T00:00:00.000Z");
const CONTENT = "We decided to use PostgreSQL for the audit store because of row-level security.";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      {
        id: "key-subagent-capture",
        keyHash,
        workspaceId: WS_ID,
        scopes: ["memory:write"],
        userId: null,
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function fakeSession(over: Partial<MnemoSession> = {}): MnemoSession {
  return {
    id: "sess-parent-1",
    workspaceId: WS_ID,
    status: "active",
    turnCount: 0,
    tokenCount: 0,
    openedAt: NOW,
    metadata: {},
    sensitivity: "internal",
    ...over,
  } as MnemoSession;
}

function parentTurn(over: Partial<SessionTurn> = {}): SessionTurn {
  return {
    id: "turn-1",
    workspaceId: WS_ID,
    sessionId: "sess-parent-1",
    turnIndex: 0,
    role: "assistant",
    content: CONTENT,
    sourceMessageId: "msg-ss08",
    createdAt: NOW,
    ...over,
  } as SessionTurn;
}

async function setup(
  session: MnemoSession | null,
  turns: SessionTurn[] = [],
  remember = vi.fn(async (..._args: unknown[]) => ({})),
  llmAdapter?: unknown
) {
  const getSession = vi.fn(async (id: string, ws: string) =>
    session && session.id === id && session.workspaceId === ws ? session : null
  );
  const listTurns = vi.fn(async (_id: string, _ws: string) => turns);
  const createSession = vi.fn(async () => ({}));
  const createEpisode = vi.fn(async () => ({}));
  const deps = {
    apiKeys: await makeKeyLookup(),
    storage: { getSession, listTurns, createSession, createEpisode } as unknown as StorageAdapter,
    cognitive: { remember },
    llmAdapter,
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountCapture]);
  const post = (body: unknown) =>
    app.request("/capture", {
      method: "POST",
      headers: { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { post, getSession, listTurns, remember, createSession, createEpisode };
}

describe("POST /capture — subagent provenance (SS06)", () => {
  it("carries parent session, project scope and agent/source identity into remember()", async () => {
    const { post, remember, createSession, createEpisode } = await setup(fakeSession());
    const res = await post({
      content: CONTENT,
      source: "subagent-stop",
      parentSessionId: "sess-parent-1",
      scopeRef: "project-canary-ss06",
      agentId: "agent-canary-ss06",
      sourceMessageId: "msg-canary-ss06",
      trafficOrigin: "subagent-canary-ss06",
    });
    expect(res.status).toBe(200);
    expect(remember).toHaveBeenCalled();
    const [req, auth] = remember.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(req.sessionId).toBe("sess-parent-1");
    expect(req.scopeRef).toBe("project-canary-ss06");
    expect(req.agentId).toBeUndefined();
    const meta = req.metadata as Record<string, unknown>;
    expect(meta.agentId).toBe("agent-canary-ss06");
    expect(meta.sourceMessageId).toBe("msg-canary-ss06");
    expect(meta.trafficOrigin).toBe("subagent-canary-ss06");
    // Authenticated actor comes from the key, never from a body-supplied agentId.
    expect(auth.actorId).toBe("key:key-subagent-capture");
    expect(auth.actorId).not.toBe("agent-canary-ss06");
    expect(createSession).not.toHaveBeenCalled();
    expect(createEpisode).not.toHaveBeenCalled();
  });
});

describe("POST /capture — parent correlation (SS05)", () => {
  it("valid parent in the workspace → 200 and extraction runs", async () => {
    const { post, remember } = await setup(fakeSession());
    const res = await post({
      content: CONTENT,
      source: "subagent-stop",
      parentSessionId: "sess-parent-1",
      scopeRef: "scope-1",
      agentId: "agent-1",
      sourceMessageId: "msg-1",
      trafficOrigin: "subagent",
    });
    expect(res.status).toBe(200);
    expect(remember).toHaveBeenCalled();
  });

  it("stale or foreign parent → 404, no writes, same body as a missing parent", async () => {
    const body = { content: CONTENT, source: "subagent-stop", parentSessionId: "sess-parent-1" };
    const { post, remember } = await setup(fakeSession({ workspaceId: OTHER_WS_ID }));
    const foreign = await post(body);
    const missing = await (await setup(null)).post(body);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
    expect(remember).not.toHaveBeenCalled();
  });

  it("parent above the caller's sensitivity ceiling → 404, no writes", async () => {
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "internal");
    try {
      const { post, remember } = await setup(fakeSession({ sensitivity: "confidential" }));
      const res = await post({
        content: CONTENT,
        source: "subagent-stop",
        parentSessionId: "sess-parent-1",
      });
      expect(res.status).toBe(404);
      expect(remember).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["confidential", "restricted"] as const)(
    "readable %s parent → every extracted fact keeps the parent's tier",
    async (tier) => {
      vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted");
      try {
        const { post, remember } = await setup(fakeSession({ sensitivity: tier }));
        const res = await post({
          content: CONTENT,
          source: "subagent-stop",
          parentSessionId: "sess-parent-1",
        });
        expect(res.status).toBe(200);
        expect(remember).toHaveBeenCalled();
        for (const call of remember.mock.calls) {
          const [req] = call as unknown as [Record<string, unknown>];
          expect(req.sensitivity).toBe(tier);
        }
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );

  it("legacy uncorrelated payload {content, source} remains accepted", async () => {
    const { post, getSession } = await setup(null);
    const res = await post({ content: CONTENT, source: "subagent-stop" });
    expect(res.status).toBe(200);
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe("POST /capture — parent-result dedup (SS08)", () => {
  const body = {
    content: CONTENT,
    source: "subagent-stop",
    parentSessionId: "sess-parent-1",
    sourceMessageId: "msg-ss08",
  };

  it("same identity and content already in the parent → no remember call", async () => {
    const { post, remember, listTurns } = await setup(fakeSession(), [parentTurn()]);
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ extracted: 0, skipped: 0 });
    expect(remember).not.toHaveBeenCalled();
    expect(listTurns).toHaveBeenCalledWith("sess-parent-1", WS_ID);
  });

  it("same identity matched by content hash → no remember call", async () => {
    const digest = createHash("sha256").update(CONTENT).digest("hex");
    const { post, remember } = await setup(fakeSession(), [
      parentTurn({ content: "", contentHash: digest }),
    ]);
    const res = await post(body);
    expect(await res.json()).toEqual({ extracted: 0, skipped: 0 });
    expect(remember).not.toHaveBeenCalled();
  });

  it("retracted parent turn is eligible again", async () => {
    const { post, remember } = await setup(fakeSession(), [
      parentTurn({ retractedAt: NOW, retractionReason: "superseded" }),
    ]);
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(remember).toHaveBeenCalled();
  });

  it("different content under the same sourceMessageId is eligible", async () => {
    const { post, remember } = await setup(fakeSession(), [
      parentTurn({ content: "Completely unrelated parent text.", contentHash: "other" }),
    ]);
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(remember).toHaveBeenCalled();
  });

  it("replayed fact hits canonical remember dedup → counted as skipped, not duplicated", async () => {
    const remember = vi.fn(async (..._args: unknown[]) => {
      throw new Error("duplicate key value violates unique constraint");
    });
    const { post } = await setup(fakeSession(), [], remember);
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ extracted: 0, skipped: 1 });
    const [req] = remember.mock.calls[0] as unknown as [Record<string, unknown>];
    expect((req.metadata as Record<string, unknown>).contentHash).toEqual(expect.any(String));
  });

  it("identical content in another workspace is never read", async () => {
    const { post, listTurns, remember } = await setup(fakeSession({ workspaceId: OTHER_WS_ID }), [
      parentTurn({ workspaceId: OTHER_WS_ID }),
    ]);
    const res = await post(body);
    expect(res.status).toBe(404);
    expect(listTurns).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });
});

describe("POST /capture — secret and transcript hygiene (SS10)", () => {
  const SECRET = "sk-canaryss10abcdef0123456789XYZ";
  const PATH = "/home/pablo/.ssh/canary-ss10-path";
  const SECRET_CONTENT = `We decided to use PostgreSQL with key ${SECRET} for the audit store at ${PATH} because of RLS.`;

  it("redacts visible text before the LLM sees it and never sends the raw secret", async () => {
    const generate = vi.fn(async (_req: unknown) => ({ content: "[]" }));
    const { post, remember } = await setup(fakeSession(), [], undefined, { generate });
    const res = await post({ content: SECRET_CONTENT, source: "subagent-stop" });
    expect(res.status).toBe(200);
    const prompt = JSON.stringify(generate.mock.calls);
    expect(prompt).not.toContain(SECRET);
    expect(prompt).toContain("PostgreSQL");
    // Heuristic safety net also runs on the redacted text: no canary is stored.
    for (const call of remember.mock.calls as unknown as [Record<string, unknown>][]) {
      expect(String(call[0].content)).not.toContain(SECRET);
    }
  });

  it("malformed LLM output with canary tokens/paths never reaches logs; diagnostics are reason/count only", async () => {
    const malformed = `not json ${SECRET} ${PATH} <thinking>internal plan</thinking>`;
    const generate = vi.fn(async (_req: unknown) => ({ content: malformed }));
    const debug = vi.spyOn(logger, "debug");
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");
    try {
      const { post, remember } = await setup(fakeSession(), [], undefined, { generate });
      const res = await post({ content: CONTENT, source: "subagent-stop" });
      expect(res.status).toBe(200);
      const logged = JSON.stringify([debug.mock.calls, warn.mock.calls, info.mock.calls]);
      expect(logged).not.toContain("canary");
      expect(logged).not.toContain("internal plan");
      expect(logged).not.toContain(PATH);
      const parseDiag = debug.mock.calls.find(
        (c) => c[1] === "capture.llm_json_parse_failed"
      ) as unknown as [Record<string, unknown>, string] | undefined;
      expect(parseDiag).toBeDefined();
      expect(Object.keys(parseDiag![0]).sort()).toEqual(["outputChars", "reason"]);
      expect(parseDiag![0].reason).toBe("json_parse_failed");
      expect(parseDiag![0].outputChars).toBe(malformed.length);
      // Fallback to heuristics still happens and nothing from the thinking block is saved.
      for (const call of remember.mock.calls as unknown as [Record<string, unknown>][]) {
        expect(String(call[0].content)).not.toContain("internal plan");
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});
