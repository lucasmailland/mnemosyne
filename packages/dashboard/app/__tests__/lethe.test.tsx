// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/client";

import ErrorPage from "../error";
import GlobalError, { GLOBAL_ERROR_STRINGS } from "../global-error";
import { en } from "@/lib/i18n/messages/en";
import { es } from "@/lib/i18n/messages/es";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import NotFound from "../not-found";
import DashboardNotFound from "../(dashboard)/not-found";
import MissingPage from "../(dashboard)/[...missing]/page";

vi.mock("../fonts", () => ({ fontVariables: "" }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh }),
}));

afterEach(() => {
  cleanup();
  refresh.mockClear();
  document.cookie = "mnemo_locale=; Max-Age=0";
});

it("not found: h1 leads with the functional name, link back to the login", () => {
  const { container } = render(<NotFound />);
  expect(
    screen.getByRole("heading", { level: 1, name: "Not found — This page was never written." })
  ).toBeTruthy();
  expect(screen.getByText("404")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
  expect(container.querySelector("img")?.getAttribute("width")).toBe("240");
});

it("an unknown path inside the dashboard throws the group's not-found, so the shell stays", () => {
  let thrown: unknown;
  try {
    MissingPage();
  } catch (error) {
    thrown = error;
  }
  expect((thrown as { digest?: string } | undefined)?.digest).toMatch(/404/);
});

it("not found inside the dashboard links to the atrium, in Spanish", () => {
  render(
    <I18nProvider locale="es-419">
      <DashboardNotFound />
    </I18nProvider>
  );
  expect(
    screen.getByRole("heading", {
      level: 1,
      name: "No encontrada — Esta página nunca se escribió.",
    })
  ).toBeTruthy();
  expect(screen.getByRole("link", { name: "Volver al atrio" }).getAttribute("href")).toBe("/");
});

it("error: shows the digest; Try again refreshes the server data and resets the boundary", () => {
  const reset = vi.fn();
  render(<ErrorPage error={Object.assign(new Error("x"), { digest: "abc123" })} reset={reset} />);
  expect(
    screen.getByRole("heading", { level: 1, name: "Error — Something was lost on the way." })
  ).toBeTruthy();
  expect(screen.getByText("abc123").className).toContain("font-mono");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  // A server component's error comes back only after a refresh: reset alone re-renders the old one.
  expect(refresh).toHaveBeenCalledOnce();
  expect(reset).toHaveBeenCalledOnce();
});

it("error without a digest shows no reference", () => {
  render(<ErrorPage error={new Error("x")} reset={() => {}} />);
  expect(screen.queryByText(/Reference/)).toBeNull();
});

it("global error picks Spanish from the cookie", async () => {
  document.cookie = "mnemo_locale=es-419";
  const reset = vi.fn();
  render(<GlobalError error={new Error("x")} reset={reset} />);
  expect(
    await screen.findByRole("heading", { level: 1, name: /Algo se perdió en el camino\./ })
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Inténtalo de nuevo" }));
  expect(reset).toHaveBeenCalledOnce();
  // "…o vuelve al inicio": the start is a link.
  expect(screen.getByRole("link", { name: "Ir al panel" }).getAttribute("href")).toBe("/dashboard");
});

it("global error's inline strings equal the dictionaries", () => {
  for (const [locale, d] of [
    ["en-US", en],
    ["es-419", es],
  ] as const) {
    const s = GLOBAL_ERROR_STRINGS[locale];
    expect(s).toEqual({
      errorName: d.lethe.errorName,
      errorTitle: d.lethe.errorTitle,
      errorBody: d.lethe.errorBody,
      reference: d.lethe.reference,
      retry: d.common.retry,
      toDashboard: d.lethe.toDashboard,
    });
  }
});

it("error sets the document title, focuses the h1 and restores the title", () => {
  document.title = "Before";
  const { unmount } = render(<ErrorPage error={new Error("x")} reset={() => {}} />);
  expect(document.title).toBe("Error · Mnemosyne");
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  unmount();
  expect(document.title).toBe("Before");
});

it("the root error links to the dashboard", () => {
  render(<ErrorPage error={new Error("x")} reset={() => {}} />);
  expect(screen.getByRole("link", { name: "Go to the dashboard" })).toBeTruthy();
});

it("the scene hides the room header strip via the stylesheet rule", () => {
  const css = readFileSync(resolve(__dirname, "../globals.css"), "utf8");
  expect(css).toContain("main:has([data-lethe]) > header");
  // The structure the dashboard layout renders: main > header + div > scene.
  const { container } = render(
    <main>
      <header />
      <div>
        <DashboardNotFound />
      </div>
    </main>
  );
  expect(container.querySelector("main > div [data-lethe]")).toBeTruthy();
  expect(container.querySelectorAll("main > header").length).toBe(1);
});
