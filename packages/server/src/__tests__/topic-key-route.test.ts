/**
 * AGENTSIM-5 — POST /topic-key/suggest accepts an `attribute`, so the key of
 * an updated value matches the key of the value it replaces.
 */
import { describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountTopicKeySuggest } from "../routes/topicKey.js";
import { buildMountHarness } from "./_mountHarness.js";

const KEY = "mns_live_topickeyroutetest000001";
const WS = "00000000-0000-0000-0000-000000000520";

async function app() {
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [{ id: "k520", keyHash, workspaceId: WS, scopes: ["memory:write"] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  return buildMountHarness({ apiKeys } as unknown as ServerDeps, [mountTopicKeySuggest]);
}

async function suggest(body: Record<string, unknown>) {
  const res = await (
    await app()
  ).request("/topic-key/suggest", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { topicKey: string; source: string } };
}

describe("POST /topic-key/suggest — attribute", () => {
  it("derives the same key for the old and the new value", async () => {
    const before = await suggest({
      subject: "payments-api",
      attribute: "deploy method",
      body: "deploys via Fly.io",
    });
    const after = await suggest({
      subject: "payments-api",
      attribute: "deploy method",
      body: "now deployed by ArgoCD",
    });
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      topicKey: "payments-api/deploy-method",
      source: "subject+attribute",
    });
    expect(after.body.topicKey).toBe(before.body.topicKey);
  });

  it("keeps the legacy derivation without an attribute", async () => {
    const res = await suggest({
      subject: "Auth Strategy",
      body: "Use JWT rotation every 15 minutes",
    });
    expect(res.body).toMatchObject({ topicKey: "auth-strategy/use-jwt-rotation" });
  });
});
