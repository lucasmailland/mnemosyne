/**
 * WebSocket subscription handler — spec §4 /memory/ws
 *
 * Protocol:
 *   Client → ws.send(JSON.stringify({ subscribe: { channel, filter? } }))
 *   Client → ws.send(JSON.stringify({ unsubscribe: { channel } }))
 *   Server → ws.send(JSON.stringify(MnemoBusEvent)) on matching events
 *
 * Auth:
 *   ?token=mns_live_... query-param — verified on upgrade via verifyApiKeyToken.
 *   Missing or invalid token → close 1008 (Policy Violation).
 *
 * Workspace isolation:
 *   Only events whose payload.workspaceId matches the token's workspaceId
 *   are forwarded to a client — even if the channel pattern would match.
 */

import { WrongRegionError, assertWorkspaceRegion } from "./middleware/region.js";
import type { Context, Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext, WSEvents } from "hono/ws";
import type { EventBus } from "@mnemo-ai/core";
import { channelMatches } from "@mnemo-ai/core";
import type { MnemoBusEvent, MnemoEventFilter, Sensitivity, WsSubscription } from "@mnemo-ai/types";
import { SENSITIVITY_ORDER } from "@mnemo-ai/types";
import { effectiveCeiling, resolveDefaultCeiling } from "./rbac.js";
import type { ApiKeyLookup } from "./auth.js";
import { verifyApiKeyToken } from "./auth.js";
import { keyUserAllowed } from "./auth-evaluate.js";
import type { UserStatusService } from "./user-status.js";
import { logger } from "./logging.js";
import { WsSubscriber } from "./resilience/wsRingBuffer.js";
import type { WsControlFrame } from "./resilience/wsRingBuffer.js";
import type { ReplayBuffer } from "./resilience/replayBuffer.js";

// ─── Subscription record per-connection ───────────────────────────────────────

export interface WsSubscriptionRecord {
  channel: string;
  workspaceId: string;
  filter?: MnemoEventFilter;
  /** The subscribing key's read ceiling (APP-006). Omitted: the process default. */
  ceiling?: Sensitivity;
}

/** A tier the subscriber may read; an unknown tier is treated as the most restrictive. */
function readable(ceiling: Sensitivity, tier: unknown): boolean {
  const rank =
    typeof tier === "string" && tier in SENSITIVITY_ORDER
      ? SENSITIVITY_ORDER[tier as Sensitivity]
      : SENSITIVITY_ORDER.restricted + 1;
  return rank <= SENSITIVITY_ORDER[ceiling];
}

/**
 * APP-006 — the event as this subscriber may see it, or null. Same rule as the
 * HTTP reads: nothing above the subscribing key's ceiling, and nothing from
 * another workspace. An event that names no workspace is not delivered at all
 * (it used to reach every workspace's subscribers). Recall hits above the
 * ceiling are removed from a copy; the bus event itself is never mutated.
 */
export function visibleEventFor(
  sub: WsSubscriptionRecord,
  event: MnemoBusEvent
): MnemoBusEvent | null {
  if (!matchesSubscription(sub, event)) return null;
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object") return null;
  if (payload["workspaceId"] !== sub.workspaceId) return null;
  const ceiling = sub.ceiling ?? resolveDefaultCeiling(process.env["MNEMO_SENSITIVITY_CEILING"]);
  if ("sensitivity" in payload && !readable(ceiling, payload["sensitivity"])) return null;
  const hits = payload["hits"];
  if (Array.isArray(hits)) {
    const kept = hits.filter((h) => {
      // A hit always carries its tier; one without is not sent.
      if (!h || typeof h !== "object") return false;
      return readable(ceiling, (h as { sensitivity?: unknown }).sensitivity);
    });
    if (kept.length !== hits.length) {
      return { ...event, payload: { ...payload, hits: kept } } as MnemoBusEvent;
    }
  }
  return event;
}

/**
 * APP-024 — the key that opens a socket. Browsers and the SDK cannot set a
 * header on an upgrade, so `?token=` is the normal way; a client that can may
 * send the Authorization header instead. Both at once must be the same key, so
 * the scopes the HTTP middleware checked and the identity this handler uses
 * cannot belong to different keys.
 */
export function wsTokenOf(c: {
  req: { query(name: string): string | undefined; header?(name: string): string | undefined };
}): string | null {
  const query = c.req.query("token")?.trim() || undefined;
  const header = c.req.header?.("authorization") ?? c.req.header?.("Authorization");
  const bearer =
    header && header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() || undefined : undefined;
  if (query && bearer && query !== bearer) return null;
  return query ?? bearer ?? null;
}

