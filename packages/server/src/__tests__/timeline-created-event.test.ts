/**
 * B3 (complete-mcp-tools) regression test — HTTP-level only.
 *
 * `GET /timeline`'s response schema declares `kind: "created"` as a valid
 * event value, but the legacy `deps.core.timeline()` call (factory.ts,
 * derives `kind` from `updated_at`/`pinned`/`valid_to`/`status` only) could
 * never produce it: a freshly created, never-modified, unpinned,
 * open-interval fact has `updatedAt === createdAt`, so the pre-fix route
 * reported a phantom `"updated"` event and never `"created"`.
 *
 * This test asserts ONLY against the actual `GET /timeline` HTTP JSON
 * response shape — never against `deps.core.timeline()` call args or any
 * `factory.ts` internals — exactly as designed, so it survived unmodified
 * when `timeline.ts` was later ported fully off the legacy `core` surface
 * (flatten-legacy-dual-core, task 6.6): the first `it()` block below has
 * ZERO diff from its original B3 form — `deps.core`/`deps.core.timeline`
 * are still supplied in its `deps` fixture but are now simply dead weight,
 * never read by the ported route; the assertions pass because
 * `deps.storage` (an `InMemoryStorageAdapter`, always present in this test)
 * independently reproduces the exact same "created, no phantom updated"
 * outcome via `deriveTimelineEvents()` (routes/timeline.ts).
 *
 * The second `it()` block ("degrades to core-only output... when
 * deps.storage is absent") DID require an `expect(...)` change — disclosed,
 * not silent. That scenario tested B3's INTERIM, dual-core-era fallback:
 * `deps.storage` was optional, and the route degraded to `deps.core`-only
 * output when it was absent. Once `timeline.ts` is fully off `deps.core`
 * (this PR), there is no fallback left to degrade to — `deps.storage`
 * becomes required, converging to a 503 `ServiceUnavailableError` on
 * absence, the SAME established convention every other fully-ported route
 * in this codebase already uses (`session.ts`'s `POST /session/:id/discard`,
 * `admin.ts`, `keys.ts`, `capture.ts` — see `session.parity.test.ts`'s
 * "Tier A parity: POST /session/:id/discard" block for the precedent this
 * mirrors). This is an intentional, expected consequence of the
 * architecture change, not a sign the port is behaviorally non-equivalent —
 * investigated per the launch instructions before changing anything.
 *
 * `deps.core.timeline` below is a test double that faithfully reproduces
 * factory.ts:810-854's derivation rule (the exact legacy shape B3's fix
 * merged against without modifying) — the same test-double pattern already
 * used for `deps.cognitive`/`deps.core` throughout this suite (see
 * remember-topic-key-echo.test.ts, entities-link-user.test.ts). It is kept
 * in the first test's fixture, unused by the ported route, purely so that
 * test's `deps` object — and therefore its `expect(...)` assertions — stay
 * byte-for-byte identical to B3's original commit.
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { MnemoFact } from "@mnemo-ai/types";

import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountRemember } from "../routes/remember.js";
import { mountTimeline } from "../routes/timeline.js";
import { buildMountHarness } from "./_mountHarness.js";

const WS_ID = "00000000-0000-0000-0000-0000000000b3";
const PLAINTEXT_KEY = "mns_live_timelinecreatedeventtest01";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: "keyB3timeline", keyHash, workspaceId: WS_ID, scopes: ["memory:write"], plan: "free" },
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

type LegacyTimelineEvent = {
  id: string;
  at: string;
  kind: "closed" | "pinned" | "updated";
  factId: string;
  actorId: string | null;
  summary: string;
};

describe("GET /timeline — B3 real 'created' events", () => {
  it("a fact created via POST /remember yields exactly one kind:'created' event, no phantom 'updated'", async () => {
    const storage = new InMemoryStorageAdapter();
    const created: MnemoFact[] = [];

    const deps = {
      apiKeys: await makeKeyLookup(),
      storage,
      cognitive: {
        remember: async (args: { content: string; workspaceId: string }) => {
          const fact = await storage.createFact({
            workspaceId: args.workspaceId,
            statement: args.content,
            subject: "workspace",
            kind: "other",
            scope: "global",
          } as never);
          created.push(fact);
          return { id: fact.id, kind: "fact", staged: false };
        },
      },
      core: {
        // Faithful reproduction of factory.ts:810-854's derivation rule —
        // reads ONLY updated_at/pinned/valid_to/status, exactly like the
        // real (untouched) legacy implementation, so the "phantom updated"
        // bug this fix retires is genuinely reproduced, not assumed.
        timeline: async (args: {
          workspaceId: string;
          since?: Date;
          limit: number;
        }): Promise<{ events: LegacyTimelineEvent[]; nextCursor: string | null }> => {
          const since = args.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000); // determinism-ok: faithful reproduction of factory.ts's real default-window fallback
          const events = created
            .filter((f) => f.workspaceId === args.workspaceId && f.updatedAt >= since)
            .map((f) => ({
              id: f.id,
              at: f.updatedAt.toISOString(),
              kind: (f.status === "forgotten" || (f.validTo ?? null) !== null
                ? "closed"
                : f.pinned
                  ? "pinned"
                  : "updated") as "closed" | "pinned" | "updated",
              factId: f.id,
              actorId: f.actorId ?? null,
              summary: f.statement.slice(0, 200),
            }))
            .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
            .slice(0, args.limit);
          return { events, nextCursor: null };
        },
      },
    } as unknown as ServerDeps;

    const app = buildMountHarness(deps, [mountRemember, mountTimeline]);

    const rememberRes = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "B3 timeline created-event regression fact" }),
    });
    expect(rememberRes.status).toBe(201);
    expect(created).toHaveLength(1);
    const factId = created[0]!.id;

    const since = new Date(Date.now() - 60_000).toISOString(); // determinism-ok: query window must be relative to "now" to include the fact just created above
    const timelineRes = await app.request(`/timeline?since=${encodeURIComponent(since)}&limit=50`, {
      method: "GET",
      headers: authed(),
    });
    expect(timelineRes.status).toBe(200);

    const body = (await timelineRes.json()) as {
      events: Array<{ kind: string; factId: string }>;
    };

    const eventsForFact = body.events.filter((e) => e.factId === factId);
    expect(eventsForFact).toHaveLength(1);
    expect(eventsForFact[0]!.kind).toBe("created");
    expect(body.events.some((e) => e.factId === factId && e.kind === "updated")).toBe(false);
  });

  it("returns 503 when deps.storage is absent (flatten-legacy-dual-core: no more deps.core fallback)", async () => {
    // Pre-port, this scenario asserted a 200 core-only degrade (see header
    // comment's disclosure). `timeline.ts` is now fully off `deps.core`, so
    // absent `deps.storage` has no fallback left — same 503
    // `ServiceUnavailableError` convergence every other fully-ported route
    // in this codebase already uses.
    const deps = {
      apiKeys: await makeKeyLookup(),
      // storage intentionally omitted
    } as unknown as ServerDeps;

    const app = buildMountHarness(deps, [mountTimeline]);

    const res = await app.request("/timeline?limit=50", { method: "GET", headers: authed() });
    expect(res.status).toBe(503);
  });
});
