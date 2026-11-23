/**
 * APP-043: every room has a loading skeleton shaped like it, announced politely and marked busy,
 * instead of a frozen page while the server render waits on the API.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import HomeLoading from "@/app/(dashboard)/(home)/loading";
import AccountLoading from "@/app/(dashboard)/account/loading";
import AdminLoading from "@/app/(dashboard)/admin/loading";
import ConfigLoading from "@/app/(dashboard)/config/loading";
import WorkspacesLoading from "@/app/(dashboard)/workspaces/loading";
import BrowserLoading from "@/app/(dashboard)/browser/loading";
import RecallLoading from "@/app/(dashboard)/recall/loading";
import RelationsLoading from "@/app/(dashboard)/relations/loading";
import SessionsLoading from "@/app/(dashboard)/sessions/loading";

vi.mock("@/lib/i18n/server", async () => {
  const { translate } = await import("@/lib/i18n/core");
  const { es } = await import("@/lib/i18n/messages/es");
  return {
    getT: async () => (key: string, vars?: Record<string, string | number>) =>
      translate(es, key as never, vars, "es-419"),
  };
});
afterEach(cleanup);

it.each([
  ["home", HomeLoading, "figures"],
  ["account", AccountLoading, "figures"],
  ["admin", AdminLoading, "figures"],
  ["config", ConfigLoading, "figures"],
  ["workspaces", WorkspacesLoading, "figures"],
  ["browser", BrowserLoading, "list"],
  ["recall", RecallLoading, "search"],
  ["relations", RelationsLoading, "sky"],
  ["sessions", SessionsLoading, "grid"],
])(
  "the %s room shows a busy, politely announced skeleton of its layout",
  async (_, Loading, shape) => {
    render(await Loading());
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Cargando…");
    expect(status).toHaveAttribute("data-shape", shape);
  }
);

// A loading.tsx is a Suspense boundary: once its fallback has streamed, the status is already
// 200, so a notFound() below it renders the 404 page with HTTP 200 (crawlers, monitors).
const APP = join(__dirname, "../../app");
const GROUP = join(APP, "(dashboard)");
const pages = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === "__tests__"
        ? []
        : pages(join(dir, e.name))
      : e.name === "page.tsx"
        ? [join(dir, e.name)]
        : []
  );
const boundariesAbove = (page: string): string[] => {
  const found: string[] = [];
  for (let dir = dirname(page); dir.startsWith(APP); dir = dirname(dir))
    if (existsSync(join(dir, "loading.tsx"))) found.push(relative(APP, join(dir, "loading.tsx")));
  return found;
};
const canNotFound = (page: string) =>
  /\bnotFound\(\)|\brequireSuperadmin\(\)/.test(readFileSync(page, "utf8"));
const roomPages = pages(GROUP);

it("a page that can answer 404 has no loading boundary above it, so the status stays 404", () => {
  const notFoundPages = roomPages.filter(canNotFound);
  expect(notFoundPages.length).toBeGreaterThanOrEqual(5);
  expect(
    notFoundPages.map((p) => [relative(APP, p), boundariesAbove(p)]).filter(([, b]) => b.length)
  ).toEqual([]);
});

it("every other room still has a loading skeleton above its page", () => {
  expect(
    roomPages
      .filter((p) => !canNotFound(p))
      .filter((p) => boundariesAbove(p).length === 0)
      .map((p) => relative(APP, p))
  ).toEqual([]);
});
