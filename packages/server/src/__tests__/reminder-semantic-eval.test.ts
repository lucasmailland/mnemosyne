/**
 * Unit tests for the enhanced semantic condition evaluation in
 * `evaluatePendingReminders`.
 *
 * Tests cover the three semantic matching paths:
 *   1. Vector cosine similarity (conditionEmbedding present + queryEmbedding present)
 *   2. LLM YES/NO judgment (no conditionEmbedding but ctx.llm present)
 *   3. FTS keyword match (neither embedding nor LLM — plain text fallback)
 *
 * No HTTP stack, no DB, no real LLM — all I/O is replaced by in-memory fakes.
 */
import { describe, it, expect, vi } from "vitest";
import {
  evaluatePendingReminders,
  type ReminderEvalContext,
  type ReminderLlmPort,
} from "@mnemo-ai/core";
import type { StorageAdapter, MnemoReminder } from "@mnemo-ai/types";

// ─── Minimal fake StorageAdapter ─────────────────────────────────────────────

function makeStorageStub(
  reminders: MnemoReminder[]
): Pick<StorageAdapter, "listPendingReminders" | "dismissReminder"> {
  const dismissed: Array<{ id: string; status: string }> = [];
  return {
    async listPendingReminders(_workspaceId: string, _asOf: Date) {
      return reminders;
    },
    async dismissReminder(id: string, _workspaceId: string, newStatus: "triggered" | "dismissed") {
      dismissed.push({ id, status: newStatus });
      const reminder = reminders.find((r) => r.id === id);
      if (reminder) reminder.status = newStatus;
    },
    _dismissed: dismissed,
  } as unknown as Pick<StorageAdapter, "listPendingReminders" | "dismissReminder"> & {
    _dismissed: Array<{ id: string; status: string }>;
  };
}

function makeReminder(overrides: Partial<MnemoReminder> = {}): MnemoReminder {
  return {
    id: "rem-1",
    workspaceId: "ws-1",
    content: "Remind the user about the contract",
    condition: "when the user mentions the Acme project or contract Q3",
    triggerAt: null,
    status: "pending",
    conditionEmbedding: null,
    triggeredAt: null,
    dismissedAt: null,
    createdByAgentId: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

// ─── Path 1: vector cosine similarity ────────────────────────────────────────

describe("evaluatePendingReminders — Path 1: vector cosine similarity", () => {
  it("triggers when cosine similarity >= 0.7", async () => {
    // Two identical unit vectors have similarity 1.0.
    const vec = new Float32Array([1, 0, 0, 0]);
    const reminder = makeReminder({
      conditionEmbedding: Array.from(vec),
    });
    const storage = makeStorageStub([reminder]);

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "tell me about the Acme project",
      queryEmbedding: vec,
    };

    const result = await evaluatePendingReminders(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]!.triggeredBy).toBe("semantic");
  });

  it("does NOT trigger when cosine similarity < 0.7", async () => {
    // Orthogonal vectors → similarity = 0.
    const condVec = new Float32Array([1, 0, 0, 0]);
    const queryVec = new Float32Array([0, 1, 0, 0]);
    const reminder = makeReminder({
      conditionEmbedding: Array.from(condVec),
    });
    const storage = makeStorageStub([reminder]);

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "something completely different",
      queryEmbedding: queryVec,
    };

    const result = await evaluatePendingReminders(ctx);
    expect(result).toHaveLength(0);
  });
});

// ─── Path 2: LLM YES/NO judgment ─────────────────────────────────────────────

