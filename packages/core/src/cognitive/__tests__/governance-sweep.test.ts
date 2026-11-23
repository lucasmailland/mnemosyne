import { it, expect, vi } from "vitest";
import { governanceSweep, type GovernanceDeps } from "../index.js";

function fact(id: string, worth: number, a: number, b: number) {
  return { id, worth, worthAlpha: a, worthBeta: b, pinned: false, workspaceId: "ws1", status: "active" } as any;
}

it("pages through facts and tallies actions", async () => {
  const facts = [fact("hi", 0.95, 40, 2), fact("lo", 0.9, 2, 2)]; // canonical, neutral(low conf)
  const queryFacts = vi.fn(async ({ offset }: any) =>
    offset === 0 ? { items: facts, total: 2 } : { items: [], total: 2 });
  const deps = {
    storage: {
      queryFacts,
      getFact: vi.fn(async (id: string) => facts.find((f) => f.id === id) ?? null),
      setCanonical: vi.fn(async () => {}),
      updateFact: vi.fn(async (_id: string) => ({} as any)),
      enqueueReview: vi.fn(async () => {}),
    },
    cache: { zincrby: vi.fn(async () => 1), zrangeByScore: vi.fn(async () => []) },
    maxHotTierSize: 1000,
  } as unknown as GovernanceDeps & { storage: any };

  const tally = await governanceSweep(deps, "ws1", { pageSize: 200 });
  expect(tally.canonical).toBe(1);
  expect(tally.neutral).toBe(1);
  expect(queryFacts).toHaveBeenCalledTimes(1); // short page → stop
});

it("respects maxFacts bound", async () => {
  const queryFacts = vi.fn(async ({ offset }: any) => ({
    items: Array.from({ length: 200 }, (_, i) => fact(`f${offset + i}`, 0.5, 2, 2)),
    total: 10000,
  }));
  const deps = {
    storage: { queryFacts, getFact: vi.fn(async () => fact("x", 0.5, 2, 2)), setCanonical: vi.fn(), updateFact: vi.fn(), enqueueReview: vi.fn() },
    cache: { zincrby: vi.fn(async () => 1) },
    maxHotTierSize: 1000,
  } as any;
  await governanceSweep(deps, "ws1", { maxFacts: 400, pageSize: 200 });
  expect(queryFacts).toHaveBeenCalledTimes(2); // 400/200
});
