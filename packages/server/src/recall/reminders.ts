/**
 * REMIND-1 — prospective-memory evaluation on the recall path.
 *
 * `memory_remind_when` promises "el runtime evalúa ambos [triggerAt y
 * condition] en cada ciclo de recall". This module is where that becomes
 * true: POST /recall is the only path in the system that carries a
 * genuine user query to judge a semantic condition against.
 *
 * Cost discipline (recall is the hot path):
 *   - one extra indexed SELECT per recall (listPendingReminders, workspace-
 *     scoped inside the adapter's own mnemo_set_workspace transaction);
 *   - ZERO embed calls when the workspace has no pending reminders, or when no
 *     pending reminder carries a conditionEmbedding;
 *   - at most ONE embed call otherwise (memoized inside the evaluator);
 *   - never an LLM call — the evaluator's Path 2 is one generate() per pending
 *     reminder, which is not acceptable per-recall latency/cost. Reminders
 *     created while an embedder was configured already carry a
 *     conditionEmbedding (routes/reminders.ts) and use the cheap cosine path;
 *     the rest degrade to FTS keyword matching against the real query text.
 */
import type { ServerDeps } from "../deps.js";

export interface RecallReminderHit {
  id: string;
  content: string;
  condition: string | null;
  triggeredBy: "time" | "semantic" | "both";
}

/**
 * Cosine floor for a reminder's semantic trigger, read from the environment.
 *
 * Coupled to `MNEMO_EMBED_MODEL`: cosine scales are model-specific, so a floor
 * calibrated for one model silently disables the trigger on another (measured
 * numbers live on `ReminderEvalContext.semanticThreshold`). Returns undefined
 * when unset so core keeps its own documented default rather than having this
 * layer restate it.
 */
export function reminderSemanticThreshold(): number | undefined {
  const raw = process.env.MNEMO_REMINDER_SEMANTIC_THRESHOLD;
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  // A malformed value must not read as "0" — that floor matches everything.
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function evaluateRemindersForRecall(
  deps: Pick<ServerDeps, "storage" | "llm" | "embedModel">,
  workspaceId: string,
  queryText: string,
  queryVector?: number[]
): Promise<RecallReminderHit[]> {
  const storage = deps.storage;
  if (!storage) return [];

  const { evaluatePendingReminders } = await import("@mnemo-ai/core");
  const llm = deps.llm;

  const semanticThreshold = reminderSemanticThreshold();

  const fired = await evaluatePendingReminders({
    storage,
    workspaceId,
    queryText,
    ...(semanticThreshold !== undefined ? { semanticThreshold } : {}),
    ...(queryVector ? { queryEmbedding: new Float32Array(queryVector) } : {}),
    ...(llm && !queryVector
      ? {
          embedQuery: async () => {
            const model = deps.embedModel ?? "text-embedding-3-small";
            const v = await llm.embed(queryText, model);
            return new Float32Array(v);
          },
        }
      : {}),
  });

  return deliverFiredReminders(storage, workspaceId, fired);
}

/** Most fired-but-undelivered reminders one recall returns; the rest wait for the next. */
export const RECALL_UNDELIVERED_REMINDER_LIMIT = 10;

/**
 * LIFECYCLE-6 — hand the agent every reminder that has fired and that no recall
 * has returned yet, not only the ones THIS recall fired.
 *
 * The 30-second poller fires due time-only reminders with nobody to show them
 * to (its channels are the event bus and webhooks, which `memory_recall`
 * never sees), and marks them `triggered`; recall evaluated `pending` rows
 * only. So a time reminder reached the agent only if a recall happened to
 * beat the poller to it. Now both paths leave `deliveredAt` null, and the
 * recall that returns a reminder stamps it: each fired reminder is returned
 * once, by the first recall after it fires.
 *
 * Each reminder is claimed atomically by exactly one recall. It is lost only
 * if the HTTP response is lost after the claim — the guarantee a recall-fired
 * reminder always had; if the claim itself fails, this recall returns what it
 * fired and those stay unclaimed, so a later recall may return them again.
 */
async function deliverFiredReminders(
  storage: NonNullable<ServerDeps["storage"]>,
  workspaceId: string,
  fired: RecallReminderHit[]
): Promise<RecallReminderHit[]> {
  if (typeof storage.claimUndeliveredReminders !== "function") return fired;
  let claimed: Awaited<ReturnType<typeof storage.claimUndeliveredReminders>>;
  try {
    // Review round: claim, then answer with what was claimed — not "list,
    // answer, then stamp". Two concurrent recalls (or two that both fired the
    // same pending reminder) used to return the same rows; a claim is atomic,
    // so each reminder goes to exactly one of them.
    claimed = await storage.claimUndeliveredReminders(workspaceId, {
      ids: fired.map((r) => r.id),
      limit: RECALL_UNDELIVERED_REMINDER_LIMIT,
    });
  } catch {
    // What this recall fired is still returned; it stays undelivered and the
    // next recall offers it again.
    return fired;
  }
  const firedById = new Map(fired.map((r) => [r.id, r]));
  return claimed.map((r) => {
    const own = firedById.get(r.id);
    if (own) return own;
    const hasCondition = (r.condition ?? "").trim().length > 0;
    return {
      id: r.id,
      content: r.content,
      condition: r.condition,
      triggeredBy: r.triggerAt && hasCondition ? "both" : r.triggerAt ? "time" : "semantic",
    };
  });
}
