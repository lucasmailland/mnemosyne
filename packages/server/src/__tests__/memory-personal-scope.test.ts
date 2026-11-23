/**
 * P10 — personal scope resolution in POST /remember.
 *
 * REQ-P10-002: when scope="personal", the server resolves the user's personal
 * workspace via getUserPersonalWorkspaceId and routes the write there.
 *
 * Two scenarios:
 *   (a) key has userId + valid personal workspace → 201 with personal wsId
 *   (b) key has no userId → 400 with descriptive error
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountRemember } from "../routes/remember.js";
import { buildMountHarness } from "./_mountHarness.js";

// ── Mock getUserPersonalWorkspaceId ───────────────────────────────────────────
vi.mock("../recall/multi-level.js", () => ({
  getUserPersonalWorkspaceId: vi.fn(),
  multiLevelRecall: vi.fn(),
}));

import { getUserPersonalWorkspaceId } from "../recall/multi-level.js";
const mockGetPersonalWs = vi.mocked(getUserPersonalWorkspaceId);

// ── Constants ─────────────────────────────────────────────────────────────────

const PLAINTEXT_KEY = "mns_live_personalscope00000000000001";
const WORKSPACE_ID = "00000000-0000-0000-0000-aaa000000001";
const USER_ID = "user-personal-scope-test-001";
const PERSONAL_WS_ID = "00000000-0000-0000-0000-bbb000000002";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeKeyLookup(withUserId: boolean): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      {
        id: "key-personal-scope",
        keyHash,
        workspaceId: WORKSPACE_ID,
        scopes: ["memory:write"],
        userId: withUserId ? USER_ID : null,
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json" };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /remember — scope: personal", () => {
  it("(a) resolves to personal workspace when userId is set", async () => {
    mockGetPersonalWs.mockResolvedValueOnce(PERSONAL_WS_ID);

    let calledWorkspaceId: string | undefined;
    const cognitive = {
      remember: vi.fn(async (args: { workspaceId: string }) => {
        calledWorkspaceId = args.workspaceId;
        return { id: "fact-personal-001", kind: "fact", staged: false };
      }),
    } as unknown as NonNullable<ServerDeps["cognitive"]>;

    const deps = {
      core: {} as ServerDeps["core"],
      apiKeys: await makeKeyLookup(true),
      cognitive,
      metricsPgClient: {} as ServerDeps["metricsPgClient"],
    } as unknown as ServerDeps;

    const app = buildMountHarness(deps, [mountRemember]);
    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "I prefer dark mode.", scope: "personal" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(PERSONAL_WS_ID);
    expect(calledWorkspaceId).toBe(PERSONAL_WS_ID);
    expect(mockGetPersonalWs).toHaveBeenCalledWith(expect.anything(), USER_ID);
  });

  it("(b) returns 400 when key has no userId", async () => {
    const cognitive = {
      remember: vi.fn(),
    } as unknown as NonNullable<ServerDeps["cognitive"]>;

    const deps = {
      core: {} as ServerDeps["core"],
      apiKeys: await makeKeyLookup(false),
      cognitive,
      metricsPgClient: undefined,
    } as unknown as ServerDeps;

    const app = buildMountHarness(deps, [mountRemember]);
    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "Test.", scope: "personal" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/personal/i);
    expect(cognitive.remember).not.toHaveBeenCalled();
  });
});
