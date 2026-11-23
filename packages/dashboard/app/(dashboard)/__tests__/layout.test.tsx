import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import DashboardLayout from "../layout";
import { getSession, redirectToLogin } from "@/lib/server-api";

vi.mock("@/lib/server-api", () => ({
  getSession: vi.fn(),
  redirectToLogin: vi.fn(async () => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
let pathname = "/recall";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace: vi.fn() }),
  redirect: vi.fn(),
}));
afterEach(() => {
  cleanup();
  pathname = "/recall";
});

it("shows the room header of the current path as the page's level-1 heading", async () => {
  vi.mocked(getSession).mockResolvedValue({
    role: "admin",
    workspaceName: "Alfa",
  } as Awaited<ReturnType<typeof getSession>>);
  render(await DashboardLayout({ children: <p>Body</p> }));
  expect(
    screen.getByRole("heading", { level: 1, name: "Recall — The waters of Lethe" })
  ).toBeTruthy();
  expect(screen.getByText("Body")).toBeTruthy();
});

it.each([
  ["/", false],
  ["/relations", false],
  ["/browser", true],
])("room header strip for %s: %s", async (path, shown) => {
  pathname = path;
  vi.mocked(getSession).mockResolvedValue({
    role: "admin",
    workspaceName: "Alfa",
  } as Awaited<ReturnType<typeof getSession>>);
  const { container } = render(await DashboardLayout({ children: <p>Body</p> }));
  expect(!!container.querySelector("main > header")).toBe(shown);
  expect(screen.queryByRole("heading", { level: 1 }) !== null).toBe(shown);
});

it("translates the superadmin read-only banner", async () => {
  vi.mocked(getSession).mockResolvedValue({
    role: "viewer",
    viaInstance: true,
    workspaceName: "Alfa",
  } as Awaited<ReturnType<typeof getSession>>);
  render(await DashboardLayout({ children: null }));
  expect(screen.getByText(/Viewing as superadmin/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to all workspaces" })).toBeTruthy();
});

it("APP-041 without a session it leaves for the login through redirectToLogin (which keeps the address)", async () => {
  vi.mocked(getSession).mockResolvedValue(null);
  await expect(DashboardLayout({ children: <p>Body</p> })).rejects.toThrow("NEXT_REDIRECT");
  expect(redirectToLogin).toHaveBeenCalledTimes(1);
});

it("APP-058 the first focusable element skips to the main content", async () => {
  vi.mocked(getSession).mockResolvedValue({
    role: "admin",
    workspaceName: "Alfa",
  } as Awaited<ReturnType<typeof getSession>>);
  const { container } = render(await DashboardLayout({ children: <p>Body</p> }));
  const first = container.querySelector<HTMLElement>("a[href], button, input, select, textarea");
  expect(first).toHaveTextContent("Skip to content");
  expect(first).toHaveAttribute("href", "#main-content");
  expect(first?.className).toContain("sr-only");
  expect(first?.className).toContain("focus:not-sr-only");
  expect(container.querySelector("main")).toHaveAttribute("id", "main-content");
  expect(container.querySelector("main")).toHaveAttribute("tabIndex", "-1");
});

it("APP-058 an installation address seen by a non-superadmin draws no room header (only the 404's h1)", async () => {
  pathname = "/installation/users";
  vi.mocked(getSession).mockResolvedValue({
    role: "admin",
    isSuperadmin: false,
    workspaceName: "Alfa",
  } as Awaited<ReturnType<typeof getSession>>);
  const { container } = render(await DashboardLayout({ children: <h1>Not found</h1> }));
  expect(container.querySelector("main > header")).toBeNull();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(container.textContent).not.toMatch(/architecture/i);
  cleanup();
  // A superadmin keeps it.
  vi.mocked(getSession).mockResolvedValue({
    role: "admin",
    isSuperadmin: true,
    workspaceName: "Alfa",
  } as Awaited<ReturnType<typeof getSession>>);
  const again = render(await DashboardLayout({ children: null }));
  expect(again.container.querySelector("main > header")).not.toBeNull();
});
