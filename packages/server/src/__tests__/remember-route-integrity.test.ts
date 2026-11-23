/**
 * WP-5 — POST /remember request validation and result mapping.
 *
 *   - AGENTSIM-8: an unknown `subtype` silently became `other`; a bug fix
 *     filed with `subtype:"bugfix"` (a DECISION subtype) lost its category.
 *   - CHAOS-12 (statement half): a whitespace-only statement was stored, and
 *     one carrying a NUL byte reached Postgres and came back as a 500.
 *   - PRIM-14: a write above the caller's own read ceiling succeeded (201) and
 *     could never be read back by that caller.
 *   - CHAOS-5: the response says when the embedding was deferred.
 *   - Entities: a duplicate live name is a 409, not a 500.
 *   - AGENTSIM-7: `title` reaches remember().
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { RememberConflictError } from "@mnemo-ai/core/cognitive";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountRemember } from "../routes/remember.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_rememberintegrity00001";
const WS_ID = "00000000-0000-0000-0000-000000000519";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: "key519", keyHash, workspaceId: WS_ID, scopes: ["memory:write"], plan: "free" },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

async function makeApp(remember: (...args: unknown[]) => Promise<unknown>) {
  const spy = vi.fn(remember);
  const deps = {
    apiKeys: await makeKeyLookup(),
    cognitive: { remember: spy },
  } as unknown as ServerDeps;
  return { app: buildMountHarness(deps, [mountRemember]), remember: spy };
}

const ok = async () => ({ id: "fact_1", kind: "fact", staged: false });

async function post(app: Awaited<ReturnType<typeof makeApp>>["app"], body: unknown) {
  return app.request("/remember", {
    method: "POST",
    headers: { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  delete process.env.MNEMO_SENSITIVITY_CEILING;
});

// AGENTSIM-8 first fell back to `other` in silence, then (WP-5) answered 400,
// which cost 45 of 62 protocol-following agent writes (verify Q-3). An unknown
// subtype is now stored as the kind's fallback and the response says so.
describe("AGENTSIM-8 / Q-3 — subtype taxonomy", () => {
  const subtypeSent = (remember: ReturnType<typeof vi.fn>, call: number) =>
    (remember.mock.calls[call]![0] as { subtype?: string }).subtype;

  it.each(["architecture", "bugfix", "config", "discovery", "policy", "process"])(
    "accepts the agent subtype '%s' on a fact as is",
    async (subtype) => {
      const { app, remember } = await makeApp(ok);
      const res = await post(app, { statement: "the deploy runs on Fridays", subtype });
      expect(res.status).toBe(201);
      expect(subtypeSent(remember, 0)).toBe(subtype);
      expect(((await res.json()) as Record<string, unknown>).warnings).toBeUndefined();
    }
  );

  it("stores an unknown fact subtype as 'other' and warns, naming the substitution", async () => {
    const { app, remember } = await makeApp(ok);
    const res = await post(app, { statement: "we moved billing to Stripe", subtype: "decision" });
    expect(res.status).toBe(201);
    expect(subtypeSent(remember, 0)).toBe("other");
    const body = (await res.json()) as {
      warnings?: Array<{
        code: string;
        field: string;
        received: string;
        storedAs: string;
        message: string;
      }>;
    };
    expect(body.warnings).toEqual([
      expect.objectContaining({
        code: "subtype_substituted",
        field: "subtype",
        received: "decision",
        storedAs: "other",
      }),
    ]);
    // The message lists the valid values and points at the kind that owns it.
    expect(body.warnings![0]!.message).toContain("preference");
    expect(body.warnings![0]!.message).toContain("kind 'decision'");
  });

  it("falls back per kind: a decision to 'decision', an entity to 'other'", async () => {
    const { app, remember } = await makeApp(ok);
    const decision = await post(app, { statement: "use pg", kind: "decision", subtype: "deploy" });
    const entity = await post(app, {
      statement: "a vendor",
      kind: "entity",
      subtype: "vendor",
      subject: "Acme",
    });
    expect([decision.status, entity.status]).toEqual([201, 201]);
    expect(subtypeSent(remember, 0)).toBe("decision");
    expect(subtypeSent(remember, 1)).toBe("other");
    for (const res of [decision, entity]) {
      const body = (await res.json()) as { warnings?: Array<{ code: string }> };
      expect(body.warnings?.map((w) => w.code)).toEqual(["subtype_substituted"]);
    }
  });

  it("matches a valid subtype regardless of case and surrounding space", async () => {
    const { app, remember } = await makeApp(ok);
    const res = await post(app, { statement: "likes tea", subtype: " Preference " });
    expect(res.status).toBe(201);
    expect(subtypeSent(remember, 0)).toBe("preference");
    expect(((await res.json()) as Record<string, unknown>).warnings).toBeUndefined();
  });

  it("accepts a valid subtype per kind and ignores it for kinds without subtypes", async () => {
    const { app, remember } = await makeApp(ok);
    expect((await post(app, { statement: "likes tea", subtype: "preference" })).status).toBe(201);
    expect(
      (await post(app, { statement: "use pg", kind: "decision", subtype: "bugfix" })).status
    ).toBe(201);
    const strategy = await post(app, {
      statement: "when red, rerun",
      kind: "strategy",
      subtype: "anything",
    });
    expect(strategy.status).toBe(201);
    expect(((await strategy.json()) as Record<string, unknown>).warnings).toBeUndefined();
    expect(remember).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["an empty value", ""],
    ["whitespace only", "   "],
    ["a number", 7],
  ])("still answers 400 for %s", async (_label, subtype) => {
    const { app, remember } = await makeApp(ok);
    const res = await post(app, { statement: "likes tea", subtype });
    expect(res.status).toBe(400);
    expect(remember).not.toHaveBeenCalled();
  });
});

describe("CHAOS-12 — statements that cannot be stored are a 400", () => {
  it.each([
    ["whitespace only", "   \n\t  "],
    ["a NUL byte", "before\u0000after"],
  ])("rejects a statement with %s", async (_label, statement) => {
    const { app, remember } = await makeApp(ok);
    const res = await post(app, { statement });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { param?: string } };
    expect(body.error.param).toBe("statement");
    expect(remember).not.toHaveBeenCalled();
  });

  it("rejects a NUL byte in the subject too", async () => {
    const { app } = await makeApp(ok);
    const res = await post(app, { statement: "fine", subject: "a\u0000b" });
    expect(res.status).toBe(400);
  });
});

describe("PRIM-14 — no write above the caller's own read ceiling", () => {
  it("refuses a confidential write under the default (internal) ceiling, before storing", async () => {
    const { app, remember } = await makeApp(ok);
    const res = await post(app, {
      statement: "the root password rotates monthly",
      sensitivity: "confidential",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("sensitivity_above_ceiling");
    expect(remember).not.toHaveBeenCalled();
  });

  it("accepts it when the ceiling allows reading it back", async () => {
    process.env.MNEMO_SENSITIVITY_CEILING = "restricted";
    const { app, remember } = await makeApp(ok);
    const res = await post(app, { statement: "readable", sensitivity: "confidential" });
    expect(res.status).toBe(201);
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it("accepts writes at or below the ceiling", async () => {
    const { app } = await makeApp(ok);
    expect((await post(app, { statement: "public note", sensitivity: "public" })).status).toBe(201);
    expect((await post(app, { statement: "default tier" })).status).toBe(201);
  });
});

describe("remember() results reach the wire", () => {
  it("reports embeddingDeferred when the embedder was down (CHAOS-5)", async () => {
    const { app } = await makeApp(async () => ({
      id: "fact_deferred",
      kind: "fact",
      staged: false,
      embeddingDeferred: true,
    }));
    const res = await post(app, { statement: "stored while the embedder was down" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { embeddingDeferred?: boolean }).embeddingDeferred).toBe(true);
  });

  it("omits embeddingDeferred on the normal path", async () => {
    const { app } = await makeApp(ok);
    const res = await post(app, { statement: "normal write" });
    expect(await res.json()).not.toHaveProperty("embeddingDeferred");
  });

  it("maps a duplicate live entity to 409 with the existing id", async () => {
    const { app } = await makeApp(async () => {
      throw new RememberConflictError(
        "An entity named 'Acme' of kind 'organization' already exists.",
        {
          kind: "entity",
          existingId: "ent_1",
        }
      );
    });
    const res = await post(app, {
      statement: "a vendor",
      kind: "entity",
      subtype: "organization",
      subject: "Acme",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { details?: { existingId?: string } } };
    expect(body.error.details?.existingId).toBe("ent_1");
  });

  it("forwards an explicit decision title (AGENTSIM-7)", async () => {
    const { app, remember } = await makeApp(async () => ({
      id: "dec_1",
      kind: "decision",
      staged: false,
    }));
    await post(app, {
      statement: "We use Kafka. It scales.",
      kind: "decision",
      title: "Queue: Kafka",
    });
    expect(remember.mock.calls[0]![0]).toMatchObject({ title: "Queue: Kafka", kind: "decision" });
  });
});

describe("review round — duplicate entity above the caller's ceiling", () => {
  it("answers 404 without the id when the conflicting entity is unreadable", async () => {
    const { app } = await makeApp(async () => {
      throw Object.assign(
        new RememberConflictError("An entity named 'Vault' already exists.", {
          kind: "entity",
          existingId: "ent_secret",
        }),
        { existingSensitivity: "restricted" }
      );
    });
    const res = await post(app, {
      statement: "a vendor",
      kind: "entity",
      subtype: "organization",
      subject: "Vault",
    });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("ent_secret");
  });
});

// P135 — the core resolves `scopeRef` against the workspace's project
// entities; the route turns that resolution into `warnings` entries.
describe("P135 — scopeRef resolved against project entities", () => {
  it("warns scope_ref_canonicalized when an alias was stored as the project's name", async () => {
    const { app } = await makeApp(async () => ({
      ...(await ok()),
      scopeRefResolution: {
        canonicalized: { received: "Acme", storedAs: "acme", entityId: "ent_1" },
      },
    }));
    const res = await post(app, { statement: "payroll closes on the 25th", scopeRef: "Acme" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { warnings?: Array<Record<string, unknown>> };
    expect(body.warnings).toEqual([
      expect.objectContaining({
        code: "scope_ref_canonicalized",
        field: "scopeRef",
        received: "Acme",
        storedAs: "acme",
      }),
    ]);
  });

  it("warns scope_ref_unrecognized with the suggestion, after any subtype warning", async () => {
    const { app } = await makeApp(async () => ({
      ...(await ok()),
      scopeRefResolution: {
        suggestion: { received: "acme_hr", project: "acme-hr", entityId: "ent_2" },
      },
    }));
    const res = await post(app, {
      statement: "holidays sync nightly",
      scopeRef: "acme_hr",
      subtype: "deploy",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { warnings?: Array<Record<string, unknown>> };
    expect(body.warnings?.map((w) => w.code)).toEqual([
      "subtype_substituted",
      "scope_ref_unrecognized",
    ]);
    expect(body.warnings?.[1]).toEqual(
      expect.objectContaining({
        field: "scopeRef",
        received: "acme_hr",
        storedAs: "acme_hr",
        suggestion: "acme-hr",
      })
    );
  });

  it("adds no warnings when the scopeRef needed no resolution", async () => {
    const { app } = await makeApp(ok);
    const res = await post(app, { statement: "orchester uses one key", scopeRef: "orchester" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Record<string, unknown>).warnings).toBeUndefined();
  });
});
