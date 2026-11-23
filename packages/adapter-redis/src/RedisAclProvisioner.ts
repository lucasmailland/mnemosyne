// Wave X2.3 — Redis ACL provisioner (adapter layer).
//
// Calls ACL SETUSER / ACL DELUSER on the Redis server to enforce per-workspace
// key-prefix isolation. The pure policy (username + rule tokens) comes from
// @mnemo-ai/core security/redis-acl — this file is the infrastructure adapter.
//
// Usage:
//   const provisioner = new RedisAclProvisioner(redis);
//   await provisioner.provision(workspaceId, password);
//   // ... later ...
//   await provisioner.deprovision(workspaceId);

import Redis from "ioredis";
import {
  workspaceAclUsername,
  workspaceAclRule,
} from "@mnemo-ai/core";

export class RedisAclProvisioner {
  constructor(private readonly redis: Redis) {}

  /**
   * Create (or replace) a workspace-scoped ACL user.
   * The user is limited to keys matching `mnemo:<workspaceId>:*`.
   *
   * @param workspaceId - UUID of the workspace.
   * @param password    - Plaintext password for this ACL user (caller generates securely).
   */
  async provision(workspaceId: string, password: string): Promise<void> {
    const username = workspaceAclUsername(workspaceId);
    const rules = workspaceAclRule(workspaceId);
    // ACL SETUSER <username> <rules...> ><password>
    await (this.redis as unknown as { acl: (...args: string[]) => Promise<unknown> }).acl(
      "SETUSER",
      username,
      ...rules,
      `>${password}`,
    );
  }

  /**
   * Remove the workspace-scoped ACL user.
   * Safe to call even if the user does not exist (Redis returns OK).
   */
  async deprovision(workspaceId: string): Promise<void> {
    const username = workspaceAclUsername(workspaceId);
    await (this.redis as unknown as { acl: (...args: string[]) => Promise<unknown> }).acl(
      "DELUSER",
      username,
    );
  }
}
