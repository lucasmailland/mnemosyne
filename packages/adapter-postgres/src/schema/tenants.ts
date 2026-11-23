import { text, timestamp } from "drizzle-orm/pg-core";
import { mnemoSchema } from "./mnemo_schema.js";

export const tenantTable = mnemoSchema.table("mnemo_tenant", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("personal"),
  plan: text("plan").notNull().default("free"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const userTable = mnemoSchema.table("mnemo_user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  personalTenantId: text("personal_tenant_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const tenantMemberTable = mnemoSchema.table("mnemo_tenant_member", {
  tenantId: text("tenant_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("member"),
  invitedBy: text("invited_by"),
  joinedAt: timestamp("joined_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const workspaceTable = mnemoSchema.table("mnemo_workspace", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  slug: text("slug"),
  tenantId: text("tenant_id").notNull(),
  ownerUserId: text("owner_user_id"),
  visibility: text("visibility").notNull().default("private"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const workspaceMemberTable = mnemoSchema.table("mnemo_workspace_member", {
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("read"),
  invitedBy: text("invited_by"),
  joinedAt: timestamp("joined_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type SelectTenant = typeof tenantTable.$inferSelect;
export type InsertTenant = typeof tenantTable.$inferInsert;
export type SelectUser = typeof userTable.$inferSelect;
export type InsertUser = typeof userTable.$inferInsert;
export type SelectWorkspaceMember = typeof workspaceMemberTable.$inferSelect;
