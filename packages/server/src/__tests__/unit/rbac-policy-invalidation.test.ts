/**
 * §19 cross-replica policy invalidation (middleware/rbac-policy.ts): a policy
 * write on one replica must drop the cached policy on every replica that
 * shares the channel, not only on the one that took the write.
 */
import { describe, it, expect, vi } from "vitest";
import {
  POLICY_INVALIDATION_CHANNEL,
  connectPolicyInvalidation,
  createRbacMiddleware,
  invalidateAgentPolicy,
  pollPolicyChanges,
  type PolicyChange,
} from "../../middleware/rbac-policy.js";
import type { RbacDeps } from "../../middleware/rbac-policy.js";

const WS = "ws-invalidation-test";
const ACTOR = "agent-invalidation";

/** Redis pub/sub stand-in: publish reaches every handler on the channel. */
function fakeChannel() {
  const handlers = new Map<string, Array<(m: string) => void>>();
  return {
    published: [] as Array<[string, string]>,
    async subscribe(channel: string, handler: (m: string) => void) {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
    },
    async publish(channel: string, message: string) {
      this.published.push([channel, message]);
    },
    /** What another replica's publish delivers to this one. */
    deliver(channel: string, message: string) {
      for (const h of handlers.get(channel) ?? []) h(message);
    },
  };
}

function makeCtx() {
  return {
    req: { method: "POST", path: "/remember", header: () => undefined, query: () => undefined },
    get: (key: string) => (key === "workspaceId" ? WS : key === "actorId" ? ACTOR : undefined),
    header: vi.fn(),
    json: vi.fn(),
  };
}

function makeMiddleware() {
  const getPolicy = vi.fn().mockResolvedValue(null);
  const mw = createRbacMiddleware({
    accessPolicies: { getPolicy } as unknown as RbacDeps["accessPolicies"],
    approvals: {} as RbacDeps["approvals"],
  });
  const hit = () => mw(makeCtx() as never, async () => {});
  return { getPolicy, hit };
}

describe("rbac policy invalidation across replicas", () => {
  it("an invalidation published by another replica drops the cached policy here", async () => {
    const channel = fakeChannel();
    await connectPolicyInvalidation(channel);
    const { getPolicy, hit } = makeMiddleware();

    await hit();
    await hit();
    expect(getPolicy).toHaveBeenCalledTimes(1); // second request served from cache

    channel.deliver(
      POLICY_INVALIDATION_CHANNEL,
      JSON.stringify({ workspaceId: WS, actorId: ACTOR })
    );
    await hit();
    expect(getPolicy).toHaveBeenCalledTimes(2);
  });

  it("ignores malformed messages and other agents", async () => {
    const channel = fakeChannel();
    await connectPolicyInvalidation(channel);
    const { getPolicy, hit } = makeMiddleware();

    await hit();
    for (const msg of ["not json", "null", "{}", JSON.stringify({ workspaceId: WS, actorId: 7 })]) {
      expect(() => channel.deliver(POLICY_INVALIDATION_CHANNEL, msg)).not.toThrow();
    }
    channel.deliver(
      POLICY_INVALIDATION_CHANNEL,
      JSON.stringify({ workspaceId: WS, actorId: "other" })
    );
    await hit();
    expect(getPolicy).toHaveBeenCalledTimes(1);
  });

  it("a local write publishes the invalidation for the other replicas", async () => {
    const channel = fakeChannel();
    await connectPolicyInvalidation(channel);
    await invalidateAgentPolicy(WS, ACTOR);
    expect(channel.published).toEqual([
      [POLICY_INVALIDATION_CHANNEL, JSON.stringify({ workspaceId: WS, actorId: ACTOR })],
    ]);
  });

  it("a publish failure does not fail the write and still clears this replica", async () => {
    const channel = fakeChannel();
    channel.publish = async () => {
      throw new Error("redis down");
    };
    await connectPolicyInvalidation(channel);
    const { getPolicy, hit } = makeMiddleware();

    await hit();
    await expect(invalidateAgentPolicy(WS, ACTOR)).resolves.toBeUndefined();
    await hit();
    expect(getPolicy).toHaveBeenCalledTimes(2);
  });
});

describe("rbac policy invalidation through the Postgres change log", () => {
  it("drops each new change once and still catches a lower seq that commits late", async () => {
    const { getPolicy, hit } = makeMiddleware();
    const batches: PolicyChange[][] = [
      [{ seq: 5, workspaceId: WS, agentId: ACTOR }],
      // seq 5 again (inside the look-back window): already handled.
      [{ seq: 5, workspaceId: WS, agentId: ACTOR }],
      // seq 4 committed after 5 was read: below the cursor, still new.
      [
        { seq: 4, workspaceId: WS, agentId: ACTOR },
        { seq: 5, workspaceId: WS, agentId: ACTOR },
      ],
    ];
    const cursors: number[] = [];
    const poll = pollPolicyChanges(async (afterSeq) => {
      cursors.push(afterSeq);
      return batches.shift() ?? [];
    }, 60_000);
    try {
      const loadsAfter = async () => {
        await hit();
        return getPolicy.mock.calls.length;
      };
      expect(await loadsAfter()).toBe(1);
      await poll.tick();
      expect(await loadsAfter()).toBe(2);
      await poll.tick();
      expect(await loadsAfter()).toBe(2);
      await poll.tick();
      expect(await loadsAfter()).toBe(3);
      expect(cursors).toEqual([0, 5, 5]);
    } finally {
      poll.stop();
    }
  });

  it("a failed poll keeps the cursor and the next one recovers", async () => {
    const { getPolicy, hit } = makeMiddleware();
    let fail = true;
    const poll = pollPolicyChanges(async () => {
      if (fail) throw new Error("db down");
      return [{ seq: 1, workspaceId: WS, agentId: ACTOR }];
    }, 60_000);
    try {
      await hit();
      await expect(poll.tick()).resolves.toBeUndefined();
      fail = false;
      await poll.tick();
      await hit();
      expect(getPolicy).toHaveBeenCalledTimes(2);
    } finally {
      poll.stop();
    }
  });
});
