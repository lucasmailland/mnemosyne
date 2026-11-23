/**
 * Map an HTTP method + path to the minimum required API key scope.
 * Returns null for paths that don't need a specific scope (e.g. OPTIONS).
 *
 * Spec §6 — 15 canonical memory scopes. Resolution order: most-specific path
 * prefix wins over HTTP method. The first matching rule is returned.
 *
 * Lives in its own module (not app.ts) so the dashboard data bridge can share
 * the exact rule table without a circular import.
 */
export function getScopeForRequest(method: string, path: string): string | string[] | null {
  // Instance plane (dashboard bridge only): installation-wide administration.
  // Admission is the module's own live-superadmin guard (routes/instance.ts),
  // which runs first; this rule is the second layer. First, so that no
  // substring rule below (/users, /admin, ...) can match these paths.
  if (path.includes("/instance/")) return "admin:workspace";
  // WebSocket / streaming subscription
  if (path.includes("/ws") || path.includes("/subscribe")) return "memory:subscribe";
  // Bulk export
  if (path.includes("/export")) return "memory:export";
  // Federation cross-instance. Peer TRUST ADMINISTRATION (enrol/approve/remove a
  // peer) is a different authority tier than routine data-plane sync: approving a
  // peer enrols a new source of federated writes, deleting one severs a trusted
  // link. It gets its own non-tenant-mintable scope; /items, /sync and /resolve
  // keep memory:federation. Branch is by SUB-PATH, not method — unlike the
  // /workspaces GET-vs-write split below, ALL 5 peer routes are admin-tier
  // including the GETs: GET /peers returns pinned-cert metadata and trust
  // weights (reconnaissance for a pin-substitution attack), and
  // GET /peers/pending is an operator surface.
  if (path.includes("/federation")) {
    if (path.includes("/federation/peers")) return "federation:admin";
    return "memory:federation";
  }
  // Governance, consolidation, vitals
  if (path.includes("/consolidation") || path.includes("/governance") || path.includes("/vitals"))
    return "memory:governance";
  // L0 sessions
  if (path.includes("/harness/v1/")) return "memory:session";
  if (path.includes("/sessions")) return "memory:session";
  // APP-076: the session routes are /session/* (singular) and matched nothing
  // here, so memory:session never decided them. Writes now accept the session
  // scope; memory:write keeps working (any-of) so keys minted before this
  // change, with read+write only, do not lose sessions.
  if (method !== "GET" && /\/session(\/|$)/.test(path)) return ["memory:session", "memory:write"];
  // Task scheduling
  if (path.includes("/tasks")) return "memory:task";
  // Event stream
  if (path.includes("/events")) return "memory:event";
  // Reasoning / chain-of-thought
  if (path.includes("/reasoning")) return "memory:reasoning";
  // SEC-1: platform-level config: writes to /admin/config/{llm,retention} target
  // the GLOBAL_SENTINEL_ID workspace (see routes/admin.ts) — affecting every
  // tenant/workspace on the instance, not just the caller's own. Must be checked
  // BEFORE the /config/llm rule below (which is a substring match memory:admin
  // would otherwise also satisfy for these paths) and requires the non-tenant-
  // grantable admin:workspace scope. Reads stay memory:admin so per-tenant
  // operators can still inspect the effective global config.
  if (path.includes("/admin/config/llm") || path.includes("/admin/config/retention")) {
    if (method === "GET") return "memory:admin";
    return "admin:workspace";
  }
  // P6/P29 workspace-level config management (admin-tier operation)
  if (path.includes("/config/llm") || path.includes("/config/retention")) return "memory:admin";
  // Workspace mode graduation control: reads are viewer-tier, writes flip
  // extraction gates for the whole workspace → admin-tier.
  if (path.includes("/workspace-mode") && method !== "GET") return "memory:admin";
  // P7/P13: key management and identity introspection
  if (path.includes("/admin/keys") || path.includes("/admin/scoped-keys")) return "admin:keys";
  if (path === "/me" || path.endsWith("/me")) return "memory:read";
  // The signed-in user's own workspaces (dashboard bridge, routes/my-workspaces.ts):
  // listing, creating and switching are about the person, not the session
  // workspace, so even a viewer there may do them. The route admits password
  // sessions only and the database enforces the per-user limit.
  if (path.includes("/my-workspaces")) return "memory:read";
  // Members and invitations of the session workspace (dashboard bridge): the
  // list is a read; every change is admin-tier. The routes also require the
  // live owner/admin role (routes/workspace-members.ts).
  if (path.includes("/workspace/members") || path.includes("/workspace/invitations"))
    return method === "GET" ? "memory:read" : "memory:admin";
  // Multi-tenant model: tenants, users, workspaces
  if (path.includes("/tenants") || path.startsWith("/users")) return "admin:tenant";
  if (path.includes("/workspaces")) {
    // Reads (GET /workspaces/mine, /:id, /:id/members) are satisfied by
    // either a plain read scope or the broader admin scope — a workspace-role
    // `read` member (narrowed to memory:read only at auth time, see
    // auth.ts's role-scope narrowing) must still be able to discover which
    // workspaces they belong to and who else is in them. Mutating routes
    // (invite/remove/role-change) stay admin-only.
    if (method === "GET") return ["memory:read", "memory:admin"];
    return "memory:admin";
  }
  // Stats are readable by members; the handler omits the admin-only fields for
  // callers without memory:admin.
  if (method === "GET" && path.endsWith("/admin/stats")) return ["memory:read", "memory:admin"];
  // Health history (the daily snapshots and the readiness ring buffer) is an
  // operator view of the workspace, not a member read.
  if (path.includes("/health/snapshots") || path.includes("/health/history")) return "memory:admin";
  // APP-005: a webhook endpoint receives every event of the workspace and makes
  // the server call a URL the caller chose. Registering, changing, testing or
  // removing one is an operator decision; listing them stays a read.
  if (method !== "GET" && /\/webhooks(\/|$)/.test(path)) return "memory:admin";
  // The doctor's checks (schema, grants, migrations) describe the installation: operators only.
  if (method === "GET" && /\/doctor$/.test(path)) return "memory:admin";
  // GDPR crypto-erasure destroys a subject's keys: the irreversible-destruction scope.
  if (path.includes("/admin/erasure")) return "memory:hard_delete";
  // Admin operations
  if (path.includes("/admin") || path.includes("/governance")) return "memory:admin";
  // §6: procedural evolution is its own scope — do not fold it into self_edit.
  if (path.includes("/procedural")) return "memory:procedural";
  // Routes are mounted at /self/edit and /self/reflect (NOT /self-edit). Match the
  // real paths so the self_edit scope is actually enforced. /self/profile is a read.
  if (path.includes("/self/edit") || path.includes("/self/reflect")) return "memory:self_edit";
  // Semantic recall
  if (path.includes("/recall")) return "memory:read";
  // Generic HTTP verb dispatch
  if (method === "GET") return "memory:read";
  if (method === "DELETE")
    return path.endsWith("/hard") || path.includes("/hard")
      ? "memory:hard_delete"
      : "memory:delete";
  if (method === "POST" || method === "PATCH" || method === "PUT") return "memory:write";
  return null;
}
