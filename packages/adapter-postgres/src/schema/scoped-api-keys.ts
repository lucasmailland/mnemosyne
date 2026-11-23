import { mnemoSchema } from "./mnemo_schema.js";
import { text, boolean, timestamp, jsonb, uuid, bigint } from "drizzle-orm/pg-core";
import { userTable } from "./tenants.js";

/**
 * §6 Scoped API keys — the spec's `prefix + keyId + secret` key scheme that backs
 * the ScopedApiKeyAdapter (argon2id secrets, key types, rotation, MFA break-glass,
 * deprecation grace, anomaly forced-rotation).
 *
 * This is ADDITIVE and SEPARATE from the live `mnemo_api_keys` (bcrypt-over-full-key,
 * `mns_*`) table — it does NOT touch existing keys. The server auth middleware runs
 * both schemes side by side (dispatch by prefix), gated behind MNEMO_SCOPED_AUTH so
 * the scoped scheme can be dark-launched (spec §35 line 4011) without disrupting
 * live `mns_*` keys.
 */
export const scopedApiKeysTable = mnemoSchema.table("mnemo_scoped_api_keys", {
  keyId: text("key_id").primaryKey(),
  prefix: text("prefix").notNull(),
  hashedSecret: text("hashed_secret").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  scopes: jsonb("scopes").notNull().default([]),
  status: text("status").notNull().default("active"),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  rotatedFromId: text("rotated_from_id"),
  ipAllowlist: jsonb("ip_allowlist"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  deprecatedAt: timestamp("deprecated_at", { withTimezone: true, mode: "date" }),
  mfaSecret: text("mfa_secret"),
  /** True when the key is bound to a test workspace (enables test/prod isolation). */
  isTest: boolean("is_test").notNull().default(false),
  /**
   * Per-key recall sensitivity ceiling (§5). NULL = no per-key grant; the
   * process-wide MNEMO_SENSITIVITY_CEILING applies. When set, it can only
   * lower (never raise) the effective ceiling for this key's requests.
   */
  maxSensitivity: text("max_sensitivity"),
  /** The platform user who issued the key (0069). Break-glass keys on it. */
  userId: text("user_id").references(() => userTable.id, { onDelete: "restrict" }),
});

/** Newest-first usage trail for anomaly detection (markUsed / recentUsage). */
export const scopedKeyUsageTable = mnemoSchema.table("mnemo_scoped_key_usage", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  keyId: text("key_id").notNull(),
  ipAddress: text("ip_address").notNull(),
  at: timestamp("at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/** Append-only escrow of key METADATA (never the secret) for forensics. */
export const scopedKeyEscrowTable = mnemoSchema.table("mnemo_scoped_key_escrow", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  keyId: text("key_id").notNull(),
  prefix: text("prefix").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  scopes: jsonb("scopes").notNull().default([]),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  escrowedAt: timestamp("escrowed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type SelectScopedApiKey = typeof scopedApiKeysTable.$inferSelect;
export type InsertScopedApiKey = typeof scopedApiKeysTable.$inferInsert;
