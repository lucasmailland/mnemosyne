import { it, expect, vi } from "vitest";
import { buildCronJobs } from "../jobs.js";

it("mnemo.worth.propagate invokes governanceSweep and calls setCanonical for high-worth facts", async () => {
  const setCanonical = vi.fn(async () => {});
  const f = {
    id: "f1",
    worth: 0.95,
    worthAlpha: 40,
    worthBeta: 2,
    pinned: false,
    status: "active",
  };
  const deps = {
    storage: {
      queryFacts: vi.fn(async ({ offset }: any) =>
        offset === 0 ? { items: [f], total: 1 } : { items: [], total: 1 }
      ),
      getFact: vi.fn(async () => f),
      setCanonical,
      updateFact: vi.fn(async () => f),
      enqueueReview: vi.fn(async () => {}),
    },
    cache: { zincrby: vi.fn(async () => 1), zrangeByScore: vi.fn(async () => []) },
    listWorkspaceIds: vi.fn(async () => ["ws1"]),
    collapseStaleSessions: vi.fn(async () => {}),
    llm: undefined,
    fileReader: undefined,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    telemetry: {
      counter: vi.fn(),
      histogram: vi.fn(),
      gauge: vi.fn(),
      startSpan: vi.fn(() => ({ end: vi.fn() })),
      shutdown: vi.fn(),
    },
  } as any;

  const jobs = buildCronJobs(deps);
  const propagate = jobs.find((j) => j.key === "mnemo.governance.propagate")!;
  await propagate.handler();

  expect(setCanonical).toHaveBeenCalledWith("f1", "ws1", true);
});
