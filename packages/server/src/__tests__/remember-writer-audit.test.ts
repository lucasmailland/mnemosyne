/** POST /remember writer_normalization audit: safe detail; audit failure never 500s. */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST, type ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountRemember } from "../routes/remember.js";
import { buildMountHarness } from "./_mountHarness.js";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../logging.js", async (orig) => {
  const mod = await orig<typeof import("../logging.js")>();
  return { ...mod, logger: { ...mod.logger, warn } };
});

const PLAINTEXT_KEY = "mns_live_rememberwriteraudit01";
const WS_ID = "00000000-0000-0000-0000-000000000019";
const SECRET = "secret-statement-text";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: "key003", keyHash, workspaceId: WS_ID, scopes: ["memory:write"], plan: "free" },
    ],
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

const headers = {
  authorization: `Bearer ${PLAINTEXT_KEY}`,
  "content-type": "application/json",
  "x-mnemo-client-version": "1.2.3",
};

async function setup(appendAuditEntry: ReturnType<typeof vi.fn>) {
  const cognitive = { remember: async () => ({ id: "fact_1", kind: "fact", staged: false }) };
  const apiKeys = await makeKeyLookup();
  const deps = { apiKeys, storage: { appendAuditEntry }, cognitive } as unknown as ServerDeps;
  return buildMountHarness(deps, [mountRemember]);
}

const post = (app: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown>) =>
  app.request("/remember", {
    method: "POST",
    headers,
    body: JSON.stringify({ statement: SECRET, ...extra }),
  });

describe("POST /remember — writer_normalization audit", () => {
  it("distinguishes absent / invalid / explicit-other / valid without leaking text", async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const app = await setup(append);
    const cases: Array<[Record<string, unknown>, string, string | null, string | null]> = [
      [{}, "absent", null, null],
      [{ subtype: "Bogus-Thing" }, "invalid", "bogus-thing", "other"],
      [{ subtype: " OTHER " }, "explicit-other", "other", "other"],
      [{ subtype: "Preference" }, "valid", "preference", "preference"],
    ];
    for (const [extra, state] of cases) {
      const res = await post(app, extra);
      expect(res.status).toBe(201);
      expect(((await res.json()) as any).warnings?.[0]?.code).toBe(
        state === "invalid" ? "subtype_substituted" : undefined
      );
    }
    expect(append).toHaveBeenCalledTimes(4);
    const entries = append.mock.calls.map((c) => c[0]);
    cases.forEach(([, state, received, stored], i) => {
      const e = entries[i];
      expect(e).toMatchObject({
        workspaceId: WS_ID,
        action: "create",
        resourceKind: "fact",
        resourceId: "fact_1",
        actorId: expect.any(String),
      });
      expect(e.detail).toMatchObject({
        event: "writer_normalization",
        subtypeState: state,
        receivedSubtype: received,
        storedSubtype: stored,
        writerVersion: "1.2.3",
        warningCode: i === 1 ? "subtype_substituted" : null,
      });
      expect(JSON.stringify(e)).not.toContain(SECRET);
    });
  });

  it("logs a diagnostic and still answers 201 when the audit write fails", async () => {
    warn.mockClear();
    const app = await setup(vi.fn().mockRejectedValue(new Error("merkle lock")));
    const res = await post(app, { subtype: "preference" });
    expect(res.status).toBe(201);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create" }),
      "audit_emit.failed"
    );
  });
});
