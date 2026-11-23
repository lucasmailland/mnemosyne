/**
 * POST /remember genuinely returns 501 when no embed provider is configured
 * and the caller doesn't supply a precomputed `vector`.
 *
 * Unlike POST /recall (P4-B, see recall-no-embed-501.test.ts), there is no
 * FTS-fallback for the write path: packages/core/src/cognitive/remember.ts's
 * `remember()` calls `ctx.embed.embedSingle(req.content)` unconditionally
 * when `precomputedEmbedding` is absent, and the no-embed adapter stub
 * (packages/server/src/embed-adapter.ts) throws NotImplementedError from
 * that call. Found undocumented in both this route's OpenAPI `responses`
 * block and docs/architecture/API.md during a promise-fidelity audit —
 * fixed in both places alongside this test.
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { NotImplementedError } from "../errors.js";
import { mountRemember } from "../routes/remember.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_noembedremembertest01";
const WS_ID = "00000000-0000-0000-0000-000000000017";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: "key001", keyHash, workspaceId: WS_ID, scopes: ["memory:write"], plan: "free" },
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

describe("POST /remember without an embed provider (no /v1 prefix — server mounts v1 at root)", () => {
  it("returns 501 when the request has no precomputed `vector` and the embed adapter is unconfigured", async () => {
    const deps = {
      apiKeys: await makeKeyLookup(),
      cognitive: {
        remember: async () => {
          throw new NotImplementedError(
            "No embed adapter configured: set MNEMO_LLM_PROVIDER and MNEMO_LLM_API_KEY to enable semantic recall",
            { code: "NO_EMBED_ADAPTER" }
          );
        },
      },
    } as unknown as ServerDeps;

    const app = buildMountHarness(deps, [mountRemember]);

    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "the user prefers dark mode" }),
    });

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_implemented");
  });

  it("does not reach the embed adapter at all when a precomputed `vector` is supplied", async () => {
    let rememberCalled = false;
    const deps = {
      apiKeys: await makeKeyLookup(),
      cognitive: {
        remember: async (args: { precomputedEmbedding?: Float32Array }) => {
          rememberCalled = true;
          // The route already threaded body.vector into precomputedEmbedding
          // before this stub is called — proves the bypass, not the embed call.
          expect(args.precomputedEmbedding).toBeInstanceOf(Float32Array);
          return { id: "fact_1", kind: "fact", staged: false };
        },
      },
    } as unknown as ServerDeps;

    const app = buildMountHarness(deps, [mountRemember]);

    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        statement: "the user prefers dark mode",
        vector: Array.from({ length: 8 }, (_, i) => i / 8),
      }),
    });

    expect(res.status).toBe(201);
    expect(rememberCalled).toBe(true);
  });
});
