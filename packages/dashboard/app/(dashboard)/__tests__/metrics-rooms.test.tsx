/**
 * The metrics band of each room: every figure is read from its server aggregate, and a source
 * that fails reads "No data" (a tile) or "Could not load" (a chart), never a zero.
 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { apiGet } from "@/lib/server-api";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));
vi.mock("@/lib/server-api", () => {
  const apiGet = vi.fn();
  return {
    apiGet,
    // Pages that need the status read through apiRead; here it is apiGet's answer, a 200.
    apiRead: vi.fn(async (path: string) => ({ data: (await apiGet(path)) ?? null, status: 200 })),
    getSession: vi.fn(),
    requireSuperadmin: vi.fn(),
  };
});
vi.mock("@/lib/i18n/server", async () => {
  const { translate } = await import("@/lib/i18n/core");
  const { en } = await import("@/lib/i18n/messages/en");
  return {
    getLocale: async () => "en-US",
    getT: async () => (key: string, vars?: Record<string, string | number>) =>
      translate(en, key as never, vars, "en-US"),
    roomTitle: () => async () => ({}),
  };
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function serve(routes: Record<string, unknown>) {
  vi.mocked(apiGet).mockImplementation((async (path: string) =>
    path in routes ? routes[path] : null) as never);
}

const values = () =>
  within(screen.getByTestId("metrics-band"))
    .getAllByTestId("stat-value")
    .map((v) => v.textContent);

const day = (i: number) => new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);

it("Recall and Graph: the room is not held behind its figures, which stream in under a skeleton", async () => {
  for (const path of ["../recall/layout", "../relations/layout"]) {
    const { default: Layout } = (await import(path)) as typeof import("../recall/layout");
    // The layout returns without waiting on the API; the figures fetch under its Suspense.
    await Layout({ children: <p>room</p> });
    expect(apiGet).not.toHaveBeenCalled();
  }
});

it("Recall: recalls, hit rate and latency over 30 days", async () => {
  const { LoadedRecallFigures } = await import("../recall/figures");
  serve({
    "/recall/metrics?days=30": {
      days: [29, 0].map((i) => ({
        day: day(i),
        queries: 5,
        zeroHitShare: 0.2,
        p50Ms: 30,
        p95Ms: 90,
      })),
      totals: { queries: 10, zeroHitShare: 0.2, p50Ms: 30, p95Ms: 90 },
    },
  });
  render(await LoadedRecallFigures());
  expect(values()).toEqual(["10", "80%", "30 ms"]);
  expect(screen.getByText("20% found nothing")).toBeInTheDocument();
  expect(screen.getByText("p95 90 ms")).toBeInTheDocument();
});

it("Recall: an unreadable source is no data, not zero", async () => {
  const { LoadedRecallFigures } = await import("../recall/figures");
  serve({});
  render(await LoadedRecallFigures());
  expect(values()).toEqual(["—No data", "—No data", "—No data"]);
  expect(screen.getAllByText(/Could not load this chart/)).toHaveLength(2);
});

it("Sessions: sessions, collapse share, turns and episodes over 30 days", async () => {
  const { default: Page } = await import("../sessions/page");
  serve({
    "/episodes?limit=50": {
      items: [{ id: "ep_1", title: "Launch", narrative: "", occurredAt: new Date().toISOString() }],
    },
    "/session/stats?days=30": {
      days: [{ day: day(0), active: 1, collapsed: 2, archived: 1 }],
      totals: { sessions: 4, collapsed: 2, avgTurns: 4.25, episodes: 3, factsPerEpisode: 2 },
      topics: [{ topic: "checkout", count: 2 }],
    },
  });
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(values()).toEqual(["4", "50%", "4.3", "3"]);
  expect(screen.getByText("2 memories each")).toBeInTheDocument();
  expect(screen.getAllByText("checkout").length).toBeGreaterThan(0);
});

it("Graph: entities, relations, conflicts and unlinked entities, under the sky", async () => {
  const { LoadedGraphFigures } = await import("../relations/figures");
  serve({
    "/graph/stats": {
      entities: 8,
      decisions: 2,
      episodes: 6,
      relations: 12,
      conflicts: 1,
      isolated: 2,
      entitiesByKind: [],
      relationsByType: [{ relation: "part_of", count: 12 }],
      hubs: [{ id: "e1", label: "Atlas", degree: 5 }],
    },
  });
  render(await LoadedGraphFigures());
  expect(values()).toEqual(["8", "12", "1", "2"]);
  expect(screen.getByText("2 of 8")).toBeInTheDocument();
  expect(screen.getAllByText("Atlas").length).toBeGreaterThan(0);
});

it("Config: mode, the way to production, embeddings and retention, with memory by sensitivity", async () => {
  const { getSession } = await import("@/lib/server-api");
  vi.mocked(getSession).mockResolvedValue({
    role: "admin",
    workspaceId: "w",
    plan: "free",
  } as never);
  const { default: Page } = await import("../config/page");
  serve({
    "/workspace-mode": {
      mode: "learning",
      sessionCount: 1,
      promoteAt: null,
      startedAt: new Date().toISOString(),
      factCount: 20,
      entityCount: 1,
    },
    "/facts/stats": {
      live: 4,
      pinned: 0,
      neverRecalled: 0,
      byKind: [],
      bySensitivity: [{ sensitivity: "internal", count: 4 }],
    },
    "/admin/config/retention": {
      internalDays: 365,
      confidentialDays: 90,
      restrictedDays: 30,
      transcriptDays: 7,
    },
    "/admin/stats": { embeddings: { indexed: 3, pending: 1 } },
  });
  render(await Page());
  expect(values()).toEqual(["Learning", "40%", "75%", "7 days"]);
  expect(screen.getByText("20 of 50 facts")).toBeInTheDocument();
  expect(screen.getAllByText("internal · kept 365 days").length).toBeGreaterThan(0);
});

it("My workspaces: count, owned against the limit, memories, per workspace", async () => {
  const { getSession } = await import("@/lib/server-api");
  vi.mocked(getSession).mockResolvedValue({ authMethod: "password" } as never);
  const { default: Page } = await import("../workspaces/page");
  const ws = (id: string, factsLive: number | null) => ({
    id,
    name: id,
    role: "owner",
    isPersonal: false,
    current: false,
    factsLive,
    lastWriteAt: null,
    memberCount: 1,
  });
  serve({
    "/my-workspaces": {
      workspaces: [ws("Atlas", 30), ws("Orchester", 10), ws("Broken", null)],
      ownedTeamCount: 2,
      limit: 5,
    },
  });
  render(await Page());
  expect(values()).toEqual(["3", "2", "40"]);
  expect(screen.getByText("2 of 5 allowed")).toBeInTheDocument();
  expect(screen.getByText("in 2 of 3 workspaces")).toBeInTheDocument();
});

it("Members: members, active this week, pending and expiring invitations, by role", async () => {
  const { getSession } = await import("@/lib/server-api");
  vi.mocked(getSession).mockResolvedValue({ role: "admin", userId: "u1" } as never);
  const { default: Page } = await import("../admin/members/page");
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const later = new Date(Date.now() + 20 * 86_400_000).toISOString();
  serve({
    "/workspace/members": {
      members: [
        {
          userId: "u1",
          email: "a@x.test",
          displayName: null,
          role: "owner",
          joinedAt: day(40),
          lastActiveAt: new Date().toISOString(),
        },
        {
          userId: "u2",
          email: "b@x.test",
          displayName: null,
          role: "read",
          joinedAt: day(10),
          lastActiveAt: null,
        },
      ],
      invitations: [
        { id: "i1", email: "c@x.test", role: "read", expiresAt: soon },
        { id: "i2", email: "d@x.test", role: "write", expiresAt: later },
      ],
    },
  });
  render(await Page());
  expect(values()).toEqual(["2", "1", "2", "1"]);
  expect(screen.getByText(/last active/)).toBeInTheDocument();
});

it("Keys: active, idle, expiring and rotated keys, by scope and ceiling", async () => {
  const { default: Page } = await import("../admin/keys/page");
  const key = (id: string, over: Record<string, unknown>) => ({
    id,
    label: id,
    name: id,
    prefix: "mns_",
    scopes: ["memory:read"],
    plan: "free",
    ipAllowlist: [],
    expiresAt: null,
    createdAt: day(60),
    lastUsedAt: new Date().toISOString(),
    deprecatedAt: null,
    sunsetAt: null,
    ...over,
  });
  serve({
    "/admin/keys": {
      keys: [
        key("k1", {}),
        key("k2", {
          lastUsedAt: null,
          expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        }),
        key("k3", { deprecatedAt: day(1), maxSensitivity: "internal" }),
      ],
    },
  });
  render(await Page({}));
  expect(values()).toEqual(["3", "1", "1", "1"]);
  expect(screen.getAllByText("Installation default").length).toBeGreaterThan(0);
});

it("Health: checks, embeddings, snapshot age and readiness, with recall health over 30 days", async () => {
  const { default: Page } = await import("../admin/health/page");
  serve({
    "/doctor": {
      status: "warn",
      checks: [
        { name: "a", status: "ok" },
        { name: "b", status: "ok" },
        { name: "c", status: "warn" },
      ],
      timestamp: new Date().toISOString(),
    },
    "/health": { embeddings: { indexed: 9, pending: 1 } },
    "/health/snapshots?days=30": {
      days: [2, 1, 0].map((i) => ({
        day: day(i),
        recallHitRate30d: i === 0 ? null : 0.5,
        zeroHitShare: i === 0 ? null : 0.3,
        embeddedShare: i === 0 ? null : 1,
        failedJobs7d: i === 0 ? null : 0,
      })),
    },
    "/health/history": {
      items: [{ status: "ok" }, { status: "ok" }, { status: "degraded" }, { status: "ok" }],
    },
  });
  render(await Page());
  expect(values()).toEqual(["2", "90%", "1 day", "75%"]);
  expect(screen.getByText("of 3 · 1 warn · 0 failing")).toBeInTheDocument();
});

it("Audit: entries, forgets and archives over 30 days, per day", async () => {
  const { default: Page } = await import("../admin/audit/page");
  serve({
    "/audit/stats?days=30": {
      days: [{ day: day(0), user: 2, system: 5 }],
      totals: { user: 2, system: 5 },
    },
  });
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(values()).toEqual(["7", "2", "5"]);
});

it("Account: role, permissions, own activity and personal memories", async () => {
  const { getSession } = await import("@/lib/server-api");
  vi.mocked(getSession).mockResolvedValue({
    role: "admin",
    workspaceRole: "owner",
    scopes: ["memory:read", "memory:write"],
    authMethod: "password",
  } as never);
  const { default: Page } = await import("../account/page");
  serve({
    "/me/activity?days=30": {
      days: [{ day: day(0), count: 4 }],
      byAction: [{ action: "recall", count: 4 }],
      lastAt: new Date().toISOString(),
    },
    "/my-workspaces": { workspaces: [{ isPersonal: true, factsLive: 12 }] },
  });
  render(await Page());
  expect(values()).toEqual(["Owner", "2", "4", "12"]);
});

it("Installation › Users: accounts, signed in this week, disabled, never signed in", async () => {
  const { requireSuperadmin } = await import("@/lib/server-api");
  vi.mocked(requireSuperadmin).mockResolvedValue({ userId: "s1" } as never);
  const { default: Page } = await import("../installation/users/page");
  const user = (id: string, lastLoginAt: string | null, disabledAt: string | null = null) => ({
    id,
    email: `${id}@x.test`,
    displayName: null,
    createdAt: day(90),
    lastLoginAt,
    disabledAt,
    isSuperadmin: false,
    workspaces: [],
  });
  serve({
    "/instance/users": {
      users: [user("a", new Date().toISOString()), user("b", day(20)), user("c", null, day(1))],
    },
  });
  render(await Page());
  expect(values()).toEqual(["3", "1", "1", "1"]);
  expect(screen.getByText("2 in 30 days")).toBeInTheDocument();
});

it("Installation › Workspaces: workspaces, team, personal, dormant, the largest", async () => {
  const { requireSuperadmin } = await import("@/lib/server-api");
  vi.mocked(requireSuperadmin).mockResolvedValue({ userId: "s1" } as never);
  const { default: Page } = await import("../installation/workspaces/page");
  const ws = (id: string, isPersonal: boolean, factsLive: number, lastWriteAt: string | null) => ({
    id,
    name: id,
    tenantName: "t",
    isPersonal,
    visibility: "private",
    memberCount: 1,
    owners: [],
    factsLive,
    lastWriteAt,
  });
  serve({
    "/instance/workspaces": {
      workspaces: [ws("Atlas", false, 30, new Date().toISOString()), ws("Mine", true, 0, null)],
    },
  });
  render(await Page());
  expect(values()).toEqual(["2", "1", "1", "1"]);
});

it("Installation › Security audit: events, failed sign-ins, the commonest action", async () => {
  const { requireSuperadmin } = await import("@/lib/server-api");
  vi.mocked(requireSuperadmin).mockResolvedValue({ userId: "s1" } as never);
  const { default: Page } = await import("../installation/audit/page");
  serve({
    "/instance/audit/stats?days=30": {
      days: [{ day: day(0), count: 9 }],
      byAction: [
        { action: "login_success", count: 6 },
        { action: "login_failure", count: 3 },
      ],
      failedSignIns7d: 3,
    },
  });
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(values()).toEqual(["9", "3", "Signed in"]);
});