/**
 * Exported for unit testing (ws-glob.test.ts).
 *
 * Returns true when a bus event should be sent to a subscriber given:
 *  1. Channel glob/exact match
 *  2. Optional payload filters (entityId, agentId, memoryType)
 *  3. Workspace isolation (payload.workspaceId must equal subscriber's workspaceId)
 */
export function matchesSubscription(sub: WsSubscriptionRecord, event: MnemoBusEvent): boolean {
  // 1. Channel match
  if (!channelMatches(sub.channel, event.channel)) return false;

  // 2. Workspace isolation
  const payload = event.payload as Record<string, unknown> | null;
  if (sub.workspaceId && payload && typeof payload === "object") {
    const wsId = payload["workspaceId"];
    if (wsId !== undefined && wsId !== sub.workspaceId) return false;
  }

  // 3. Optional filters
  if (sub.filter && payload && typeof payload === "object") {
    const { entityId, agentId, memoryType } = sub.filter;
    if (entityId !== undefined && payload["id"] !== entityId) return false;
    if (agentId !== undefined && payload["agentId"] !== agentId) return false;
    if (memoryType !== undefined && payload["memoryType"] !== memoryType) return false;
  }

  return true;
}

// ─── WS Handler factory ────────────────────────────────────────────────────────

export interface WsHandlerDeps {
  bus?: EventBus;
  apiKeys: ApiKeyLookup;
  /** §35 data residency: the workspace region, as the HTTP region lock reads it. */
  lookupRegion?: import("./middleware/region.js").WorkspaceRegionLookup;
  /** Live user status: keys of a disabled user do not open a socket. */
  userStatus?: Pick<UserStatusService, "get">;
  /** §35 replay buffer for reconnection catch-up. Optional: missing → gap. */
  replay?: ReplayBuffer;
}

export interface WsHandler {
  /** Mount GET /memory/ws on the given Hono app. */
  mount(app: Hono): void;
  /** Call with the http.Server returned by serve() to enable upgrades. */
  injectWebSocket: (server: import("node:http").Server) => void;
}

/**
 * Authenticate the ?token= of an upgrade. A WebSocket cannot answer 401, so a
 * refusal is a close code: 1008 (policy violation) for a missing, invalid or
 * disabled-user key, 1011 (internal error) when the user status is unreadable
 * (fail closed).
 */
export async function authenticateWsToken(
  deps: Pick<WsHandlerDeps, "apiKeys" | "userStatus" | "lookupRegion">,
  token: string
): Promise<
  | { ok: true; workspaceId: string; ceiling: Sensitivity }
  | { ok: false; code: 1008 | 1011; reason: string }
> {
  const authResult = token ? await verifyApiKeyToken(deps.apiKeys, token) : null;
  if (!authResult)
    return { ok: false, code: 1008, reason: "Unauthorized: missing or invalid token" };
  let allowed;
  try {
    allowed = await keyUserAllowed(deps.userStatus, authResult.userId);
  } catch {
    return { ok: false, code: 1011, reason: "Authentication service unavailable" };
  }
  if (!allowed) return { ok: false, code: 1008, reason: "Unauthorized: missing or invalid token" };
  try {
    await assertWorkspaceRegion(authResult.workspaceId, deps.lookupRegion);
  } catch (err) {
    return err instanceof WrongRegionError
      ? { ok: false, code: 1008, reason: "Forbidden: workspace is locked to another region" }
      : { ok: false, code: 1011, reason: "Region lookup failed" };
  }
  return {
    ok: true,
    workspaceId: authResult.workspaceId,
    ceiling: effectiveCeiling(
      resolveDefaultCeiling(process.env["MNEMO_SENSITIVITY_CEILING"]),
      (authResult.maxSensitivity ?? undefined) as Sensitivity | undefined
    ),
  };
}

