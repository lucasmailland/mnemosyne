/**
 * Self-Reflection Cycle — pure orchestration layer (spec §13).
 * Zero infrastructure imports — all I/O flows through injected ports.
 *
 * The reflection cycle:
 *   1. Queries the last N episodes for the agent.
 *   2. For each episode, reads metadata.strategiesUsed + metadata.outcome.
 *   3. Strengthens strategies from successful episodes, weakens from failed ones.
 *   4. Builds a summary string.
 *   5. Rewrites the agent profile (upsertAgentProfile), resetting sessionsSinceReflection.
 *   6. Logs the reflection as a synthetic episode.
 *   7. Returns {episodeId, strengthened, weakened}.
 */

import type { StorageAdapter } from "@mnemo-ai/types";
import type { Logger, Telemetry } from "@mnemo-ai/types";

// ─── Types ────────────────────────────────────────────────────────────────────

/** How often the reflection cycle fires (in number of session collapses). */
export const REFLECTION_CADENCE = 10;

export interface ReflectionResult {
  episodeId: string;
  strengthened: string[];
  weakened: string[];
}

/** Minimal context shape — subset of CoreContext that self-reflect needs. */
interface ReflectContext {
  storage: StorageAdapter;
  logger: Logger;
  telemetry: Telemetry;
}

/** Minimal auth shape — only workspaceId is needed for storage calls. */
interface AuthLike {
  workspaceId: string;
  scopes: ReadonlyArray<string>;
}

// ─── runReflectionCycle ───────────────────────────────────────────────────────

/**
 * Run the full self-reflection pipeline for an agent.
 *
 * @param ctx       - Minimal context (storage + logger + telemetry)
 * @param auth      - Auth context (workspaceId)
 * @param agentId   - ID of the agent whose memory is being reflected on
 */
