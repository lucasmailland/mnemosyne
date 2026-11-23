/**
 * §19 cross-replica policy invalidation over a real Redis: replica B caches an
 * agent's policy, replica A (its own Redis connection) publishes the
 * invalidation after a policy write, and B's next request reads the new policy
 * instead of waiting for the 60 s cache TTL.
 */
import { RedisCacheAdapter } from "@mnemo-ai/adapter-redis";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  POLICY_INVALIDATION_CHANNEL,
  connectPolicyInvalidation,
  createRbacMiddleware,
} from "../../middleware/rbac-policy.js";
import type { RbacDeps } from "../../middleware/rbac-policy.js";

const WS = "ws-redis-invalidation";
const ACTOR = "agent-redis-invalidation";

let container: StartedTestContainer;
let replicaA: RedisCacheAdapter;
let replicaB: RedisCacheAdapter;

beforeAll(async () => {
  container = await new GenericContainer("redis:7.4-alpine").withExposedPorts(6379).start();
  const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  replicaA = new RedisCacheAdapter({ url });
  replicaB = new RedisCacheAdapter({ url });
});

afterAll(async () => {
  await replicaA?.close();
  await replicaB?.close();
  await container?.stop();
});

describe("rbac policy invalidation over Redis pub/sub", () => {
  it("a write on replica A reaches replica B's cache at once", async () => {
    await connectPolicyInvalidation({
      publish: (ch, m) => replicaB.publish(ch, m),
      subscribe: (ch, h) => replicaB.subscribe(ch, h),
    });
    const getPolicy = vi.fn().mockResolvedValue(null);
    const mw = createRbacMiddleware({
      accessPolicies: { getPolicy } as unknown as RbacDeps["accessPolicies"],
      approvals: {} as RbacDeps["approvals"],
    });
    const ctx = {
      req: { method: "POST", path: "/remember", header: () => undefined, query: () => undefined },
      get: (key: string) => (key === "workspaceId" ? WS : key === "actorId" ? ACTOR : undefined),
      header: vi.fn(),
      json: vi.fn(),
    };
    const hit = () => mw(ctx as never, async () => {});

    await hit();
    await hit();
    expect(getPolicy).toHaveBeenCalledTimes(1);

    // Replica A's invalidateAgentPolicy() publishes exactly this message.
    await replicaA.publish(
      POLICY_INVALIDATION_CHANNEL,
      JSON.stringify({ workspaceId: WS, actorId: ACTOR })
    );
    await vi.waitFor(
      async () => {
        await hit();
        expect(getPolicy).toHaveBeenCalledTimes(2);
      },
      { timeout: 2_000, interval: 50 }
    );
  });
});