export function createWsHandler(app: Hono, deps: WsHandlerDeps): WsHandler {
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  // upgradeWebSocket(createEvents) creates a Hono middleware for WS connections.
  // The createEvents factory is called once per upgrade, before the ws socket opens.
  // All auth and state must be captured via closure from the Context.
  const wsMiddleware = upgradeWebSocket(async (c: Context): Promise<WSEvents> => {
    // ?token= (what browsers and the SDK can send) or the Authorization header;
    // two different keys at once are refused (APP-024).
    const token = wsTokenOf(c) ?? "";

    // Verify before upgrade completes
    const authResult = await authenticateWsToken(deps, token);

    if (!authResult.ok) {
      // We can't send 401 on a WS upgrade — close with a policy/internal code.
      const { code, reason } = authResult;
      return {
        onOpen(_evt: Event, ws: WSContext) {
          ws.close(code, reason);
        },
      };
    }

    const { workspaceId, ceiling } = authResult;
    const subscriptions = new Map<string, WsSubscriptionRecord>();
    let busUnsub: (() => void) | null = null;
    let subscriber: WsSubscriber | undefined;
    let disconnectCheck: ReturnType<typeof setInterval> | undefined;

    return {
      onOpen(_evt: Event, ws: WSContext) {
        if (!deps.bus) return;

        // §34.10 per-connection ring buffer (max 100, drop_oldest, slow@50%)
        subscriber = new WsSubscriber(`${workspaceId}:${Date.now()}`, ws as never);
        disconnectCheck = setInterval(() => {
          if (subscriber?.shouldDisconnect(Date.now())) {
            (ws as unknown as { close?: (code?: number, reason?: string) => void }).close?.(
              1013,
              "slow consumer"
            );
          }
        }, 30_000);

        // Subscribe to ALL bus events; filter per-subscription in the handler.
        busUnsub = deps.bus.subscribe("*", (event: MnemoBusEvent) => {
          for (const sub of subscriptions.values()) {
            const visible = visibleEventFor(sub, event);
            if (visible) {
              try {
                subscriber?.push(visible);
              } catch (err) {
                logger.debug({ err }, "ws.send_error");
              }
            }
          }
        });

        logger.debug({ workspaceId }, "ws.client_connected");
      },

      onMessage(evt: MessageEvent, ws: WSContext) {
        const raw = evt.data;
        const text = typeof raw === "string" ? raw : String(raw);
        let msg: WsSubscription;
        try {
          msg = JSON.parse(text) as WsSubscription;
        } catch {
          return; // ignore malformed frames
        }

        if (msg.subscribe) {
          const { channel, filter } = msg.subscribe;
          subscriptions.set(channel, { channel, workspaceId, ceiling, ...(filter ? { filter } : {}) });
          logger.debug({ workspaceId, channel }, "ws.subscribed");
        }

        if (msg.unsubscribe) {
          subscriptions.delete(msg.unsubscribe.channel);
          logger.debug({ workspaceId, channel: msg.unsubscribe.channel }, "ws.unsubscribed");
        }

        // §35 Resubscribe with catch-up: client sends { resubscribe: { channels, lastEventId } }
        // after a reconnect. One catch-up covers every channel (exact, wildcard or alias), so
        // an event that matches several overlapping patterns is replayed once, in order.
        // Otherwise a gap frame per channel lets the client fall back to the REST API.
        if (msg.resubscribe) {
          const { channels, lastEventId } = msg.resubscribe;
          const resubs = channels.map((channel) => {
            const sub: WsSubscriptionRecord = { channel, workspaceId, ceiling };
            subscriptions.set(channel, sub);
            return sub;
          });

          if (deps.replay) {
            deps.replay
              .catchUp(workspaceId, channels, lastEventId)
              .then((result) => {
                if (result.type === "replay") {
                  // Same gate as live delivery (workspace isolation included).
                  const events = result.events.flatMap((e) => {
                    for (const sub of resubs) {
                      const visible = visibleEventFor(sub, e);
                      if (visible) return [visible];
                    }
                    return [];
                  });
                  for (const event of events) subscriber?.push(event);
                  logger.debug({ workspaceId, channels, count: events.length }, "ws.replay_ok");
                } else {
                  // Gap: enqueue a synthetic gap frame through the subscriber buffer so
                  // it is delivered in order relative to any already-buffered live events.
                  // Do NOT use ws.send() directly here — that would bypass the ring buffer
                  // and could deliver the gap frame ahead of buffered live events.
                  for (const channel of channels) {
                    const gapCtrlFrame: WsControlFrame = {
                      type: "ws.gap",
                      channel,
                      oldestAvailable: result.oldestAvailable,
                      message: result.message,
                    };
                    try {
                      subscriber?.push(gapCtrlFrame);
                    } catch {
                      /* ignore push errors on gap */
                    }
                  }
                  logger.debug(
                    { workspaceId, channels, oldest: result.oldestAvailable },
                    "ws.replay_gap"
                  );
                }
              })
              .catch((err) => {
                logger.warn({ err, workspaceId, channels }, "ws.replay_error");
              });
          } else {
            logger.debug({ workspaceId, channels }, "ws.replay_disabled");
          }
        }
      },

      onClose(_evt: CloseEvent, _ws: WSContext) {
        busUnsub?.();
        subscriptions.clear();
        subscriber?.dispose();
        if (disconnectCheck) clearInterval(disconnectCheck);
        logger.debug({ workspaceId }, "ws.client_disconnected");
      },

      onError(evt: Event, _ws: WSContext) {
        subscriber?.dispose();
        if (disconnectCheck) clearInterval(disconnectCheck);
        logger.debug({ workspaceId, evt }, "ws.error");
      },
    };
  });

  return {
    mount(honoApp: Hono) {
      honoApp.get("/memory/ws", wsMiddleware);
    },
    injectWebSocket,
  };
}
