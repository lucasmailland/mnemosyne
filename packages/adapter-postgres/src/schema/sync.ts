import { mnemoSchema } from "./mnemo_schema.js";
import {
  text,
  boolean,
  bigint,
  doublePrecision,
  timestamp,
  jsonb,
  uuid,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { bytea } from "./_custom-types.js";

/**
 * mnemo_sync_cursor — per-peer sync progress cursor.
 * Tracks the last successful sync timestamp per (peer_id, workspace_id).
 * RLS scoped to app.current_workspace_id.
 */
export const syncCursorTable = mnemoSchema.table("mnemo_sync_cursor", {
  peerId: uuid("peer_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: "date" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/**
 * mnemo_sync_tombstone — append-only deletion log for federation tombstones.
 * Maps to SyncStorage.isInDeletionLog / insertDeletionLog.
 * Append-only — mnemo_app_role has SELECT + INSERT only (no UPDATE/DELETE).
 */
export const syncTombstoneTable = mnemoSchema.table("mnemo_sync_tombstone", {
  itemId: uuid("item_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }).notNull(),
  version: bigint("version", { mode: "number" }).notNull().default(0),
  peerDomain: text("peer_domain").notNull().default(""),
  reason: text("reason").notNull().default("federation_tombstone"),
});

/**
 * mnemo_federated_item — federated item store.
 * Maps to SyncStorage.findByRemoteId / upsertFederatedItem / archiveLocalItem.
 * attribution CHECK constraint enforces 'federation_received' at the DB level.
 * RLS scoped to app.current_workspace_id.
 */
export const federatedItemTable = mnemoSchema.table(
  "mnemo_federated_item",
  {
    localId: uuid("local_id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    remoteId: text("remote_id").notNull(),
    peerDomain: text("peer_domain").notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
    attribution: text("attribution").notNull().default("federation_received"),
    payload: jsonb("payload").notNull().default({}),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("idx_federated_item_remote").on(t.workspaceId, t.remoteId)]
);

/**
 * mnemo_sync_supersession — append-only supersession-chain log for federation §20 merge.
 * Written by DrizzleSyncStorage.markSuperseded when conflictResolution="merge".
 * Prior local item is retained (archived) and linked here; the incoming item becomes
 * current under a fresh localId. Chain is append-only: INSERT only for mnemo_app_role.
 * RLS scoped to mnemosyne.workspace_id GUC.
 */
export const syncSupersessionTable = mnemoSchema.table("mnemo_sync_supersession", {
  workspaceId: uuid("workspace_id").notNull(),
  remoteId: text("remote_id").notNull(),
  supersededLocalId: text("superseded_local_id").notNull(),
  peerDomain: text("peer_domain").notNull(),
  supersededAt: timestamp("superseded_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

/**
 * mnemo_federation_peer — the installation's federation peers (PeerConfig),
 * migration 0061. Not per workspace: RLS + FORCE keyed to the
 * mnemosyne.federation_peers GUC, which only DrizzlePeerStore sets.
 */
export const federationPeerTable = mnemoSchema.table("mnemo_federation_peer", {
  peerId: text("peer_id").primaryKey(),
  pinnedCertDer: bytea("pinned_cert_der").notNull(),
  trustWeight: doublePrecision("trust_weight").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  url: text("url"),
  apiKey: text("api_key"),
  signingPublicKey: text("signing_public_key"),
  symmetricKey: text("symmetric_key"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/**
 * mnemo_federation_sync_job — the async jobs POST /memory/federation/sync
 * starts, migration 0063. RLS + FORCE per workspace (mnemosyne.workspace_id).
 */
export const federationSyncJobTable = mnemoSchema.table("mnemo_federation_sync_job", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  peerId: text("peer_id").notNull(),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  outcome: jsonb("outcome"),
  error: text("error"),
});

/**
 * mnemo_federation_serve_mark — per (workspace, peer), the latest creation time
 * among the facts GET /memory/federation/items served that peer; it bounds the
 * tombstones the peer gets. Migration 0070, RLS + FORCE per workspace.
 */
export const federationServeMarkTable = mnemoSchema.table(
  "mnemo_federation_serve_mark",
  {
    workspaceId: text("workspace_id").notNull(),
    peerId: text("peer_id").notNull(),
    servedUntil: timestamp("served_until", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.peerId], name: "mnemo_federation_serve_mark_pkey" }),
  ]
);

export type SelectSyncCursor = typeof syncCursorTable.$inferSelect;
export type InsertSyncCursor = typeof syncCursorTable.$inferInsert;
export type SelectSyncTombstone = typeof syncTombstoneTable.$inferSelect;
export type InsertSyncTombstone = typeof syncTombstoneTable.$inferInsert;
export type SelectFederatedItem = typeof federatedItemTable.$inferSelect;
export type InsertFederatedItem = typeof federatedItemTable.$inferInsert;
export type SelectSyncSupersession = typeof syncSupersessionTable.$inferSelect;
export type InsertSyncSupersession = typeof syncSupersessionTable.$inferInsert;
