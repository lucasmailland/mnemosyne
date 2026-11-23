/**
 * P121 — `POST /remember`'s 201 body reports the STORED statement.
 *
 * `routes/remember.ts` does not spread the core's result: it hand-builds a
 * whitelist literal, which is the same structural trap
 * `remember-conflict-response.test.ts` guards. Here the trap had already
 * closed on someone. The literal said `statement: effectiveStatement` — the
 * REQUEST's text — so the response echoed the caller's input while the row
 * held the PII-redacted version. The write looked confirmed, and what came
 * back from a later recall was a different string.
 *
 * Stubbed at `deps.cognitive.remember` on purpose: whether the redaction is
 * CORRECT is core's business and is proven in
 * `core/src/cognitive/__tests__/remember-reports-what-it-stored.test.ts`
 * against the real gate. What this file proves is narrower and was the actual
 * defect — that whatever core says it stored is what the caller is told.
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountRemember } from "../routes/remember.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_storedstatementtest001";
const WS_ID = "00000000-0000-0000-0000-000000000021";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: "key021", keyHash, workspaceId: WS_ID, scopes: ["memory:write"], plan: "free" },
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

async function post(coreResult: Record<string, unknown>, statement: string) {
  const deps = {
    apiKeys: await makeKeyLookup(),
    cognitive: { remember: async () => coreResult },
  } as unknown as ServerDeps;

  const app = buildMountHarness(deps, [mountRemember]);
  const res = await app.request("/remember", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ statement }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /remember — P122: the five fabricated fields now report the row", () => {
  const ROW = {
    validFrom: "2026-03-01T10:00:00.000Z",
    validTo: null,
    createdAt: "2026-03-01T10:00:00.000Z",
    pinned: true,
    confidence: 0.42,
    sensitivity: "confidential",
  };

  it("reports the row's timestamps, pinned, confidence and sensitivity", async () => {
    // Every value here is deliberately DIFFERENT from what the route used to
    // invent: a timestamp in the past (the route used a clock read at response
    // time), pinned true (hardcoded false), a real confidence (hardcoded null)
    // and a non-default sensitivity (hardcoded DEFAULT_SENSITIVITY). If any
    // still comes back as the old constant, this fails naming which.
    const { status, body } = await post(
      { id: "fact_1", kind: "fact", staged: false, storedContent: "x", stored: ROW },
      "x"
    );

    expect(status).toBe(201);
    expect(body.validFrom).toBe(ROW.validFrom);
    expect(body.createdAt).toBe(ROW.createdAt);
    expect(body.pinned).toBe(true);
    expect(body.confidence).toBe(0.42);
    expect(body.sensitivity).toBe("confidential");
  });

  it("reports a CLOSED interval when the row has one", async () => {
    const { body } = await post(
      {
        id: "fact_1",
        kind: "fact",
        staged: false,
        storedContent: "x",
        stored: { ...ROW, validTo: "2026-06-01T00:00:00.000Z" },
      },
      "x"
    );

    expect(body.validTo).toBe("2026-06-01T00:00:00.000Z");
  });

  it("falls back to the old defaults when there is no row to report", async () => {
    // The non-fact kinds produce no fact row, so `stored` is absent. Absent
    // must mean "not known", never "empty" — reporting zeros here would be a
    // new lie in place of the old one.
    const { status, body } = await post(
      { id: "dec_1", kind: "decision", staged: false, storedContent: "x" },
      "x"
    );

    expect(status).toBe(201);
    expect(body.pinned).toBe(false);
    expect(body.confidence).toBeNull();
    expect(typeof body.validFrom).toBe("string");
    expect(body.validTo).toBeNull();
  });
});

describe("POST /remember — P121: the response reports what was stored", () => {
  it("returns the redacted statement, not the one that was sent", async () => {
    const { status, body } = await post(
      {
        id: "fact_1",
        kind: "fact",
        staged: false,
        storedContent: "llamame al [REDACTED-phone]",
        redactedCategories: ["phone"],
      },
      "llamame al +54 911 2345 6789"
    );

    expect(status).toBe(201);
    expect(body.statement).toBe("llamame al [REDACTED-phone]");
    // The exact assertion the old behaviour failed: the caller's text must not
    // come back as confirmation of something that was never written.
    expect(body.statement).not.toContain("2345");
  });

  it("surfaces which categories were redacted", async () => {
    const { body } = await post(
      {
        id: "fact_1",
        kind: "fact",
        staged: false,
        storedContent: "[REDACTED-email] y [REDACTED-phone]",
        redactedCategories: ["email", "phone"],
      },
      "ana@example.com y 415-555-0132"
    );

    expect(body.redactedCategories).toEqual(["email", "phone"]);
  });

  it("omits redactedCategories entirely when nothing was redacted", async () => {
    // Presence is the signal, so an empty array must not appear either — a
    // caller checking `if (body.redactedCategories)` would branch on `[]`
    // being truthy and report a redaction that never happened.
    const { body } = await post(
      { id: "fact_1", kind: "fact", staged: false, storedContent: "sin pii aca" },
      "sin pii aca"
    );

    expect("redactedCategories" in body).toBe(false);
    expect(body.statement).toBe("sin pii aca");
  });

  it("treats an empty categories array from core as 'nothing redacted'", async () => {
    const { body } = await post(
      {
        id: "fact_1",
        kind: "fact",
        staged: false,
        storedContent: "sin pii aca",
        redactedCategories: [],
      },
      "sin pii aca"
    );

    expect("redactedCategories" in body).toBe(false);
  });

  it("falls back to the request text against a core too old to send storedContent", async () => {
    // Wire-compat, and deliberately NOT silent-by-omission: an older core
    // sends no `storedContent`, and answering with `undefined` there would
    // break the response schema outright rather than degrade.
    const { status, body } = await post(
      { id: "fact_1", kind: "fact", staged: false },
      "texto del llamador"
    );

    expect(status).toBe(201);
    expect(body.statement).toBe("texto del llamador");
  });
});