describe("evaluatePendingReminders — Path 2: LLM YES/NO judgment", () => {
  it("triggers when LLM returns YES", async () => {
    const reminder = makeReminder(); // conditionEmbedding = null
    const storage = makeStorageStub([reminder]);

    const llm: ReminderLlmPort = {
      generate: vi.fn().mockResolvedValue({ content: "YES" }),
    };

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "let us review the Acme contract Q3",
      llm,
    };

    const result = await evaluatePendingReminders(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]!.triggeredBy).toBe("semantic");
    expect(llm.generate).toHaveBeenCalledOnce();
  });

  it("does NOT trigger when LLM returns NO", async () => {
    const reminder = makeReminder();
    const storage = makeStorageStub([reminder]);

    const llm: ReminderLlmPort = {
      generate: vi.fn().mockResolvedValue({ content: "NO" }),
    };

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "unrelated topic about weather",
      llm,
    };

    const result = await evaluatePendingReminders(ctx);
    expect(result).toHaveLength(0);
  });

  it("fails closed when LLM throws — no spurious trigger", async () => {
    const reminder = makeReminder();
    const storage = makeStorageStub([reminder]);

    const llm: ReminderLlmPort = {
      generate: vi.fn().mockRejectedValue(new Error("LLM timeout")),
    };

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "Acme contract Q3 review",
      llm,
    };

    const result = await evaluatePendingReminders(ctx);
    expect(result).toHaveLength(0);
  });

  it("accepts YES with trailing whitespace or lowercase", async () => {
    const reminder = makeReminder();
    const storage = makeStorageStub([reminder]);

    const llm: ReminderLlmPort = {
      generate: vi.fn().mockResolvedValue({ content: "  yes\n" }),
    };

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "Acme Q3 contract",
      llm,
    };

    const result = await evaluatePendingReminders(ctx);
    expect(result).toHaveLength(1);
  });

  it("LLM prompt includes both condition and context", async () => {
    const reminder = makeReminder({
      condition: "when user asks about pricing",
    });
    const storage = makeStorageStub([reminder]);

    let capturedPrompt = "";
    const llm: ReminderLlmPort = {
      generate: vi.fn().mockImplementation(async (input) => {
        capturedPrompt = input.messages[0]?.content ?? "";
        return { content: "YES" };
      }),
    };

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "What are the pricing tiers?",
      llm,
    };

    await evaluatePendingReminders(ctx);
    expect(capturedPrompt).toContain("when user asks about pricing");
    expect(capturedPrompt).toContain("What are the pricing tiers?");
  });

  it("prefers vector cosine over LLM when conditionEmbedding is present", async () => {
    // Even if queryEmbedding similarity is below threshold (would NOT trigger),
    // having conditionEmbedding present means LLM path must NOT be used.
    const condVec = new Float32Array([1, 0]);
    const queryVec = new Float32Array([0, 1]); // orthogonal → sim = 0
    const reminder = makeReminder({
      conditionEmbedding: Array.from(condVec),
    });
    const storage = makeStorageStub([reminder]);

    const llm: ReminderLlmPort = {
      generate: vi.fn().mockResolvedValue({ content: "YES" }),
    };

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "whatever",
      queryEmbedding: queryVec,
      llm,
    };

    const result = await evaluatePendingReminders(ctx);
    // Cosine = 0 → no semantic match; LLM was NOT called.
    expect(result).toHaveLength(0);
    expect(llm.generate).not.toHaveBeenCalled();
  });
});

// ─── Path 3: FTS keyword fallback ────────────────────────────────────────────

describe("evaluatePendingReminders — Path 3: FTS keyword fallback", () => {
  it("triggers when condition keyword appears in context", async () => {
    const reminder = makeReminder({
      condition: "when user mentions Acme",
    });
    const storage = makeStorageStub([reminder]);

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "Tell me about Acme and their roadmap",
      // No queryEmbedding, no llm → FTS fallback
    };

    const result = await evaluatePendingReminders(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]!.triggeredBy).toBe("semantic");
  });

  it("does NOT trigger when no condition keyword appears in context", async () => {
    const reminder = makeReminder({
      condition: "when user mentions Acme contract",
    });
    const storage = makeStorageStub([reminder]);

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "Tell me about the weather forecast",
    };

    const result = await evaluatePendingReminders(ctx);
    expect(result).toHaveLength(0);
  });

  it("is case-insensitive", async () => {
    const reminder = makeReminder({ condition: "ACME PROJECT" });
    const storage = makeStorageStub([reminder]);

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "what about acme project timeline",
    };

    const result = await evaluatePendingReminders(ctx);
    expect(result).toHaveLength(1);
  });
});

// ─── Time + semantic: AND combination (spec.md Requirement 1) ───────────────
//
// `condition` is mandatory on every reminder, so a reminder either has
// triggerAt+condition (AND — both must hold) or condition-only (semantic
// alone suffices). "time alone fires a reminder that also carries a
// semantic condition" is the bug this section used to bless — see the
// removed "marks triggeredBy=time when only time trigger fires" case below,
// which asserted the OR behavior as correct. It wasn't: a reminder created
// with both a future triggerAt and a real condition must not fire the
// instant the clock hits with a completely unrelated (or absent) query
// context.

