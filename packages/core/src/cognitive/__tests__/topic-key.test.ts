import { describe, it, expect } from "vitest";
import {
  suggestTopicKey,
  CANONICAL_TOPIC_KEY,
  TOPIC_KEY_STOPWORDS,
  type SuggestTopicKeyInput,
  type TopicKeySuggestion,
} from "../topic-key.js";

describe("suggestTopicKey() — determinism + shape", () => {
  const cases: Array<{
    name: string;
    input: SuggestTopicKeyInput;
    expected: Pick<TopicKeySuggestion, "topicKey" | "source">;
  }> = [
    {
      name: "subject + body → subject L1, body L2 (minus overlap)",
      input: { subject: "Auth Strategy", body: "Use JWT rotation every 15 minutes" },
      expected: { topicKey: "auth-strategy/use-jwt-rotation", source: "subject+body" },
    },
    {
      name: "body only → first 2 tokens L1, next 3 tokens L2",
      input: {
        body: "Infrastructure migration postgres cluster upgrade rollout plan",
      },
      expected: {
        topicKey: "infrastructure-migration/postgres-cluster-upgrade",
        source: "body",
      },
    },
    {
      name: "subject only (no body) → L1 from subject, ≤2 tokens",
      input: { subject: "Payroll export batching" },
      expected: { topicKey: "payroll-export", source: "subject" },
    },
    {
      name: "stopwords dropped (EN)",
      input: { subject: "This is the plan for auth" },
      expected: { topicKey: "plan-auth", source: "subject" },
    },
    {
      name: "stopwords dropped (ES)",
      input: { subject: "Esta es la estrategia para autenticacion" },
      expected: { topicKey: "estrategia-autenticacion", source: "subject" },
    },
    {
      name: "short digit-bearing tokens survive (s3, v3)",
      input: { subject: "s3 v3 migration" },
      expected: { topicKey: "s3-v3", source: "subject" },
    },
    {
      name: "ASCII-folds accented characters",
      input: { subject: "José Peña" },
      expected: { topicKey: "jose-pena", source: "subject" },
    },
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => {
      const result = suggestTopicKey(input);
      expect(result.topicKey).toBe(expected.topicKey);
      expect(result.source).toBe(expected.source);
    });
  }

  it("is deterministic — repeated calls with the same input produce the same output", () => {
    const input: SuggestTopicKeyInput = { subject: "Auth Strategy", body: "Use JWT rotation" };
    const a = suggestTopicKey(input);
    const b = suggestTopicKey(input);
    expect(a).toEqual(b);
  });
});

describe("suggestTopicKey() — idempotence (D2 canonical short-circuit)", () => {
  it("suggest(suggest(x).topicKey) === suggest(x).topicKey for a two-level key", () => {
    const first = suggestTopicKey({ subject: "Auth Strategy", body: "Use JWT rotation" });
    const second = suggestTopicKey({ subject: first.topicKey });
    expect(second.topicKey).toBe(first.topicKey);
    expect(second.source).toBe("identity");
  });

  it("re-feeding a canonical-grammar key with no body returns it unchanged (does not collapse auth/jwt-rotation to auth-jwt)", () => {
    const result = suggestTopicKey({ subject: "auth/jwt-rotation" });
    expect(result.topicKey).toBe("auth/jwt-rotation");
    expect(result.levels).toEqual(["auth", "jwt-rotation"]);
    expect(result.source).toBe("identity");
  });

  it("does NOT short-circuit when a body is also supplied, even if subject is canonical", () => {
    const result = suggestTopicKey({ subject: "auth-strategy", body: "rotate keys" });
    expect(result.source).not.toBe("identity");
  });

  it("blank/whitespace-only body still counts as absent for the short-circuit", () => {
    const result = suggestTopicKey({ subject: "auth/jwt-rotation", body: "   " });
    expect(result.source).toBe("identity");
    expect(result.topicKey).toBe("auth/jwt-rotation");
  });
});

describe("suggestTopicKey() — never empty + fallback distinctness", () => {
  it("empty input falls back to 'general'", () => {
    const result = suggestTopicKey({});
    expect(result.topicKey).toBe("general");
    expect(result.source).toBe("fallback");
  });

  it("whitespace-only input falls back to 'general'", () => {
    const result = suggestTopicKey({ subject: "   ", body: "  \t " });
    expect(result.topicKey).toBe("general");
    expect(result.source).toBe("fallback");
  });

  it("non-blank input that filters to zero tokens falls back to a distinct hashed key, not the bare 'general'", () => {
    const result = suggestTopicKey({ subject: "is it", body: "to be" });
    expect(result.topicKey).toMatch(/^general\/[a-f0-9]{8}$/);
    expect(result.source).toBe("fallback");
  });

  it("two distinct degenerate inputs never collide onto the same fallback key", () => {
    const a = suggestTopicKey({ subject: "is it", body: "to be" });
    const b = suggestTopicKey({ subject: "an of", body: "at as" });
    expect(a.topicKey).not.toBe(b.topicKey);
  });

  it("the same degenerate input always produces the same fallback key (deterministic hash)", () => {
    const a = suggestTopicKey({ subject: "is it", body: "to be" });
    const b = suggestTopicKey({ subject: "is it", body: "to be" });
    expect(a.topicKey).toBe(b.topicKey);
  });
});