export async function runReflectionCycle(
  ctx: ReflectContext,
  auth: AuthLike,
  agentId: string
): Promise<ReflectionResult> {
  const { workspaceId } = auth;
  const span = ctx.telemetry.startSpan("mnemo.self.reflect", {
    attributes: { workspaceId, agentId },
  });

  try {
    // 1. Query recent episodes
    const { items: episodes } = await ctx.storage.queryEpisodes({
      workspaceId,
      limit: REFLECTION_CADENCE,
    });

    // 2. Collect strategy outcomes across episodes
    const successStrategies = new Set<string>();
    const failedStrategies = new Set<string>();

    for (const ep of episodes) {
      const meta = (ep.metadata ?? {}) as Record<string, unknown>;
      const strategiesUsed = (meta.strategiesUsed as string[] | undefined) ?? [];
      const outcome = meta.outcome as string | undefined;

      for (const sid of strategiesUsed) {
        if (outcome === "success") {
          successStrategies.add(sid);
        } else if (outcome === "fail" || outcome === "failure") {
          failedStrategies.add(sid);
        }
      }
    }

    // 3. Strengthen / weaken strategies
    const strengthened = [...successStrategies];
    const weakened = [...failedStrategies];

    await Promise.all([
      ...strengthened.map((sid) =>
        ctx.storage.updateWorth(sid, workspaceId, "strategy", {
          success: 1,
          failure: 0,
          creditWeight: 1,
        })
      ),
      ...weakened.map((sid) =>
        ctx.storage.updateWorth(sid, workspaceId, "strategy", {
          success: 0,
          failure: 1,
          creditWeight: 1,
        })
      ),
    ]);

    // 3b. Step-2 branch extensions (all best-effort — a single failure must not
    //     cascade into the rest of the reflection cycle).
    for (const session of episodes) {
      const sessionMeta = (session.metadata ?? {}) as Record<string, unknown>;

      // Branch: factsContradicted — archive facts marked obsolete by this episode
      const contradicted = (sessionMeta.factsContradicted as string[] | undefined) ?? [];
      if (contradicted.length > 0 && ctx.storage.archiveFact) {
        await Promise.allSettled(
          contradicted.map((id) => ctx.storage.archiveFact!(id, workspaceId))
        );
      }

      // Branch: missingKnowledge — record the knowledge gaps for human triage.
      //
      // P111: this used to append a `flag_missing_knowledge` queue_job. No
      // handler was ever registered for it, and the payload was written flat
      // (`topics` beside `job`, not under `data`), so the outbox worker would
      // have enqueued `{}` even if one had been. The gaps were computed and
      // discarded.
      //
      // Routed to `mnemo_review_item`, the same durable review queue that backs
      // remember()'s §33 contradiction review and the §34.7 self-edit abuse
      // flag. The episode that surfaced the gap is the subject; the topics ride
      // in `detail`. A dedicated salience/gap surface would be a feature — this
      // is the existing mechanism, which makes the signal queryable instead of
      // fire-and-forget.
      const missingTopics = (sessionMeta.missingKnowledge as string[] | undefined) ?? [];
      if (missingTopics.length > 0) {
        try {
          await ctx.storage.enqueueReviewItem({
            workspaceId,
            primitiveId: session.id,
            primitiveKind: "episode",
            reason: "missing_knowledge",
            detail: { topics: missingTopics },
          });
        } catch (err) {
          ctx.logger.warn("mnemo.self.reflect: review enqueue failed (non-fatal)", {
            operation: "self-reflect.review",
            error: { type: "ReviewError", message: String(err) },
          });
        }
      }

      // Branch: create-alternative — propose a replacement strategy for failed episodes
      const sessionOutcome = sessionMeta.outcome as string | undefined;
      const sessionStrategyId = sessionMeta.strategyId as string | undefined;
      const sessionStrategyTrigger = sessionMeta.strategyTrigger as string | undefined;
      if (
        (sessionOutcome === "fail" ||
          sessionOutcome === "failure" ||
          sessionOutcome === "failed") &&
        sessionStrategyId &&
        ctx.storage.createStrategy
      ) {
        try {
          await ctx.storage.createStrategy({
            workspaceId,
            agentId,
            trigger: sessionStrategyTrigger ?? "auto",
            action: `ALTERNATIVE: re-examine approach for trigger '${sessionStrategyTrigger ?? "unknown"}'`,
            context: "auto-proposed by reflection",
          });
        } catch (err) {
          ctx.logger.warn("mnemo.self.reflect: createStrategy failed (non-fatal)", {
            operation: "self-reflect.strategy",
            error: { type: "StrategyError", message: String(err) },
          });
        }
      }
    }

    // 4. Build summary
    const summary = [
      `Self-reflection over ${episodes.length} episode(s).`,
      strengthened.length > 0
        ? `Strengthened ${strengthened.length} strategy(ies): ${strengthened.join(", ")}.`
        : null,
      weakened.length > 0
        ? `Weakened ${weakened.length} strategy(ies): ${weakened.join(", ")}.`
        : null,
    ]
      .filter(Boolean)
      .join(" ");

    // 5. Rewrite agent profile, reset sessionsSinceReflection counter
    await ctx.storage.upsertAgentProfile({
      workspaceId,
      agentId,
      summary,
      metadata: {
        sessionsSinceReflection: 0,
        lastReflectionAt: new Date().toISOString(),
      },
    });

    // 6. Log the reflection as a synthetic episode
    const episode = await ctx.storage.createEpisode({
      workspaceId,
      agentId,
      title: "Self-reflection",
      narrative: summary,
      occurredAt: new Date(),
      isSynthetic: true,
      metadata: {
        reflection: true,
        strengthened,
        weakened,
      },
    });

    ctx.logger.info("mnemo.self.reflect.complete", {
      workspaceId,
      agentId,
      episodeId: episode.id,
      strengthened: strengthened.length,
      weakened: weakened.length,
    });

    return { episodeId: episode.id, strengthened, weakened };
  } finally {
    span.end();
  }
}
