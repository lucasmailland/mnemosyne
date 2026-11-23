import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Locale } from "@/lib/i18n/core";
import { apiGet } from "@/lib/server-api";
import SessionsPage from "../sessions/page";

let locale: Locale = "en-US";
// The status a failed read answers with, by path (apiRead); 404 when not set.
const statuses = vi.hoisted(() => new Map<string, number>());
vi.mock("@/lib/server-api", () => {
  const apiGet = vi.fn();
  return {
    apiGet,
    getSession: vi.fn(),
    // Not a vi.fn: resetAllMocks must not wipe it. It reads through the apiGet mock.
    apiRead: async (path: string) => {
      const data = (await apiGet(path)) ?? null;
      return { data, status: data === null ? (statuses.get(path) ?? 404) : 200 };
    },
  };
});
vi.mock("@/lib/i18n/server", async () => {
  const { translate } = await import("@/lib/i18n/core");
  const { en } = await import("@/lib/i18n/messages/en");
  const { es } = await import("@/lib/i18n/messages/es");
  return {
    getLocale: async () => locale,
    getT: async () => (key: string, vars?: Record<string, string | number>) =>
      translate(locale === "es-419" ? es : en, key as never, vars, locale),
    roomTitle: () => async () => ({}),
  };
});

beforeEach(() => {
  locale = "en-US";
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  statuses.clear();
});

