/**
 * The members page reads GET /workspace/members at the edge: an answer of the wrong shape is
 * the load error, never a crash, and dates use the one dashboard date format (APP-043, APP-052).
 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { apiGet, getSession } from "@/lib/server-api";
import MembersPage from "../page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/server-api", () => ({ apiGet: vi.fn(), getSession: vi.fn() }));
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

const admin = { userId: "u1", role: "admin", scopes: [], workspaceId: "w" };

it.each([[{ members: "nope", invitations: [] }], [{ members: [] }], [[]]])(
  "APP-043 an answer of the wrong shape (%j) is the load error",
  async (answer) => {
    vi.mocked(getSession).mockResolvedValue(admin as never);
    vi.mocked(apiGet).mockResolvedValue(answer);
    render(await MembersPage());
    expect(screen.getByText(/^Could not load members\./)).toBeInTheDocument();
  }
);

it("APP-052 joined dates use the dashboard's date format, not an ISO string", async () => {
  vi.mocked(getSession).mockResolvedValue(admin as never);
  vi.mocked(apiGet).mockResolvedValue({
    members: [
      {
        userId: "u1",
        email: "a@x.test",
        displayName: null,
        role: "owner",
        joinedAt: "2026-11-03T10:00:00Z",
      },
    ],
    invitations: [],
  });
  render(await MembersPage());
  expect(screen.getByText(/joined Nov 3, 2026/)).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/2026-11-03/);
});

it("APP-040 an API key session is told members need a password sign-in, not that loading failed", async () => {
  vi.mocked(getSession).mockResolvedValue({ ...admin, authMethod: "apiKey" } as never);
  vi.mocked(apiGet).mockResolvedValue(null);
  render(await MembersPage());
  expect(screen.getByText(/signed in with an API key/)).toBeInTheDocument();
  expect(screen.queryByText(/^Could not load members/)).toBeNull();
  expect(document.body.textContent).not.toMatch(/reload/i);
  expect(screen.queryByRole("button")).toBeNull();
});
