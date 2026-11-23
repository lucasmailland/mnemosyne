import type { T } from "@/lib/i18n/core";

/** A workspace membership role as the server stores it. */
export type WorkspaceRole = "owner" | "admin" | "write" | "read";

/** The one vocabulary the dashboard shows for membership roles. */
export function roleLabel(t: T, role: WorkspaceRole): string {
  return t(`roles.${role}`);
}

export const ROLES: readonly WorkspaceRole[] = ["owner", "admin", "write", "read"];

export function isRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
