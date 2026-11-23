/**
 * Region-lock middleware — spec §35 "Multi-Region & Data Residency" lines 4049–4083.
 *
 * A workspace is pinned to a region at creation (mnemo_workspace.region,
 * migration 0062). If MNEMO_REGION is set and a workspace's region does not
 * match, the request is rejected with 403 wrong_region.
 *
 * Default (MNEMO_REGION unset) = single-region mode, check disabled (back-compat).
 * A workspace without a region (created before 0062, or by an instance without
 * MNEMO_REGION) is let through.
 *
 * Mounted right after authentication (app.ts, dashboard-api.ts). It reads the
 * region once per workspace through `lookupRegion` and exposes it on the
 * context variable `workspaceRegion` (the export header reports it).
 */
import type { MiddlewareHandler } from "hono";
import type postgres from "postgres";
import { LRUCache } from "lru-cache";
import type { AuthVariables } from "../auth.js";
import { HttpError } from "../errors.js";
import { logger } from "../logging.js";

export class WrongRegionError extends HttpError {
  constructor(workspaceRegion: string, envRegion: string) {
    super(
      403,
      "wrong_region",
      `Workspace is locked to region '${workspaceRegion}'. This instance serves '${envRegion}'.`,
      {
        homeRegion: workspaceRegion,
        instanceRegion: envRegion,
      }
    );
    this.name = "WrongRegionError";
  }
}

export type WorkspaceRegionLookup = (workspaceId: string) => Promise<string | null>;

/**
 * The region of a workspace, one query per workspace and cache lifetime. A
 * region never changes after creation, so the cache cannot serve a stale one;
 * the TTL only bounds how long a missing workspace row is remembered.
 */
export function createWorkspaceRegionLookup(sql: postgres.Sql): WorkspaceRegionLookup {
  const cache = new LRUCache<string, { region: string | null }>({ max: 10_000, ttl: 600_000 });
  return async (workspaceId) => {
    const hit = cache.get(workspaceId);
    if (hit) return hit.region;
    const rows = await sql<{ region: string | null }[]>`
      SELECT mnemosyne.mnemo_workspace_region(${workspaceId}) AS region`;
    const region = rows[0]?.region ?? null;
    cache.set(workspaceId, { region });
    return region;
  };
}

/**
 * The middleware's decision for transports that do not run Hono middleware
 * (gRPC, WebSocket). Throws WrongRegionError for a workspace pinned elsewhere;
 * a failed lookup throws too while the lock is on (fail closed).
 */
export async function assertWorkspaceRegion(
  workspaceId: string,
  lookupRegion: WorkspaceRegionLookup | undefined,
  envRegion: string | undefined = process.env.MNEMO_REGION
): Promise<void> {
  if (!envRegion || !lookupRegion) return;
  const workspaceRegion = await lookupRegion(workspaceId);
  if (workspaceRegion && workspaceRegion !== envRegion) {
    throw new WrongRegionError(workspaceRegion, envRegion);
  }
}

export interface RegionLockOptions {
  /** Override for testing — defaults to () => process.env.MNEMO_REGION */
  getEnvRegion?: () => string | undefined;
  /** Where the workspace region comes from. Absent (no Postgres) → only a preset `workspaceRegion` counts. */
  lookupRegion?: WorkspaceRegionLookup;
}

export function regionLockMiddleware(
  opts: RegionLockOptions = {}
): MiddlewareHandler<{ Variables: AuthVariables }> {
  const getEnvRegion = opts.getEnvRegion ?? (() => process.env.MNEMO_REGION);

  return async (c, next) => {
    const envRegion = getEnvRegion();
    const workspaceId = c.get("workspaceId");
    let workspaceRegion = c.get("workspaceRegion");

    if (!workspaceRegion && workspaceId && opts.lookupRegion) {
      try {
        workspaceRegion = (await opts.lookupRegion(workspaceId)) ?? undefined;
      } catch (err) {
        // With the lock on, an unknown region is never "allowed". Without it,
        // only the export header needed the answer.
        if (envRegion) throw err;
        logger.warn({ err }, "region.lookup_failed");
      }
      if (workspaceRegion) c.set("workspaceRegion", workspaceRegion);
    }

    // Single-region mode, or a workspace without a region (back-compat).
    if (!envRegion || !workspaceRegion) return next();

    if (workspaceRegion !== envRegion) {
      throw new WrongRegionError(workspaceRegion, envRegion);
    }

    return next();
  };
}
