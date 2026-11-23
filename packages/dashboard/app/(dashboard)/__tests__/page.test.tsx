import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import HomePage from "../(home)/page";
import { apiGet, getSession } from "@/lib/server-api";
vi.mock("@/lib/server-api", () => ({ apiGet: vi.fn(), getSession: vi.fn() }));
// Home's "needs you" section refreshes through the router.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const memberStats = {
  workspaceId: "w",
  generatedAt: new Date().toISOString(),
  facts: { live: 3, closed: 0, pinned: 0 },
  decisions: { active: 1 },
  relations: { conflicts: 0 },
  recall: { lastRecallAt: null, hitRate30d: null, latencyP50Ms7d: null, latencyP95Ms7d: null },
  lastWriteAt: null,
  writesPerDay14d: Array.from({ length: 14 }, (_, i) => ({ day: `2020-01-${i + 10}`, count: 1 })),
};

it.each(["viewer", "contributor"] as const)(
  "AUTH-14 %s sees the figures and the day through trimmed stats, without admin-only notices",
  async (role) => {
    vi.mocked(getSession).mockResolvedValue({ role, scopes: ["memory:read"] } as never);
    vi.mocked(apiGet).mockImplementation((async (path: string) =>
      path.startsWith("/admin/stats")
        ? memberStats
        : path.startsWith("/timeline")
          ? {
              events: [
                {
                  id: "e1",
                  at: new Date().toISOString(),
                  kind: "created",
                  factId: "f1",
                  summary: "A recent memory",
                },
              ],
              nextCursor: null,
            }
          : { pairs: [] }) as never);
    render(await HomePage());
    expect(apiGet).toHaveBeenCalledWith("/admin/stats");
    expect(screen.getByText("A recent memory")).toBeInTheDocument();
    expect(screen.getByTestId("atrium-figures")).toBeInTheDocument();
    expect(screen.queryByText(/available to workspace administrators/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not load workspace stats/)).not.toBeInTheDocument();
  }
);
it("AUTH-14 a failed stats request has a distinct loading error", async () => {
  vi.mocked(getSession).mockResolvedValue({ role: "admin", scopes: ["memory:admin"] } as never);
  vi.mocked(apiGet).mockResolvedValue(null);
  render(await HomePage());
  expect(apiGet).toHaveBeenCalledWith("/admin/stats");
  expect(screen.getByText(/Could not load workspace stats/)).toBeInTheDocument();
});