describe("evaluatePendingReminders — combined time + semantic trigger (AND)", () => {
  it("fires (triggeredBy=both) when time AND semantic both match", async () => {
    const past = new Date(Date.now() - 1000); // determinism-ok: relative past instant, exact value irrelevant
    const reminder = makeReminder({ triggerAt: past }); // conditionEmbedding = null

    const storage = makeStorageStub([reminder]);
    const llm: ReminderLlmPort = {
      generate: vi.fn().mockResolvedValue({ content: "YES" }),
    };

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "Acme Q3 contract review",
      llm,
    };

    const result = await evaluatePendingReminders(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]!.triggeredBy).toBe("both");
  });

  it("does NOT fire when time has passed but the semantic condition does not match (AND, not OR)", async () => {
    const past = new Date(Date.now() - 1000); // determinism-ok: relative past instant, exact value irrelevant
    const reminder = makeReminder({ triggerAt: past }); // condition: "...Acme project or contract Q3"
    const storage = makeStorageStub([reminder]);

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "what's the weather like today", // unrelated — FTS keyword fallback finds no match
    };

    const result = await evaluatePendingReminders(ctx);
    expect(result).toHaveLength(0);
  });

  it("does NOT fire on time alone with empty queryText (no semantic signal available)", async () => {
    const past = new Date(Date.now() - 1000); // determinism-ok: relative past instant, exact value irrelevant
    const reminder = makeReminder({ triggerAt: past });
    const storage = makeStorageStub([reminder]);

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "", // empty → FTS skip, LLM skip → semanticMatch stays false
    };

    const result = await evaluatePendingReminders(ctx);
    expect(result).toHaveLength(0);
  });

  it("does NOT fire when semantic matches but time has not yet passed", async () => {
    const future = new Date(Date.now() + 60_000); // determinism-ok: relative future instant, exact value irrelevant
    const reminder = makeReminder({ triggerAt: future, condition: "when user mentions Acme" });
    const storage = makeStorageStub([reminder]);

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "let's talk about Acme now", // semantic WOULD match via FTS
    };

    const result = await evaluatePendingReminders(ctx);
    expect(result).toHaveLength(0);
  });

  it("condition-only reminder (no triggerAt) still fires on semantic match alone", async () => {
    const reminder = makeReminder({ triggerAt: null, condition: "when user mentions Acme" });
    const storage = makeStorageStub([reminder]);

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "quick note about Acme's roadmap",
    };

    const result = await evaluatePendingReminders(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]!.triggeredBy).toBe("semantic");
  });
});

// ─── No pending reminders ─────────────────────────────────────────────────────

describe("evaluatePendingReminders — no pending reminders", () => {
  it("returns empty array immediately", async () => {
    const storage = makeStorageStub([]);
    const llm: ReminderLlmPort = {
      generate: vi.fn(),
    };

    const ctx: ReminderEvalContext = {
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "anything",
      llm,
    };

    const result = await evaluatePendingReminders(ctx);
    expect(result).toHaveLength(0);
    expect(llm.generate).not.toHaveBeenCalled();
  });
});

// ─── REMIND-1: lazy query embedding (recall path) ────────────────────────────

describe("evaluatePendingReminders — lazy embedQuery hook", () => {
  it("calls embedQuery at most once, only when a pending reminder has a conditionEmbedding", async () => {
    const vec = new Float32Array([1, 0, 0, 0]);
    const reminders = [
      makeReminder({ id: "rem-a", conditionEmbedding: Array.from(vec) }),
      makeReminder({ id: "rem-b", conditionEmbedding: Array.from(vec) }),
    ];
    const storage = makeStorageStub(reminders);
    const embedQuery = vi.fn().mockResolvedValue(vec);

    const result = await evaluatePendingReminders({
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "tell me about the Acme project",
      embedQuery,
    });

    expect(embedQuery).toHaveBeenCalledTimes(1); // memoized across both reminders
    expect(result).toHaveLength(2);
  });

  it("never calls embedQuery when no pending reminder carries a conditionEmbedding", async () => {
    const storage = makeStorageStub([makeReminder({ condition: "when user mentions Acme" })]);
    const embedQuery = vi.fn();

    await evaluatePendingReminders({
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "what about Acme",
      embedQuery,
    });

    expect(embedQuery).not.toHaveBeenCalled(); // zero embed cost on the hot path
  });

  it("degrades to FTS (does NOT fabricate a match) when embedQuery resolves undefined", async () => {
    const storage = makeStorageStub([
      makeReminder({ condition: "when user mentions Acme", conditionEmbedding: [1, 0, 0, 0] }),
    ]);
    const result = await evaluatePendingReminders({
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "the weather forecast for tomorrow", // no keyword overlap
      embedQuery: async () => undefined,
    });
    expect(result).toHaveLength(0);
  });

  it("degrades to FTS and DOES match when the real query text overlaps the condition", async () => {
    const storage = makeStorageStub([
      makeReminder({ condition: "when user mentions Acme", conditionEmbedding: [1, 0, 0, 0] }),
    ]);
    const result = await evaluatePendingReminders({
      storage: storage as unknown as StorageAdapter,
      workspaceId: "ws-1",
      queryText: "give me the Acme roadmap",
      embedQuery: async () => undefined,
    });
    expect(result).toHaveLength(1);
  });
});
