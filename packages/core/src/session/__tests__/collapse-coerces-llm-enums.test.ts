/**
 * P132 — an enum the LLM invented must not abort the collapse.
 *
 * Found driving the P62 credit chain by hand: a session with six turns reached
 * extraction, qwen2.5:0.5b answered `"kind": "deployment"`, and
 * `POST /session/:id/collapse` returned 500 with
 * `new row for relation "mnemo_decision" violates check constraint
 * mnemo_decision_kind_check`.
 *
 * The cost is not one decision. `collapseSession` persists inside a single
 * transaction, so the failed INSERT rolls back EVERYTHING: the extracted facts,
 * the strategies, the episode, and the session's `collapsed_at`. One bad string
 * from a 0.5-billion-parameter model discards the whole session's extraction,
 * and the session stays open so the next collapse attempt hits the same reply.
 *
 * Two things made it possible and only one of them was the missing check:
 *
 *   1. `extracted.kind ?? "decision"` defends against `undefined` and nothing
 *      else. `"deployment"` is not undefined.
 *   2. `ExtractedDecision.kind` was DECLARED as the eight-value union while
 *      being populated by `JSON.parse`. TypeScript asserted a guarantee nobody
 *      had checked, so the missing validation looked like validated code.
 *
 * The prompt does list the eight kinds. A prompt is a request, not a contract.
 */
import { describe, it, expect, vi } from "vitest";
import { collapseSession } from "../collapse.js";
import type { CoreContext } from "../../cognitive/context.js";
import type { AuthContext, CreateDecisionInput } from "@mnemo-ai/types";
import { PRIMITIVE_SUBTYPES } from "@mnemo-ai/types";

const auth = {
  actorId: "system",
  actorType: "system",
  workspaceId: "ws",
  scopes: [],
} as unknown as AuthContext;

const TURNS = Array.from({ length: 6 }, (_, i) => ({
  id: `t${i}`,
  workspaceId: "ws",
  sessionId: "s1",
  turnIndex: i,
  role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
  content: `turno ${i} sobre el despliegue por CI y los secretos en Vault`,
  createdAt: new Date(), // determinism-ok: throwaway fixture, not asserted
  pinned: false,
}));

function harness(summary: Record<string, unknown>) {
  const decisions: CreateDecisionInput[] = [];
  const warn = vi.fn();
  const ctx = {
    config: { surpriseThreshold: 0.0, maxHotTierSize: 1000 },
    logger: {
      debug() {},
      info() {},
      warn,
      error() {},
      child() {
        return this;
      },
    },
    embed: { embed: async (xs: string[]) => xs.map(() => [1, 0, 0]) },
    vector: { search: async () => [] },
    llm: {
      generate: async () => ({
        content: JSON.stringify(summary),
        tokensUsed: { input: 10, output: 10 },
      }),
    },
    cache: null,
    outbox: { append: async () => {} },
    storage: {
      getSession: async () => ({
        id: "s1",
        workspaceId: "ws",
        agentId: "a",
        status: "active" as const,
        turnCount: TURNS.length,
        tokenCount: 120,
        openedAt: new Date(), // determinism-ok: throwaway fixture, not asserted
        metadata: {},
      }),
      listTurns: async () => TURNS,
      createFact: async (i: unknown) => ({ id: "f", ...(i as object) }),
      mergeFactByTopicKey: async () => null,
      createDecision: async (input: CreateDecisionInput) => {
        decisions.push(input);
        return { id: `d${decisions.length}` };
      },
      createStrategy: async () => ({ id: "st" }),
      createRelation: async () => ({ id: "r" }),
      closeSession: async () => {},
      listSessionTopicKeysBySource: async () => [],
    },
  } as unknown as CoreContext;
  return { ctx, decisions, warn };
}

const run = (ctx: CoreContext) =>
  collapseSession(
    { sessionId: "s1", workspaceId: "ws", agentId: "a", reason: "max_turns" },
    ctx,
    auth
  );

