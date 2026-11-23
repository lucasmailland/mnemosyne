import type { SealedItem } from "./crypto.js";
import type { ConflictResolution } from "./SyncEngine.js";

export interface SyncRequest {
  fromInstance: string;
  toInstance: string;
  scope: {
    workspaces: string[];
    knowledgeTypes: string[];
    since?: string;
  };
  /** §20 strategy — theirs_wins | ours_wins | manual | merge (supersession chain). */
  conflictResolution: ConflictResolution;
}

export interface SyncableRecord {
  id: string;
  workspaceId: string;
  knowledgeType: string;
  updatedAt: string;
  payload?: Record<string, unknown>;
}

export interface SyncPayload {
  facts: SealedItem[];
  entities: SealedItem[];
  relations: SealedItem[];
  cursor: string;
  signature: string;
}

export function filterByScope(records: SyncableRecord[], req: SyncRequest): SyncableRecord[] {
  const ws = new Set(req.scope.workspaces);
  const kt = new Set(req.scope.knowledgeTypes);
  const sinceMs = req.scope.since ? new Date(req.scope.since).getTime() : -Infinity;
  return records.filter(
    (r) => ws.has(r.workspaceId) && kt.has(r.knowledgeType) && new Date(r.updatedAt).getTime() > sinceMs,
  );
}

export function nextCursor(page: SyncableRecord[]): string | null {
  if (page.length === 0) return null;
  return page.reduce((max, r) => (r.updatedAt > max ? r.updatedAt : max), page[0]!.updatedAt);
}

/**
 * AB2 — Cross-region federation projection (spec §35 lines 4072–4076).
 *
 * When a peer is in a different region, return only metadata triples
 * { factId, hash, region } — never statement/content/embedding.
 * Same-region or single-region mode returns the full payload.
 *
 * IMPORTANT: Keep this layer pure — region args are injected by the server caller,
 * not read from DB here.
 */
export interface FactForPeer {
  factId: string;
  hash: string;
  region?: string;
  [key: string]: unknown;
}

export interface FactMetadata {
  factId: string;
  hash: string;
  region?: string;
}

export function projectForPeer(
  facts: FactForPeer[],
  opts: { localRegion: string | undefined; peerRegion: string | undefined },
): FactForPeer[] | FactMetadata[] {
  const { localRegion, peerRegion } = opts;
  // Single-region mode (no localRegion) or same-region peer → full payload
  if (!localRegion || localRegion === peerRegion) {
    return facts;
  }
  // Cross-region → metadata only (spec lines 4074–4076)
  return facts.map(({ factId, hash, region }) => ({ factId, hash, region }));
}
