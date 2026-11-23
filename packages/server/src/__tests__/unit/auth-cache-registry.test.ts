import { LRUCache } from "lru-cache";
import { describe, expect, it } from "vitest";
import { forgetKeyAuth, forgetUserAuth, registerAuthCaches } from "../../auth-cache-registry.js";

describe("forgetUserAuth", () => {
  it("drops only that user's cached keys and roles, in every registered cache", () => {
    const transports = [0, 1].map(() => {
      const keys = new LRUCache<string, { workspaceId: string; userId?: string | null }>({
        max: 10,
      });
      const roles = new LRUCache<string, { role: string | null }>({ max: 10 });
      keys.set("token-a1", { workspaceId: "w1", userId: "user-a" });
      keys.set("token-a2", { workspaceId: "w2", userId: "user-a" });
      keys.set("token-b", { workspaceId: "w1", userId: "user-b" });
      keys.set("token-unbound", { workspaceId: "w1", userId: null });
      roles.set("user-a:w1", { role: "write" });
      roles.set("user-ab:w1", { role: "read" });
      roles.set("user-b:w1", { role: null });
      registerAuthCaches(keys, roles);
      return { keys, roles };
    });

    forgetUserAuth("user-a");

    for (const { keys, roles } of transports) {
      expect([...keys.keys()].sort()).toEqual(["token-b", "token-unbound"]);
      expect([...roles.keys()].sort()).toEqual(["user-ab:w1", "user-b:w1"]);
    }
  });
});

describe("forgetKeyAuth", () => {
  it("drops every cached token of that key, in every registered cache, and nothing else", () => {
    const transports = [0, 1].map(() => {
      const keys = new LRUCache<
        string,
        { workspaceId: string; actorId: string; userId?: string | null }
      >({ max: 10 });
      const roles = new LRUCache<string, { role: string | null }>({ max: 10 });
      keys.set("token-revoked", { workspaceId: "w1", actorId: "mk_revoked", userId: "user-a" });
      keys.set("token-other", { workspaceId: "w1", actorId: "mk_other", userId: "user-a" });
      roles.set("user-a:w1", { role: "write" });
      registerAuthCaches(keys, roles);
      return { keys, roles };
    });

    forgetKeyAuth("mk_revoked");

    for (const { keys, roles } of transports) {
      expect([...keys.keys()]).toEqual(["token-other"]);
      expect([...roles.keys()]).toEqual(["user-a:w1"]);
    }
  });
});
