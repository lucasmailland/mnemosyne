/**
 * POST /remember must forward `topicKey` into `rememberArgs` and echo the
 * actually-stored value in the response — not the hardcoded `null` this
 * route used to return regardless of what the caller sent (topicKey
 * pass-through fix, slice a).
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountRemember } from "../routes/remember.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_remembertopickeytest01";
const WS_ID = "00000000-0000-0000-0000-000000000018";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: "key002", keyHash, workspaceId: WS_ID, scopes: ["memory:write"], plan: "free" },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

const authed = () => ({
  authorization: `Bearer ${PLAINTEXT_KEY}`,
  "content-type": "application/json",
});

describe("POST /remember — topicKey pass-through and echo", () => {
  it("forwards topicKey to cognitive.remember and echoes it in the response", async () => {
    let receivedTopicKey: string | undefined;
    const deps = {
      apiKeys: await makeKeyLookup(),
      cognitive: {
        remember: async (args: { topicKey?: string }) => {
          receivedTopicKey = args.topicKey;
          return { id: "fact_1", kind: "fact", staged: false };
        },
      },
    } as unknown as ServerDeps;

    const app = buildMountHarness(deps, [mountRemember]);

    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        statement: "the deploy region is us-east-1",
        topicKey: "auth-strategy",
      }),
    });

    expect(res.status).toBe(201);
    expect(receivedTopicKey).toBe("auth-strategy");
    const body = (await res.json()) as { topicKey: string | null };
    expect(body.topicKey).toBe("auth-strategy");
  });

  it("echoes null when no topicKey is supplied", async () => {
    const deps = {
      apiKeys: await makeKeyLookup(),
      cognitive: {
        remember: async () => ({ id: "fact_2", kind: "fact", staged: false }),
      },
    } as unknown as ServerDeps;

    const app = buildMountHarness(deps, [mountRemember]);

    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "the deploy region is us-east-1" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { topicKey: string | null };
    expect(body.topicKey).toBeNull();
  });
});
