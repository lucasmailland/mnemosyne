// InMemorySyncStorage — in-process SyncStorage adapter for development / testing.
//
// All state lives in Maps and arrays; nothing is persisted across restarts.
// Suitable for unit tests, local dev, and the server's default boot path when
// no external storage adapter (@mnemo-ai/adapter-postgres) is installed.
//
// References: AUDIT_REPORT.md FED-03, packages/federation/src/SyncEngine.ts

import type { LocalItemRef, SyncStorage } from "./SyncEngine.js";
import { randomUUID } from "node:crypto";

// ── Internal record shapes ────────────────────────────────────────────────────

interface StoredItem extends LocalItemRef {
  attribution: string;
  worth: number;
  validFrom: string;
  payload: Record<string, unknown>;
  archived: boolean;
}

interface DeletionLogEntry {
  workspaceId: string;
  remoteId: string;
  peerDomain: string;
  reason: "federation_tombstone";
  deletedAt: string;
}

interface SupersessionEntry {
  workspaceId: string;
  /** localId of the prior item that was superseded. */
  supersededLocalId: string;
  remoteId: string;
  peerDomain: string;
  supersededAt: string;
}

// ── InMemorySyncStorage ───────────────────────────────────────────────────────

export class InMemorySyncStorage implements SyncStorage {
  /** localId → StoredItem */
  private readonly items = new Map<string, StoredItem>();

  /** Composite key → localId for reverse lookup */
  private readonly remoteIndex = new Map<string, string>();

  /** Append-only deletion log */
  private readonly deletionLog: DeletionLogEntry[] = [];

  /** Append-only supersession log (§20 merge strategy) */
  private readonly supersessionLog: SupersessionEntry[] = [];

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /** Composite key that scopes a remoteId to a workspaceId. */
  private static key(remoteId: string, workspaceId: string): string {
    return `${workspaceId}:${remoteId}`;
  }

  // ── SyncStorage interface ─────────────────────────────────────────────────────

  async findByRemoteId(remoteId: string, workspaceId: string): Promise<LocalItemRef | null> {
    const localId = this.remoteIndex.get(InMemorySyncStorage.key(remoteId, workspaceId));
    if (!localId) return null;

    const item = this.items.get(localId);
    if (!item || item.archived) return null;

    // Return LocalItemRef shape including resolver fields
    return {
      localId: item.localId,
      remoteId: item.remoteId,
      version: item.version,
      workspaceId: item.workspaceId,
      peerDomain: item.peerDomain,
      attribution: item.attribution,
      worth: item.worth,
      validFrom: item.validFrom,
    };
  }

  async isInDeletionLog(remoteId: string, workspaceId: string): Promise<boolean> {
    return this.deletionLog.some(
      (entry) => entry.remoteId === remoteId && entry.workspaceId === workspaceId,
    );
  }

  async upsertFederatedItem(opts: {
    workspaceId: string;
    remoteId: string;
    peerDomain: string;
    version: number;
    attribution: "federation_received";
    payload: Record<string, unknown>;
  }): Promise<{ localId: string }> {
    const { workspaceId, remoteId, peerDomain, version, attribution, payload } = opts;
    const indexKey = InMemorySyncStorage.key(remoteId, workspaceId);

    // Check for existing item to reuse its localId
    const existingLocalId = this.remoteIndex.get(indexKey);

    const localId = existingLocalId ?? randomUUID();

    const stored: StoredItem = {
      localId,
      remoteId,
      version,
      workspaceId,
      peerDomain,
      attribution,
      // Extract worth/validFrom from payload if available, else defaults
      worth: typeof payload["worth"] === "number" ? payload["worth"] : 1,
      validFrom: typeof payload["validFrom"] === "string" ? payload["validFrom"] : new Date().toISOString(),
      payload,
      archived: false,
    };

    this.items.set(localId, stored);
    this.remoteIndex.set(indexKey, localId);

    return { localId };
  }

  async archiveLocalItem(localId: string, workspaceId: string): Promise<void> {
    const item = this.items.get(localId);
    if (!item) return;
    // Guard: only archive items belonging to the correct workspace
    if (item.workspaceId !== workspaceId) return;

    this.items.set(localId, { ...item, archived: true });
  }

  async insertDeletionLog(opts: {
    workspaceId: string;
    remoteId: string;
    peerDomain: string;
    reason: "federation_tombstone";
    deletedAt: string;
  }): Promise<void> {
    this.deletionLog.push({ ...opts });
  }

  async markSuperseded(opts: {
    workspaceId: string;
    supersededLocalId: string;
    remoteId: string;
    peerDomain: string;
  }): Promise<void> {
    // Retain the prior item rather than discarding it: flag it superseded (so it
    // no longer serves as "current" via findByRemoteId) and record the chain link.
    // Crucially, drop the reverse-index entry so the subsequent upsert allocates a
    // FRESH localId for the incoming item instead of overwriting the prior one in
    // place — that is what keeps the superseded version intact in the chain.
    const prior = this.items.get(opts.supersededLocalId);
    if (prior && prior.workspaceId === opts.workspaceId) {
      this.items.set(opts.supersededLocalId, { ...prior, archived: true });
      this.remoteIndex.delete(InMemorySyncStorage.key(opts.remoteId, opts.workspaceId));
    }
    this.supersessionLog.push({
      ...opts,
      supersededAt: new Date().toISOString(),
    });
  }

  // ── Test / observability helpers ──────────────────────────────────────────────

  /**
   * Seed a local item with full resolver fields — for test setup only.
   */
  async seedLocal(args: {
    localId: string;
    remoteId: string;
    workspaceId: string;
    version: number;
    peerDomain: string;
    attribution: string;
    worth: number;
    validFrom: string;
  }): Promise<void> {
    const { localId, remoteId, workspaceId, version, peerDomain, attribution, worth, validFrom } = args;
    const indexKey = InMemorySyncStorage.key(remoteId, workspaceId);

    const stored: StoredItem = {
      localId,
      remoteId,
      version,
      workspaceId,
      peerDomain,
      attribution,
      worth,
      validFrom,
      payload: {},
      archived: false,
    };

    this.items.set(localId, stored);
    this.remoteIndex.set(indexKey, localId);
  }

  /**
   * Returns the stored attribution of an item — for test assertion only.
   */
  async attributionOf(remoteId: string, workspaceId: string): Promise<string | null> {
    const localId = this.remoteIndex.get(InMemorySyncStorage.key(remoteId, workspaceId));
    if (!localId) return null;
    const item = this.items.get(localId);
    if (!item || item.archived) return null;
    return item.attribution;
  }

  /** Returns all non-archived federated items across all workspaces. */
  listLive(): StoredItem[] {
    return Array.from(this.items.values()).filter((i) => !i.archived);
  }

  /** Returns the full deletion log. */
  listDeletionLog(): DeletionLogEntry[] {
    return [...this.deletionLog];
  }

  /** Returns the full supersession log (§20 merge strategy) — for test assertion. */
  listSupersession(): SupersessionEntry[] {
    return [...this.supersessionLog];
  }

  /** Returns ALL items including archived/superseded ones — for test assertion. */
  listAll(): StoredItem[] {
    return Array.from(this.items.values());
  }
}
