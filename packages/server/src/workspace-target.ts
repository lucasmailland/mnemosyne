import { logger } from "./logging.js";

/**
 * Shared cross-workspace membership check — single implementation used by
 * `POST /remember` and (P57 slices 2a/2b) the 9 other creation routes.
 *
 * Extracted verbatim from `remember.ts`'s original inline block (P57 design.md
 * D2): this stays on a raw `sql.begin()` transaction that sets
 * `mnemosyne.actor_user_id` via `set_config(...)`. It deliberately does NOT
 * go through `withMnemoTx`/`withMnemoTenantTx` — those set the
 * `mnemosyne.workspace_id` GUC, but every RLS policy on
 * `mnemo_workspace_member` keys on `mnemosyne.actor_user_id` instead
 * (baseline `0001:5789/5798`, `0012`, `0022`). Routing this through
 * `withMnemoTx` would be functionally wrong, not just heavier — it would
 * silently break the membership check. This raw-transaction-on-
 * `deps.metricsPgClient` pattern is the established server-layer convention
 * for tenant-scoped tables without RLS keyed on `workspace_id` — see
 * `tenants.ts`, `keys.ts`, and `recall/multi-level.ts` for precedent.
 */

export interface ResolveTargetWorkspaceInput {
  /** The workspace bound to the caller's API key — `getAuthCtx(c).workspaceId`. */
  keyWorkspaceId: string;
  /** `body.targetWorkspaceId`, when the caller asked to write cross-workspace. */
  targetWorkspaceId: string | undefined;
  /** `getAuthCtx(c).userId` — membership checks require a user-bound key. */
  userId: string | null | undefined;
  /** `deps.metricsPgClient` — required to run the membership query. */
  sql: import("postgres").Sql | undefined;
}

export type ResolveTargetWorkspaceResult =
  | { ok: true; workspaceId: string; crossWorkspace: boolean }
  | { ok: false; status: 403; body: { error: "forbidden"; message: string } };

type MemberRow = { role: string };

/**
 * Resolve the effective workspace for a create-primitive write.
 *
 * Never throws (D3) — always resolves to the discriminated union above, so
 * every call site emits the identical flat `{ error: "forbidden", message }`
 * 403 body `remember.ts` used before this extraction (not `ForbiddenError`'s
 * nested envelope).
 */
export async function resolveTargetWorkspace(
  input: ResolveTargetWorkspaceInput
): Promise<ResolveTargetWorkspaceResult> {
  const { keyWorkspaceId, targetWorkspaceId, userId, sql } = input;

  if (!targetWorkspaceId || targetWorkspaceId === keyWorkspaceId) {
    return { ok: true, workspaceId: keyWorkspaceId, crossWorkspace: false };
  }

  if (!userId || !sql) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "forbidden",
        message:
          "targetWorkspaceId requires a user-bound key (mk_user_* or mk_live_* with user_id)",
      },
    };
  }

  // Verify membership — wrap in transaction to set user GUC for RLS on mnemo_workspace_member.
  const members: MemberRow[] = await sql
    .begin(async (tx) => {
      await tx`SELECT set_config('mnemosyne.actor_user_id', ${userId}, true)`;
      return tx<MemberRow[]>`
        SELECT role FROM mnemosyne.mnemo_workspace_member
        WHERE workspace_id = ${targetWorkspaceId} AND user_id = ${userId}
        LIMIT 1
      `;
    })
    .catch((err: unknown) => {
      logger.warn({ err, targetWorkspaceId, userId }, "workspace_target.membership_query_failed");
      return [] as MemberRow[];
    });

  if (!members[0] || members[0].role === "read") {
    return {
      ok: false,
      status: 403,
      body: { error: "forbidden", message: "User is not a write member of the target workspace" },
    };
  }

  return { ok: true, workspaceId: targetWorkspaceId, crossWorkspace: true };
}
