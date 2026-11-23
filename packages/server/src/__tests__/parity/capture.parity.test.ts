/**
 * Tier A parity — POST /capture (design.md D3).
 *
 * HTTP characterization contract for `packages/server/src/routes/capture.ts`.
 * Written and merged green against the legacy `deps.core.createFact`
 * (`CoreLike`) implementation FIRST (flatten-legacy-dual-core PR12); the
 * port commit in this same PR then swapped the route to
 * `deps.cognitive.remember` (v3 `MnemoCore`) with ZERO changes to any
 * `expect(...)` line below EXCEPT the two explicitly marked "DISCLOSED
 * exception" assertions, which exercise the internal call shape and
 * necessarily change because `createFact(args)` (one options bag,
 * attribution/tags top-level) and `remember(req, auth)` (two args,
 * attribution folded into `metadata`) are genuinely different calling
 * conventions for the same content — the observable HTTP contract
 * (status codes, response body `{extracted, skipped}`) is unchanged.
 *
 * Only the heuristic extraction path is exercised (no `deps.llmAdapter`
 * wired) — `extractWithHeuristics`/`isNoiseLine` themselves are already
 * covered by `capture-heuristics.test.ts`; this file is scoped to the
 * store-call swap, not re-testing extraction logic.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { mountCapture } from "../../routes/capture.js";

const PLAINTEXT_KEY = "mns_live_captureparitytest00001";
const WS_ID = "00000000-0000-0000-0000-000000000c01";
const ACTOR_ID = "capture-key-001";
const USER_ID = "user-capture-parity";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: ACTOR_ID, keyHash, workspaceId: WS_ID, scopes: [], userId: USER_ID },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json", ...extra };
}

// Matches the "decided to/chose/switched to/..." decision heuristic pattern.
// The trailing period is a sentence-boundary delimiter (stripped by
// `extractWithHeuristics`'s split), so the resulting fact statement below
// deliberately omits it.
const DECISION_CONTENT = "We switched to bun because npm was slow.";
const DECISION_STATEMENT = "We switched to bun because npm was slow";
// No heuristic pattern matches — pure filler, extracts nothing.
const NOISE_CONTENT = "ok";

async function buildApp(
  remember = vi.fn().mockResolvedValue({ id: "mfact_new", kind: "fact", staged: false })
) {
  const deps = {
    cognitive: { remember },
    apiKeys: await makeKeyLookup(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountCapture]);
  return { app, remember };
}

describe("Tier A parity: POST /capture", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: DECISION_CONTENT, source: "subagent-stop" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with extracted:1 skipped:0 for content matching a heuristic pattern, and stores the fact", async () => {
    const { app, remember } = await buildApp();
    const res = await app.request("/capture", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ content: DECISION_CONTENT, source: "subagent-stop" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { extracted: number; skipped: number };
    expect(body).toEqual({ extracted: 1, skipped: 0 });
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it("returns 200 with extracted:0 skipped:0 when no heuristic pattern matches, and does not call the store", async () => {
    const { app, remember } = await buildApp();
    const res = await app.request("/capture", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ content: NOISE_CONTENT, source: "subagent-stop" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { extracted: number; skipped: number };
    expect(body).toEqual({ extracted: 0, skipped: 0 });
    expect(remember).not.toHaveBeenCalled();
  });

  it("counts skipped (not extracted, and does not throw) when the store reports a duplicate/unique/conflict error", async () => {
    const { app } = await buildApp(
      vi.fn().mockRejectedValue(new Error("duplicate key value violates unique constraint"))
    );
    const res = await app.request("/capture", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ content: DECISION_CONTENT, source: "subagent-stop" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { extracted: number; skipped: number };
    expect(body).toEqual({ extracted: 0, skipped: 1 });
  });

  it("propagates an unexpected (non-duplicate) store error as a 500", async () => {
    const { app } = await buildApp(vi.fn().mockRejectedValue(new Error("connection reset")));
    const res = await app.request("/capture", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ content: DECISION_CONTENT, source: "subagent-stop" }),
    });
    expect(res.status).toBe(500);
  });

  it("forwards resolveProvenance(c)'s actorId/userId/actorType to the store call", async () => {
    // DISCLOSED exception (see file header): pre-port, these are top-level
    // fields on the single `createFact(args)` options bag. Post-port they
    // are the second (`auth`) argument to `remember(req, auth)` — a real
    // calling-convention difference, not a behavior change.
    const { app, remember } = await buildApp();
    await app.request("/capture", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ content: DECISION_CONTENT, source: "subagent-stop" }),
    });
    const auth = remember.mock.calls[0]![1] as Record<string, unknown>;
    expect(auth.actorId).toBe(`key:${ACTOR_ID}`);
    expect(auth.userId).toBe(USER_ID);
    expect(auth.actorType).toBe("user");
  });

  it("maps candidate.statement to the store call's content, carrying source/kind/hash in metadata", async () => {
    // DISCLOSED exception (see file header): pre-port this is `content` +
    // `attribution` (top-level, free-form bag) on `createFact(args)`.
    // Post-port the statement moves to `remember(req)`'s `content` and the
    // same source/captureKind/contentHash/capturedAt bag moves into
    // `metadata` (remember's provenance/attribution concept is a fixed
    // enum, not a free-form bag — see design.md D2's `POST /facts` vs
    // `POST /remember` comparison).
    const { app, remember } = await buildApp();
    await app.request("/capture", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ content: DECISION_CONTENT, source: "subagent-stop" }),
    });
    const call = remember.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.content).toBe(DECISION_STATEMENT);
    const metadata = call.metadata as Record<string, unknown>;
    expect(metadata.source).toBe("subagent-stop");
    expect(metadata.captureKind).toBe("decision");
    expect(typeof metadata.contentHash).toBe("string");
  });
});
