/**
 * The Account page reads the theme cookie on the server; without one (or without a request) it
 * shows System: a reader who never chose follows the OS (APP-058).
 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { getSession } from "@/lib/server-api";
import AccountPage from "../page";

let themeCookie: string | undefined;
let cookiesThrow = false;
vi.mock("next/headers", () => ({
  cookies: async () => {
    if (cookiesThrow) throw new Error("cookies() outside a request scope");
    return { get: () => (themeCookie === undefined ? undefined : { value: themeCookie }) };
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/server-api", () => ({ getSession: vi.fn(), apiGet: vi.fn(async () => null) }));
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
  themeCookie = undefined;
  cookiesThrow = false;
});

const checked = (name: string) => (screen.getByRole("radio", { name }) as HTMLInputElement).checked;

it.each([
  ["the dark cookie", "dark", false, "Dark"],
  ["the light cookie", "light", false, "Light"],
  ["no cookie", undefined, false, "System"],
  ["a value it does not know", "sepia", false, "System"],
  ["no request scope", "dark", true, "System"],
])("with %s the theme radio shows %s", async (_, cookie, throws, expected) => {
  themeCookie = cookie;
  cookiesThrow = throws;
  vi.mocked(getSession).mockResolvedValue(null);
  render(await AccountPage());
  expect(checked(expected)).toBe(true);
});

it("offers the password form only to a password session", async () => {
  vi.mocked(getSession).mockResolvedValue({ authMethod: "apiKey" } as never);
  render(await AccountPage());
  expect(screen.queryByLabelText("New password")).toBeNull();
  cleanup();
  vi.mocked(getSession).mockResolvedValue({ authMethod: "password" } as never);
  render(await AccountPage());
  expect(screen.getByLabelText("New password")).toBeTruthy();
});
