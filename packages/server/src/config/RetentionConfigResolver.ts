import type { WorkspaceConfigStore } from "./WorkspaceConfigStore.js";
import type { KeyRingAdapter } from "../encryption/KeyRingAdapter.js";
import { GLOBAL_SENTINEL_ID } from "./WorkspaceConfigStore.js";

/** How long a resolved entry stays cached before a fresh DB lookup. */
const DEFAULT_TTL_MS = 60_000;

export interface ResolvedRetentionConfig {
  internalDays: number;
  confidentialDays: number;
  restrictedDays: number;
  /** Managed raw-transcript window; see RetentionConfig.transcriptDays. */
  transcriptDays: number;
  source: "workspace" | "global" | "env";
}

interface CacheEntry {
  internalDays: number;
  confidentialDays: number;
  restrictedDays: number;
  transcriptDays: number;
  source: "workspace" | "global" | "env";
  expiresAt: number; // determinism-ok: wall-clock cache TTL, not business logic
}

type PartialWindows = {
  internalDays?: number;
  confidentialDays?: number;
  restrictedDays?: number;
  transcriptDays?: number;
};

/**
 * Resolves the effective retention windows for a given workspace using
 * a 3-tier fallback:
 *
 *   1. Workspace-specific DB row in `mnemo_workspace_config`
 *   2. Global sentinel row (workspace_id = all-zeros UUID)
 *   3. Boot-time env-based defaults (passed in at construction)
 *
 * Partial overrides are supported: if a workspace only sets `internalDays`,
 * the other fields fall through to the global/env tiers individually.
 *
 * Results are cached per-workspaceId with a configurable TTL (default: 60 s).
 * Call `invalidate(workspaceId)` after a PUT/DELETE to flush stale cache entries.
 */
export class RetentionConfigResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(
    private readonly store: WorkspaceConfigStore,
    private readonly kms: KeyRingAdapter,
    private readonly envDefaults: {
      internalDays: number;
      confidentialDays: number;
      restrictedDays: number;
      transcriptDays: number;
    }
  ) {
    const ttlEnv = process.env["MNEMO_RETENTION_CONFIG_TTL_SECONDS"];
    this.ttlMs = ttlEnv ? Number(ttlEnv) * 1_000 : DEFAULT_TTL_MS;
  }

  /**
   * Resolve the effective retention windows for the given workspace.
   * Returns a cached result when within TTL; otherwise performs DB lookups.
   */
  async resolve(workspaceId: string): Promise<ResolvedRetentionConfig> {
    const cached = this.cache.get(workspaceId);
    if (cached && Date.now() < cached.expiresAt) {
      // determinism-ok: cache TTL check
      return {
        internalDays: cached.internalDays,
        confidentialDays: cached.confidentialDays,
        restrictedDays: cached.restrictedDays,
        transcriptDays: cached.transcriptDays,
        source: cached.source,
      };
    }

    // Tier 1: workspace-specific row (partial overrides supported)
    const ws = await this._loadFromDb(workspaceId);

    // Tier 2: global sentinel (partial overrides supported)
    const global_ = await this._loadFromDb(GLOBAL_SENTINEL_ID);

    // Resolve each field individually: workspace → global → env
    const internalDays = ws?.internalDays ?? global_?.internalDays ?? this.envDefaults.internalDays;
    const confidentialDays =
      ws?.confidentialDays ?? global_?.confidentialDays ?? this.envDefaults.confidentialDays;
    const restrictedDays =
      ws?.restrictedDays ?? global_?.restrictedDays ?? this.envDefaults.restrictedDays;
    const transcriptDays =
      ws?.transcriptDays ?? global_?.transcriptDays ?? this.envDefaults.transcriptDays;

    // Determine source based on which tier contributed at least one field
    let source: "workspace" | "global" | "env";
    if (
      ws &&
      (ws.internalDays !== undefined ||
        ws.confidentialDays !== undefined ||
        ws.restrictedDays !== undefined ||
        ws.transcriptDays !== undefined)
    ) {
      source = "workspace";
    } else if (
      global_ &&
      (global_.internalDays !== undefined ||
        global_.confidentialDays !== undefined ||
        global_.restrictedDays !== undefined ||
        global_.transcriptDays !== undefined)
    ) {
      source = "global";
    } else {
      source = "env";
    }

    const resolved: ResolvedRetentionConfig = {
      internalDays,
      confidentialDays,
      restrictedDays,
      transcriptDays,
      source,
    };

    this.cache.set(workspaceId, {
      ...resolved,
      expiresAt: Date.now() + this.ttlMs, // determinism-ok: cache expiry
    });

    return resolved;
  }

  /**
   * Flush cached entries for the given workspace AND the global sentinel.
   * Call after any PUT/DELETE on the workspace or admin config endpoints.
   */
  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
    this.cache.delete(GLOBAL_SENTINEL_ID);
  }

  /**
   * Load retention window values from the DB for a given workspace (or sentinel).
   * Returns null when no retention keys exist at all; otherwise returns whichever
   * keys are present (partial result is valid — missing keys stay undefined).
   */
  private async _loadFromDb(workspaceId: string): Promise<PartialWindows | null> {
    try {
      const [internalEnc, confidentialEnc, restrictedEnc, transcriptEnc] = await Promise.all([
        this.store.get(workspaceId, "retention_internal_days"),
        this.store.get(workspaceId, "retention_confidential_days"),
        this.store.get(workspaceId, "retention_restricted_days"),
        this.store.get(workspaceId, "retention_transcript_days"),
      ]);

      // All absent → no row for this tier
      if (!internalEnc && !confidentialEnc && !restrictedEnc && !transcriptEnc) return null;

      const dec = (enc: string | null): number | undefined => {
        if (!enc) return undefined;
        const plain = this.kms.decryptSecret(workspaceId, "retention-config", enc);
        const parsed = parseInt(plain, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      };

      return {
        internalDays: dec(internalEnc),
        confidentialDays: dec(confidentialEnc),
        restrictedDays: dec(restrictedEnc),
        transcriptDays: dec(transcriptEnc),
      };
    } catch {
      return null;
    }
  }
}
