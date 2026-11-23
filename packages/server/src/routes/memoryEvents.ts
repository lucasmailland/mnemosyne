/**
 * §35 REST catch-up endpoint — GET /memory/events?since=<eventId>&channel=<channel>
 *
 * Allows reconnecting WS clients that missed events to catch up via REST
 * before re-establishing a WS connection. Returns either:
 *   - { type: "replay", events: StampedEvent[], gapDetected: false } — events after `since`
 *   - { type: "gap", oldestAvailable: string | null, message: string } — cursor not in buffer
 *   - 204 No Content — replay buffer disabled (no Redis)
 *
 * Auth: standard bearer token, `memory:subscribe` scope (same as WS).
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { ServerDeps } from "../deps.js";
import type { AuthVariables } from "../auth.js";

const MemoryEventsQuerySchema = z.object({
  since: z
    .string()
    .min(1)
    .openapi({
      param: { name: "since", in: "query" },
      description:
        "Monotonic event ID to resume from (exclusive). Format: evt_{wsShort}_{ms}_{seq}.",
    }),
  channel: z
    .string()
    .default("*")
    .openapi({
      param: { name: "channel", in: "query" },
      description: "Channel to catch up on. Defaults to '*' (all).",
    }),
});

const StampedEventSchema = z
  .object({
    id: z.string(),
    channel: z.string(),
    type: z.string(),
    payload: z.unknown(),
    timestamp: z.string(),
    traceId: z.string(),
  })
  .openapi("StampedEvent");

const ReplayResponseSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("replay"),
      events: z.array(StampedEventSchema),
      gapDetected: z.literal(false),
    }),
    z.object({
      type: z.literal("gap"),
      oldestAvailable: z.string().nullable(),
      message: z.string(),
    }),
  ])
  .openapi("MemoryEventsReplay");

export function mountMemoryEvents(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/memory/events",
      tags: ["replay"],
      summary: "REST catch-up for missed WS events (§35).",
      request: { query: MemoryEventsQuerySchema },
      responses: {
        200: {
          description: "Replay or gap response.",
          content: { "application/json": { schema: ReplayResponseSchema } },
        },
        204: { description: "Replay buffer not available (no Redis)." },
        401: { description: "Missing or invalid bearer token." },
      },
    }),
    async (c) => {
      if (!deps.replay) {
        // No replay buffer — return 204 so clients know to do a full re-sync.
        return c.body(null, 204);
      }
      const { since, channel } = c.req.valid("query");
      const workspaceId = c.get("workspaceId");
      const result = await deps.replay.catchUp(workspaceId, channel, since);
      return c.json(result, 200);
    }
  );
}