function summaryWith(overrides: Record<string, unknown>) {
  return {
    goal: "desplegar el servicio",
    outcome: "resolved",
    facts: [],
    decisions: [],
    strategies: [],
    llmTokensUsed: 10,
    ...overrides,
  };
}

const BAD = {
  title: "Desplegamos por CI",
  body: "GitLab CI, sin pushes manuales",
  kind: "deployment",
};

describe("P132 — an invented decision kind is coerced, not fatal", () => {
  it("survives the exact value that produced the 500", async () => {
    // `"deployment"` is what the model actually returned. Not a hypothetical.
    const { ctx } = harness(summaryWith({ decisions: [BAD] }));
    const result = await run(ctx);
    expect(result.status).toBe("completed");
    expect(result.decisionsCreated).toBe(1);
  });

  it("stores a kind the database will actually accept", async () => {
    const { ctx, decisions } = harness(summaryWith({ decisions: [BAD] }));
    await run(ctx);
    expect(decisions).toHaveLength(1);
    // Membership is the assertion, not the specific fallback: anything outside
    // this list is a 500 waiting for the next session.
    expect(PRIMITIVE_SUBTYPES.decision as readonly string[]).toContain(decisions[0]!.kind);
  });

  it("logs the coercion — a model that invents kinds is worth knowing about", async () => {
    // Coercing in silence would trade a loud failure for an invisible one, and
    // this codebase has spent a week removing exactly that trade.
    const { ctx, warn } = harness(summaryWith({ decisions: [BAD] }));
    await run(ctx);
    const warned = warn.mock.calls.map((c) => JSON.stringify(c)).join(" ");
    expect(warned).toContain("decision_kind_coerced");
    expect(warned).toContain("deployment");
  });

  it("leaves a VALID kind untouched", async () => {
    // The regression that would matter most: coercing everything to "decision"
    // would flatten the taxonomy while every test above still passed.
    const { ctx, decisions } = harness(
      summaryWith({ decisions: [{ title: "t", body: "b", kind: "architecture" }] })
    );
    await run(ctx);
    expect(decisions[0]!.kind).toBe("architecture");
  });

  it("a missing kind still defaults, as it always did", async () => {
    const { ctx, decisions } = harness(summaryWith({ decisions: [{ title: "t", body: "b" }] }));
    await run(ctx);
    expect(decisions[0]!.kind).toBe("decision");
  });
});

describe("P132 — an invented outcome is ignored, not cast", () => {
  it("does not abort the collapse", async () => {
    // Quieter than the kind: `outcome` reached explicitSignal through a cast,
    // so an invented value became a signal nobody defined and the weight lookup
    // silently missed. No crash, just a wrong number.
    const { ctx } = harness(summaryWith({ outcome: "shipped" }));
    const result = await run(ctx);
    expect(result.status).toBe("completed");
  });

  it("says so in the log", async () => {
    const { ctx, warn } = harness(summaryWith({ outcome: "shipped" }));
    await run(ctx);
    const warned = warn.mock.calls.map((c) => JSON.stringify(c)).join(" ");
    expect(warned).toContain("outcome_ignored");
  });

  it("blanks the invented value instead of letting it travel", async () => {
    // The value reaches five downstream readers (the episode narrative, the
    // worth-signal branch, two logs and the persisted summary). Normalising at
    // the parse point is what stops one of them being missed — the first cut of
    // this fix coerced the signal branch and left the persisted summary raw.
    const { ctx, warn } = harness(summaryWith({ outcome: "shipped" }));
    await run(ctx);
    const warned = warn.mock.calls.map((c) => JSON.stringify(c)).join(" ");
    expect(warned).not.toContain("shipped: ");
  });

  it("keeps a VALID outcome intact for the readers downstream", async () => {
    // The other half: blanking everything would silently disable outcome-driven
    // worth propagation while every test above still passed.
    const { ctx, warn } = harness(summaryWith({ outcome: "partial" }));
    await run(ctx);
    const warned = warn.mock.calls.map((c) => JSON.stringify(c)).join(" ");
    expect(warned).not.toContain("outcome_ignored");
  });
});
