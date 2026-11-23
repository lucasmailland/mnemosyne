// Wave X — X2.3: Redis ACL per-workspace prefix policy (pure policy).
//
// Generates the ACL username and rule set for a workspace-scoped Redis user.
// The adapter layer (RedisAclProvisioner) executes these rules via ACL SETUSER.
//
// Key pattern: mnemo:<workspaceId>:*
// Allowed commands: read + write + string + sorted-set families; dangerous blocked.
//
// PURE MODULE — no host imports.

/**
 * Returns the Redis ACL username for a workspace.
 * Format: ws_<workspaceId>
 */
export function workspaceAclUsername(workspaceId: string): string {
  return `ws_${workspaceId}`;
}

/**
 * Returns the ordered list of ACL rule tokens for a workspace user.
 * To be passed as arguments to the Redis ACL SETUSER command.
 *
 * The rules:
 *   on                       — enable the user
 *   ~mnemo:<workspaceId>:*   — restrict key access to this workspace prefix
 *   +@read                   — GET, MGET, LRANGE, SMEMBERS, ZRANGE, etc.
 *   +@write                  — SET, MSET, DEL, etc.
 *   +@string                 — string-specific commands (GETSET, SETNX, etc.)
 *   +@sortedset              — ZADD, ZRANGEBYSCORE, ZREM, etc.
 *   -@dangerous              — block FLUSHALL, DEBUG, CONFIG, KEYS, etc.
 */
export function workspaceAclRule(workspaceId: string): string[] {
  return [
    "on",
    `~mnemo:${workspaceId}:*`,
    "+@read",
    "+@write",
    "+@string",
    "+@sortedset",
    "-@dangerous",
  ];
}
