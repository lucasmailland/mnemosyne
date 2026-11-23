/**
 * The keys page: active keys (GET /admin/keys never lists a revoked one) each with their actions,
 * and ?create=1 opens the form. Re-opening it from the palette while the page is open is
 * CreateKeyForm's (key-actions.test).
 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { apiGet, apiRead } from "@/lib/server-api";
import KeysPage from "../page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/server-api", () => {
  const apiGet = vi.fn();
  // The page reads its list with the status; by default that is apiGet's answer, a 200.
  const apiRead = vi.fn(async (path: string) => ({ data: await apiGet(path), status: 200 }));
  return { apiGet, apiRead };
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

const key = (id: string) => ({
  id,
  label: `Key ${id}`,
  name: "",
  prefix: "mns_live_ab",
  scopes: ["memory:read"],
  plan: "free",
  ipAllowlist: [],
  expiresAt: null,
  createdAt: "2026-11-01T00:00:00Z",
  lastUsedAt: null,
  deprecatedAt: null,
  sunsetAt: null,
});

it("lists every key with its actions, never faded with opacity", async () => {
  vi.mocked(apiGet).mockResolvedValue({ keys: [key("a"), key("b")] });
  const { container } = render(await KeysPage({ searchParams: Promise.resolve({}) }));
  // `disabled:opacity-50` on buttons is fine; a bare opacity on the row is not.
  const faded = [...container.querySelectorAll("*")].filter((e) =>
    /(^|\s)opacity-/.test(e.getAttribute("class") ?? "")
  );
  expect(faded).toEqual([]);
  expect(screen.getByText("Key a")).toBeTruthy();
  expect(screen.getByText("Key b")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /^Actions for / })).toHaveLength(2);
  // The list sits in a keeper section like the other keeper pages.
  expect(screen.getByRole("region", { name: "API keys" })).toBeTruthy();
});

it("?create=1 opens the form with Label focused; the page keeps one form (no remount)", async () => {
  vi.mocked(apiGet).mockResolvedValue({ keys: [] });
  render(await KeysPage({ searchParams: Promise.resolve({ create: "1" }) }));
  expect(screen.queryByRole("button", { name: "+ Create key" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByLabelText("Label"));
});

it("shows a key's first permissions and the rest behind +N", async () => {
  const scopes = ["memory:read", "memory:write", "memory:delete", "memory:admin", "sessions:read"];
  vi.mocked(apiGet).mockResolvedValue({ keys: [{ ...key("a"), scopes }] });
  render(await KeysPage({ searchParams: Promise.resolve({}) }));
  const shown = screen.getByRole("list", { name: "Permissions of Key a" });
  expect(
    within(shown)
      .getAllByRole("listitem")
      .map((li) => li.textContent)
  ).toEqual(scopes.slice(0, 3));
  fireEvent.click(screen.getByRole("button", { name: "+2 Show all 5: Permissions of Key a" }));
  const all = screen.getByRole("dialog", { name: "Permissions of Key a" });
  expect(within(all).getAllByRole("listitem")).toHaveLength(5);
});

it("APP-040 a 403 shows one access panel naming the permission, and no key action", async () => {
  vi.mocked(apiRead).mockResolvedValue({ data: null, status: 403 });
  render(await KeysPage({ searchParams: Promise.resolve({ create: "1" }) }));
  expect(screen.getByTestId("access-denied")).toHaveTextContent("admin:keys");
  expect(screen.getByRole("heading", { name: "You do not have access to this page" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "+ Create key" })).toBeNull();
  expect(screen.queryByLabelText("Label")).toBeNull();
  expect(document.body.textContent).not.toMatch(/reload/i);
});

it("APP-043 a timeout says the server took too long, not that the keys are missing", async () => {
  vi.mocked(apiRead).mockResolvedValue({ data: null, status: null, timedOut: true });
  render(await KeysPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByText(/The server took too long to answer/)).toBeTruthy();
});