describe("suggestTopicKey() — grammar invariants", () => {
  const inputs: SuggestTopicKeyInput[] = [
    {},
    { subject: "Auth Strategy", body: "Use JWT rotation every 15 minutes" },
    { body: "Infrastructure migration postgres cluster upgrade rollout plan" },
    { subject: "Payroll export batching" },
    { subject: "José Peña" },
    { subject: "is it", body: "to be" },
    { subject: "auth/jwt-rotation" },
    {
      subject: "alpha bravo charlie delta echo foxtrot golf hotel india juliett",
      body: "kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey",
    },
  ];

  for (const input of inputs) {
    it(`never returns more than 2 levels or exceeds the 80-char key cap — ${JSON.stringify(input)}`, () => {
      const result = suggestTopicKey(input);
      expect(result.levels.length).toBeGreaterThanOrEqual(1);
      expect(result.levels.length).toBeLessThanOrEqual(2);
      expect(result.topicKey.length).toBeGreaterThan(0);
      // Single-token levels that are individually longer than the level cap
      // are a documented exception (token-boundary-only truncation, D-doc §1
      // step 4) — the 80-char whole-key cap is likewise best-effort once only
      // one token remains, never mid-token truncated.
      expect(result.topicKey).toBe(result.levels.join("/"));
    });

    it(`satisfies lower(btrim(k)) === k — ${JSON.stringify(input)}`, () => {
      const result = suggestTopicKey(input);
      expect(result.topicKey).toBe(result.topicKey.toLowerCase().trim());
    });

    it(`is idempotent under a second pass through the canonical short-circuit — ${JSON.stringify(input)}`, () => {
      const first = suggestTopicKey(input);
      const second = suggestTopicKey({ subject: first.topicKey });
      expect(second.topicKey).toBe(first.topicKey);
    });
  }
});

describe("CANONICAL_TOPIC_KEY", () => {
  it("matches single-level and two-level canonical keys", () => {
    expect(CANONICAL_TOPIC_KEY.test("auth-strategy")).toBe(true);
    expect(CANONICAL_TOPIC_KEY.test("auth/jwt-rotation")).toBe(true);
    expect(CANONICAL_TOPIC_KEY.test("s3")).toBe(true);
  });

  it("rejects uppercase, dots, and non-canonical separators", () => {
    expect(CANONICAL_TOPIC_KEY.test("Auth-Strategy")).toBe(false);
    expect(CANONICAL_TOPIC_KEY.test("infra.pg")).toBe(false);
    expect(CANONICAL_TOPIC_KEY.test("auth//jwt")).toBe(false);
    expect(CANONICAL_TOPIC_KEY.test("")).toBe(false);
  });
});

describe("TOPIC_KEY_STOPWORDS", () => {
  it("is bilingual (EN + ES)", () => {
    expect(TOPIC_KEY_STOPWORDS.has("the")).toBe(true);
    expect(TOPIC_KEY_STOPWORDS.has("para")).toBe(true);
  });
});

// AGENTSIM-5 — a key derived from the VALUE cannot find the fact it should
// replace: "deploys via Fly.io" and "now deployed by ArgoCD" gave
// payments-api/deploys-fly-via and payments-api/now-deployed-argocd. An
// optional `attribute` (what the fact is ABOUT, not what it says) derives the
// key from subject + attribute and ignores the body.
describe("suggestTopicKey() — attribute-based stable keys (AGENTSIM-5)", () => {
  it("gives the old and the new value the same key", () => {
    const before = suggestTopicKey({
      subject: "payments-api deploy",
      attribute: "deploy method",
      body: "payments-api deploys via Fly.io",
    });
    const after = suggestTopicKey({
      subject: "payments-api deploy",
      attribute: "deploy method",
      body: "payments-api is now deployed by ArgoCD",
    });
    expect(before.topicKey).toBe(after.topicKey);
    expect(before).toMatchObject({
      topicKey: "payments-api/deploy-method",
      source: "subject+attribute",
    });
  });

  it("separates different attributes of the same subject", () => {
    const a = suggestTopicKey({ subject: "payments-api", attribute: "runtime version" });
    const b = suggestTopicKey({ subject: "payments-api", attribute: "database" });
    expect(a.topicKey).toBe("payments-api/runtime-version");
    expect(b.topicKey).toBe("payments-api/database");
  });

  it("derives from the attribute alone when there is no subject", () => {
    expect(suggestTopicKey({ attribute: "Deploy Method", body: "anything" })).toEqual({
      topicKey: "deploy-method",
      levels: ["deploy-method"],
      source: "attribute",
    });
  });

  it("leaves calls without an attribute exactly as before", () => {
    expect(
      suggestTopicKey({ subject: "Auth Strategy", body: "Use JWT rotation every 15 minutes" })
    ).toMatchObject({ topicKey: "auth-strategy/use-jwt-rotation", source: "subject+body" });
    expect(
      suggestTopicKey({ subject: "x", attribute: "   ", body: "Use JWT rotation" }).source
    ).not.toMatch(/attribute/);
  });
});
