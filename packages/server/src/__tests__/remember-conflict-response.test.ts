/**
 * POST /remember whitelist-mapping regression guard for `conflict`.
 *
 * `routes/remember.ts` hand-maps a field whitelist into the 201 response
 * literal — it does NOT spread `result` verbatim. Adding a new field to
 * `RememberResponse` (like `conflict`, added by the write-time
 * conflict-surfacing change) does nothing on the wire unless the route
 * explicitly includes it in that literal. This test stubs
 * `deps.cognitive.remember` directly (no core/DB involved) and asserts the
 * `conflict` key round-trips through the mapping when present, and is
 * genuinely absent (not `null`/`{}`) when the core result omits it.
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountRemember } from "../routes/remember.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_conflictresponsetest01";
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

describe("POST /remember — conflict field whitelist mapping", () => {
  it("includes `conflict` in the 201 body when core's remember() result carries it", async () => {
    const conflict = {
      judgmentRequired: true,
      candidates: [
        {
          id: "fact_existing_1",
          subject: "workspace",
          statement: "the user prefers light mode",
          action: "review" as const,
          relationId: "rel_1",
        },
      ],
    };
    const deps = {
      apiKeys: await makeKeyLookup(),
      cognitive: {
        remember: async () => ({ id: "fact_new_1", kind: "fact", staged: false, conflict }),
      },
    } as unknown as ServerDeps;

    const app = buildMountHarness(deps, [mountRemember]);

    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "the user prefers dark mode" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { conflict?: unknown };
    expect(body.conflict).toEqual(conflict);
  });

  it("omits `conflict` entirely from the 201 body when core's result has no conflict", async () => {
    const deps = {
      apiKeys: await makeKeyLookup(),
      cognitive: {
        remember: async () => ({ id: "fact_new_2", kind: "fact", staged: false }),
      },
    } as unknown as ServerDeps;

    const app = buildMountHarness(deps, [mountRemember]);

    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "the user prefers dark mode" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect("conflict" in body).toBe(false);
  });
});
