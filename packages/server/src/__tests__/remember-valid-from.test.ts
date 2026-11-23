/**
 * POST /remember honors `validFrom` for a fact: it reaches cognitive.remember
 * (and so the stored row) instead of being accepted and dropped. A future
 * instant answers 400 — valid time cannot start after the write — and other
 * kinds ignore the field.
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountRemember } from "../routes/remember.js";
import { buildMountHarness } from "./_mountHarness.js";

const KEY = "mns_live_remembervalidfrom000001";
const WS = "00000000-0000-0000-0000-000000000019";

async function makeApp() {
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  const seen: Array<{ kind: string; validFrom?: Date }> = [];
  const deps = {
    apiKeys: {
      listActive: async () => [
        { id: "k", keyHash, workspaceId: WS, scopes: ["memory:write"], plan: "free" },
      ],
      touch: async () => {},
    } as unknown as ApiKeyLookup,
    cognitive: {
      remember: async (args: { kind: string; validFrom?: Date }) => {
        seen.push(args);
        return { id: "fact_1", kind: args.kind, staged: false };
      },
    },
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountRemember]);
  const post = (body: unknown) =>
    app.request("/remember", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { post, seen };
}

describe("POST /remember — validFrom", () => {
  it("passes a past validFrom to cognitive.remember for a fact", async () => {
    const { post, seen } = await makeApp();
    const res = await post({
      statement: "deploys moved to Fridays",
      validFrom: "2026-01-05T09:00Z",
    });
    expect(res.status).toBe(201);
    expect(seen[0]!.validFrom?.toISOString()).toBe("2026-01-05T09:00:00.000Z");
  });

  it("refuses a validFrom in the future with 400 on the field", async () => {
    const { post, seen } = await makeApp();
    const res = await post({ statement: "x", validFrom: "2999-01-01T00:00:00Z" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("validFrom cannot be in the future.");
    expect(seen).toHaveLength(0);
  });

  it("leaves it out for another kind", async () => {
    const { post, seen } = await makeApp();
    await post({ statement: "use Postgres", kind: "decision", validFrom: "2026-01-05T09:00Z" });
    expect(seen[0]!.validFrom).toBeUndefined();
  });
});
