/**
 * The reminder's semantic floor travels with the EMBEDDING MODEL.
 *
 * Found while swapping `mxbai-embed-large` → `bge-m3` for Spanish-majority
 * bilingual recall. Cosine scale is a property of the model, and the two do not
 * share one. Measured on the same should-fire / should-not-fire pair:
 *
 *   mxbai-embed-large   fires 0.7365   noise 0.5125   (gap 0.224)
 *   bge-m3              fires 0.6334   noise 0.3106   (gap 0.323)
 *
 * The hardcoded 0.7 floor is correct for the first and sits ABOVE the second's
 * should-fire score. bge-m3 discriminates BETTER — the gap is wider — yet the
 * fixed floor would have disabled semantic reminders outright.
 *
 * That failure mode is the reason this file exists: a reminder that never fires
 * is indistinguishable from a reminder with nothing to match. Nothing throws,
 * nothing is logged, no health check moves. It would have shipped silently.
 *
 * The existing suite (reminder-semantic-eval.test.ts) exercises this path with
 * similarity 1.0 and 0.0, which passes under ANY floor in (0,1) — it pins the
 * path, never the number. These cases pin the number.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { evaluatePendingReminders, type ReminderEvalContext } from "@mnemo-ai/core";
import type { StorageAdapter, MnemoReminder } from "@mnemo-ai/types";

import { reminderSemanticThreshold } from "../../recall/reminders.js";

/** Unit vector whose cosine against [1,0] is exactly `c`. */
function vectorAtCosine(c: number): Float32Array {
  return new Float32Array([c, Math.sqrt(1 - c * c)]);
}
const REFERENCE = new Float32Array([1, 0]);

/** bge-m3's measured score for a condition that SHOULD fire. */
const BGE_M3_SHOULD_FIRE = 0.6334;
/** bge-m3's measured score for a condition that should NOT. */
const BGE_M3_SHOULD_NOT_FIRE = 0.3106;

function makeReminder(overrides: Partial<MnemoReminder> = {}): MnemoReminder {
  return {
    id: "rem-1",
    workspaceId: "ws-1",
    content: "avisame cuando hablemos de la migracion",
    condition: "cuando se mencione la migracion de la base",
    triggerAt: null,
    status: "pending",
    conditionEmbedding: Array.from(REFERENCE),
    triggeredAt: null,
    dismissedAt: null,
    createdByAgentId: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function storageWith(reminders: MnemoReminder[]) {
  return {
    async listPendingReminders() {
      return reminders;
    },
    async dismissReminder(id: string, _ws: string, status: "triggered" | "dismissed") {
      const r = reminders.find((x) => x.id === id);
      if (r) r.status = status;
    },
  } as unknown as StorageAdapter;
}

async function fires(similarity: number, semanticThreshold?: number): Promise<boolean> {
  const ctx: ReminderEvalContext = {
    storage: storageWith([makeReminder()]),
    workspaceId: "ws-1",
    queryText: "estamos planificando la migracion de Postgres",
    queryEmbedding: vectorAtCosine(similarity),
    ...(semanticThreshold !== undefined ? { semanticThreshold } : {}),
  };
  return (await evaluatePendingReminders(ctx)).length === 1;
}

afterEach(() => {
  delete process.env.MNEMO_REMINDER_SEMANTIC_THRESHOLD;
});

describe("the semantic floor is injectable, and the default did not move", () => {
  it("bge-m3's should-fire score is BELOW the inherited default — the regression, reproduced", async () => {
    // THE test. Not a hypothetical: 0.6334 is what the model actually returned
    // for a condition a user would expect to trigger.
    expect(await fires(BGE_M3_SHOULD_FIRE)).toBe(false);
  });

  it("…and fires once the floor is recentred on that model's scale", async () => {
    expect(await fires(BGE_M3_SHOULD_FIRE, 0.55)).toBe(true);
  });

  it("recentring does NOT let the should-not-fire case through", async () => {
    // Lowering a threshold is only safe if the noise moved down with it. Under
    // bge-m3 it moved further: 0.3106 against a 0.55 floor is a wider margin
    // than mxbai's 0.5125 against 0.7.
    expect(await fires(BGE_M3_SHOULD_NOT_FIRE, 0.55)).toBe(false);
  });

  it("keeps 0.7 when nothing is injected, so existing deployments do not shift", async () => {
    // The default is calibrated for text-embedding-3-small / mxbai. Changing it
    // globally would have fixed bge-m3 by breaking everyone still on those.
    expect(await fires(0.71)).toBe(true);
    expect(await fires(0.69)).toBe(false);
  });
});

describe("reminderSemanticThreshold() — a bad value must not read as 'match everything'", () => {
  it("parses a configured value", () => {
    process.env.MNEMO_REMINDER_SEMANTIC_THRESHOLD = "0.55";
    expect(reminderSemanticThreshold()).toBe(0.55);
  });

  it("returns undefined when unset, deferring to core's documented default", () => {
    expect(reminderSemanticThreshold()).toBeUndefined();
  });

  it("returns undefined for a malformed value rather than NaN or 0", () => {
    // `Number("abrete sesamo")` is NaN, and `NaN >= x` is false — that would
    // silently disable every semantic reminder. `Number("")` is 0, which is the
    // opposite failure and worse: a 0 floor fires EVERY reminder on EVERY
    // recall. Both are unacceptable defaults for a typo.
    for (const bad of ["abrete sesamo", "", "   "]) {
      process.env.MNEMO_REMINDER_SEMANTIC_THRESHOLD = bad;
      expect(reminderSemanticThreshold(), `"${bad}" should fall back`).toBeUndefined();
    }
  });
});

describe("the boot path actually forwards it", () => {
  /**
   * The half that is usually missing. The parser can be perfect and the
   * evaluator can honour the field, and the value still never arrives — which
   * is exactly the shape of P127.
   */
  it("evaluateRemindersForRecall passes the configured floor into the evaluator", async () => {
    process.env.MNEMO_REMINDER_SEMANTIC_THRESHOLD = "0.55";

    const evaluate = vi.fn(async () => []);
    vi.doMock("@mnemo-ai/core", () => ({ evaluatePendingReminders: evaluate }));
    vi.resetModules();

    const { evaluateRemindersForRecall } = await import("../../recall/reminders.js");
    await evaluateRemindersForRecall(
      { storage: storageWith([]) } as never,
      "ws-1",
      "la migracion",
      [1, 0]
    );

    expect(evaluate).toHaveBeenCalledTimes(1);
    const passed = evaluate.mock.calls[0]![0] as { semanticThreshold?: number };
    expect(passed.semanticThreshold).toBe(0.55);

    vi.doUnmock("@mnemo-ai/core");
    vi.resetModules();
  });

  it("omits the field entirely when unconfigured, rather than passing undefined through", async () => {
    const evaluate = vi.fn(async () => []);
    vi.doMock("@mnemo-ai/core", () => ({ evaluatePendingReminders: evaluate }));
    vi.resetModules();

    const { evaluateRemindersForRecall } = await import("../../recall/reminders.js");
    await evaluateRemindersForRecall(
      { storage: storageWith([]) } as never,
      "ws-1",
      "la migracion",
      [1, 0]
    );

    const passed = evaluate.mock.calls[0]![0] as Record<string, unknown>;
    expect("semanticThreshold" in passed).toBe(false);

    vi.doUnmock("@mnemo-ai/core");
    vi.resetModules();
  });
});