const episode = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Title of ${id}`,
  narrative: `Narrative of ${id}`,
  occurredAt: "2026-08-12T09:30:00.000Z",
  durationMinutes: 45,
  participants: ["Ana", "claude-code"],
  topics: ["checkout", "codes"],
  linkedFactIds: ["f1", "f2"],
  sourceConversationId: "conv_abc123",
  ...over,
});

function serve(opts: {
  list?: unknown;
  eps?: Record<string, unknown>;
  facts?: Record<string, unknown>;
  timeline?: unknown;
}) {
  vi.mocked(apiGet).mockImplementation((async (path: string) => {
    if (path.startsWith("/episodes?")) return opts.list ?? { items: [] };
    const tl = path.match(/^\/episodes\/([^/]+)\/timeline$/);
    if (tl) return opts.timeline ?? null;
    const ep = path.match(/^\/episodes\/([^/?]+)$/);
    if (ep) return opts.eps?.[decodeURIComponent(ep[1]!)] ?? null;
    const f = path.match(/^\/facts\/([^/?]+)\?includeClosed=true$/);
    if (f) return opts.facts?.[decodeURIComponent(f[1]!)] ?? null;
    return null;
  }) as never);
}

const fact = (id: string) => ({
  id,
  content: `Statement of ${id}`,
  validFrom: "2026-08-12T00:00:00.000Z",
  createdAt: "2026-08-12T00:00:00.000Z",
});

const page = async (sp: Record<string, string | undefined> = {}) =>
  render(await SessionsPage({ searchParams: Promise.resolve(sp) }));

it("renders a niche per episode with date, title, duration, topics and fact count", async () => {
  serve({ list: { items: [episode("mepi_1"), episode("mepi_2", { linkedFactIds: [] })] } });
  await page();
  const grid = screen.getByTestId("columbarium-grid");
  const cards = within(grid).getAllByRole("link");
  expect(cards).toHaveLength(2);
  expect(within(cards[0]!).getByText("Title of mepi_1")).toBeInTheDocument();
  expect(within(cards[0]!).getByText(/Aug 12, 2026/)).toBeInTheDocument();
  expect(within(cards[0]!).getByText("45 min")).toBeInTheDocument();
  expect(within(cards[0]!).getByText(/checkout/)).toBeInTheDocument();
  expect(within(cards[0]!).getByText("2 facts")).toBeInTheDocument();
  expect(within(cards[1]!).getByText("0 facts")).toBeInTheDocument();
  expect(cards[0]).toHaveAttribute("href", "/sessions?open=mepi_1");
  expect(screen.queryByTestId("columbarium-niche")).not.toBeInTheDocument();
});

it("?open shows narrative, participants, session id, the timeline and the produced facts", async () => {
  serve({
    list: { items: [episode("mepi_1")] },
    eps: { mepi_1: { episode: episode("mepi_1"), linkedFacts: [] } },
    timeline: {
      events: [
        { kind: "episode_created", occurredAt: "2026-08-12T09:30:00.000Z", detail: {} },
        { kind: "fact_linked", occurredAt: "2026-08-12T09:40:00.000Z", detail: { factId: "f1" } },
      ],
    },
    facts: { f1: fact("f1"), f2: fact("f2") },
  });
  await page({ open: "mepi_1", other: "x" });
  const niche = screen.getByTestId("columbarium-niche");
  expect(within(niche).getByText("Narrative of mepi_1")).toBeInTheDocument();
  expect(within(niche).getByText("Ana, claude-code")).toBeInTheDocument();
  expect(within(niche).getByText("conv_abc123")).toHaveClass("font-mono");
  const tl = within(niche).getByTestId("columbarium-timeline");
  expect(within(tl).getAllByRole("listitem")).toHaveLength(2);
  const link = within(niche).getByRole("link", { name: /Statement of f1/ });
  expect(link).toHaveAttribute("href", "/browser?open=f1");
  expect(within(niche).getByRole("link", { name: /Statement of f2/ })).toBeInTheDocument();
  expect(within(niche).getByRole("link", { name: /Back to the niches/ })).toBeInTheDocument();
  expect(apiGet).toHaveBeenCalledWith("/episodes/mepi_1/timeline");
  // Other URL params survive on the niche links.
  expect(within(screen.getByTestId("columbarium-grid")).getAllByRole("link")[0]).toHaveAttribute(
    "href",
    "/sessions?open=mepi_1&other=x"
  );
});

it("caps the produced facts at 10 and says how many are left out", async () => {
  const ids = Array.from({ length: 13 }, (_, i) => `f${i}`);
  serve({
    list: { items: [episode("mepi_1", { linkedFactIds: ids })] },
    eps: { mepi_1: { episode: episode("mepi_1", { linkedFactIds: ids }), linkedFacts: [] } },
    timeline: { events: [] },
    facts: Object.fromEntries(ids.map((i) => [i, fact(i)])),
  });
  await page({ open: "mepi_1" });
  const niche = screen.getByTestId("columbarium-niche");
  expect(within(niche).getAllByRole("link", { name: /Statement of/ })).toHaveLength(10);
  expect(within(niche).getByText("3 more")).toBeInTheDocument();
  const factCalls = vi.mocked(apiGet).mock.calls.filter(([p]) => String(p).startsWith("/facts/"));
  expect(factCalls).toHaveLength(10);
});

it("a failed fact fetch leaves the others", async () => {
  serve({
    list: { items: [episode("mepi_1")] },
    eps: { mepi_1: { episode: episode("mepi_1"), linkedFacts: [] } },
    timeline: { events: [] },
    facts: { f2: fact("f2") }, // f1 is missing -> null
  });
  await page({ open: "mepi_1" });
  const niche = screen.getByTestId("columbarium-niche");
  expect(within(niche).getByRole("link", { name: /Statement of f2/ })).toBeInTheDocument();
  expect(within(niche).getByText("Memory unavailable")).toBeInTheDocument();
});

it("ids are encoded in paths and an unexpected shape is a quiet error, not a crash", async () => {
  serve({
    list: { items: [episode("mepi_1")] },
    eps: { "mepi_x/../y": { nonsense: true } },
  });
  await page({ open: "mepi_x/../y" });
  expect(apiGet).toHaveBeenCalledWith("/episodes/mepi_x%2F..%2Fy");
  expect(screen.getByRole("alert")).toBeInTheDocument();
});

it("malformed list rows are skipped", async () => {
  serve({ list: { items: [episode("mepi_1"), { id: 5 }, null] } });
  await page();
  expect(within(screen.getByTestId("columbarium-grid")).getAllByRole("link")).toHaveLength(1);
});

it("empty list shows the wax tablet and the install command", async () => {
  serve({ list: { items: [] } });
  await page();
  expect(screen.getByText("No sessions have been recorded")).toBeInTheDocument();
  expect(screen.getByText("mnemo install --capture claude-code")).toBeInTheDocument();
});

it("a failed list is an error state", async () => {
  vi.mocked(apiGet).mockResolvedValue(null as never);
  await page();
  expect(screen.getByRole("alert")).toBeInTheDocument();
});

it("renders in Spanish", async () => {
  locale = "es-419";
  serve({
    list: { items: [episode("mepi_1")] },
    eps: { mepi_1: { episode: episode("mepi_1"), linkedFacts: [] } },
    timeline: {
      events: [{ kind: "episode_created", occurredAt: "2026-08-12T09:30:00.000Z", detail: {} }],
    },
    facts: { f1: fact("f1") },
  });
  await page({ open: "mepi_1" });
  expect(screen.getByText("2 hechos")).toBeInTheDocument();
  const niche = screen.getByTestId("columbarium-niche");
  expect(within(niche).getByRole("link", { name: /Volver a los nichos/ })).toBeInTheDocument();
  expect(within(niche).getByText("Participantes")).toBeInTheDocument();
  expect(within(niche).getByText("Hecho no disponible")).toBeInTheDocument();
});

it("caps topics on cards and participants in the niche, with a +N", async () => {
  const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const ep = episode("mepi_1", { topics: many("tp", 6), participants: many("pp", 10) });
  serve({
    list: { items: [ep] },
    eps: { mepi_1: { episode: ep, linkedFactIds: [], linkedFacts: [] } },
    timeline: { events: [] },
  });
  await page({ open: "mepi_1" });
  const card = within(screen.getByTestId("columbarium-grid")).getByRole("link");
  expect(card).toHaveTextContent("tp3 +2");
  expect(card).not.toHaveTextContent("tp4");
  const niche = screen.getByTestId("columbarium-niche");
  expect(niche).toHaveTextContent("pp7 +2");
  expect(niche).not.toHaveTextContent("pp8");
});

it("a failed timeline is told apart from an empty one", async () => {
  serve({
    list: { items: [episode("mepi_1")] },
    eps: { mepi_1: { episode: episode("mepi_1"), linkedFacts: [] } },
    timeline: null,
  });
  await page({ open: "mepi_1" });
  expect(screen.getByText("The timeline could not be loaded.")).toBeInTheDocument();
});

it("an empty narrative skips its block; the open card is aria-current=page", async () => {
  const ep = episode("mepi_1", { narrative: "" });
  serve({
    list: { items: [ep] },
    eps: { mepi_1: { episode: ep, linkedFacts: [] } },
    timeline: { events: [] },
  });
  await page({ open: "mepi_1" });
  const niche = screen.getByTestId("columbarium-niche");
  expect(within(niche).queryByText("Narrative")).not.toBeInTheDocument();
  expect(within(screen.getByTestId("columbarium-grid")).getByRole("link")).toHaveAttribute(
    "aria-current",
    "page"
  );
});

it("?open with an empty list renders no empty grid", async () => {
  serve({ list: { items: [] } });
  await page({ open: "mepi_9" });
  expect(screen.queryByTestId("columbarium-grid")).not.toBeInTheDocument();
});

it("fact ids are encoded in fetches and links", async () => {
  const ep = episode("mepi_1", { linkedFactIds: ["a/b c"] });
  serve({
    list: { items: [ep] },
    eps: { mepi_1: { episode: ep, linkedFacts: [] } },
    timeline: { events: [] },
    facts: { "a/b c": fact("a/b c") },
  });
  await page({ open: "mepi_1" });
  expect(apiGet).toHaveBeenCalledWith("/facts/a%2Fb%20c?includeClosed=true");
  expect(screen.getByRole("link", { name: /Statement of/ })).toHaveAttribute(
    "href",
    "/browser?open=a%2Fb%20c"
  );
});

it("an opened niche comes into view at any width: it always sits under the grid", async () => {
  const scroll = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = scroll;
  // A desktop width: no max-width query matches.
  window.matchMedia = (() => ({ matches: false })) as never;
  const ep = episode("mepi_1");
  serve({ list: { items: [ep] }, eps: { mepi_1: { episode: ep } }, timeline: { events: [] } });
  await page({ open: "mepi_1" });
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Title of mepi_1" }));
});

it("fetches the grid and the open niche together, not one after the other", async () => {
  let nicheAsked: () => void = () => {};
  const asked = new Promise<void>((r) => (nicheAsked = r));
  const ep = episode("mepi_1");
  vi.mocked(apiGet).mockImplementation((async (path: string) => {
    if (path.startsWith("/episodes?")) {
      await asked;
      return { items: [ep] };
    }
    if (path === "/episodes/mepi_1") {
      nicheAsked();
      return { episode: ep };
    }
    return null;
  }) as never);
  await page({ open: "mepi_1" });
  expect(screen.getByRole("heading", { name: "Title of mepi_1" })).toBeInTheDocument();
});

it("tells an invalid session id (400) apart from one that is missing or out of reach (404)", async () => {
  serve({ list: { items: [episode("mepi_1")] } });
  statuses.set("/episodes/ep_demo_1", 400);
  await page({ open: "ep_demo_1" });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This session link is not valid: the session id is malformed."
  );
  cleanup();

  await page({ open: "mepi_gone" });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "It may not exist, or it may be above your access level."
  );
});

it("says the invalid id in Spanish too", async () => {
  locale = "es-419";
  serve({ list: { items: [episode("mepi_1")] } });
  statuses.set("/episodes/ep_demo_1", 400);
  await page({ open: "ep_demo_1" });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "El enlace de esta sesión no es válido: el identificador de la sesión está mal formado."
  );
});

it("APP-043 a full page of sessions offers the next ones, not a silent cut at 50", async () => {
  serve({ list: { items: Array.from({ length: 50 }, (_, i) => episode(`mepi_${i}`)) } });
  render(await SessionsPage({ searchParams: Promise.resolve({}) }));
  expect(vi.mocked(apiGet).mock.calls[0]?.[0]).toBe("/episodes?limit=50");
  expect(screen.getByRole("link", { name: "Load more →" })).toHaveAttribute(
    "href",
    "/sessions?limit=100"
  );
});

it("APP-043 at the route's cap of 200 the grid says it lists only the first ones", async () => {
  serve({ list: { items: Array.from({ length: 200 }, (_, i) => episode(`mepi_${i}`)) } });
  render(await SessionsPage({ searchParams: Promise.resolve({ limit: "999" }) }));
  expect(vi.mocked(apiGet).mock.calls[0]?.[0]).toBe("/episodes?limit=200");
  expect(screen.queryByRole("link", { name: "Load more →" })).toBeNull();
  expect(screen.getByText("Only the first 200 are listed here.")).toBeInTheDocument();
});

it("APP-043 a short list neither offers more nor claims a cap", async () => {
  serve({ list: { items: [episode("mepi_a")] } });
  render(await SessionsPage({ searchParams: Promise.resolve({}) }));
  expect(screen.queryByRole("link", { name: "Load more →" })).toBeNull();
  expect(screen.queryByText(/Only the first/)).toBeNull();
});
