import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Locale } from "@/lib/i18n/core";
import { apiGet, getSession } from "@/lib/server-api";
import BrowserPage from "../browser/page";
import { Clocks, monthTicks } from "../browser/clocks";
import { translate } from "@/lib/i18n/core";
import { en } from "@/lib/i18n/messages/en";

let locale: Locale = "en-US";
vi.mock("@/lib/server-api", () => ({ apiGet: vi.fn(), getSession: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
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
  vi.mocked(getSession).mockResolvedValue({ workspaceName: "Acme" } as never);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "preference",
  subject: "checkout",
  statement: `Statement of ${id}`,
  confidence: 0.94,
  pinned: false,
  relevance: 1,
  hitCount: 4,
  lastRecalledAt: null,
  status: "active",
  sensitivity: "internal",
  scope: "workspace",
  scopeRef: null,
  validFrom: "2026-08-12T00:00:00.000Z",
  validTo: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  ...over,
});

const detail = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "w",
  content: `Statement of ${id}`,
  attribution: {},
  tags: [],
  pinned: false,
  validFrom: "2026-08-12T00:00:00.000Z",
  validTo: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  sensitivity: "internal",
  kind: "preference",
  subject: "checkout",
  confidence: 0.94,
  episodeId: null,
  status: "active",
  sessionId: null,
  ...over,
});

function serve(routes: Record<string, unknown>, list: unknown[] = []) {
  vi.mocked(apiGet).mockImplementation((async (path: string) => {
    if (path in routes) return routes[path];
    if (path.startsWith("/facts?")) return { items: list, nextCursor: null, total: list.length };
    return null;
  }) as never);
}
const D = (id: string) => `/facts/${id}?includeClosed=true&provenance=true`;
const R = (id: string) => `/facts/${id}?includeClosed=true`;

async function open(id: string, extra: Record<string, string> = {}) {
  render(await BrowserPage({ searchParams: Promise.resolve({ open: id, ...extra }) }));
}

it("?open renders the plate from the provenance detail, with meta and the chain", async () => {
  serve(
    {
      [D("fact_AAAAAA")]: detail("fact_AAAAAA", {
        agentId: "claude-code",
        sessionId: "sess_123456",
        episodeId: "mepi_1",
      }),
      "/episodes/mepi_1": {
        episode: { id: "mepi_1", title: "Codes and measurement" },
        linkedFacts: [],
      },
    },
    [item("fact_AAAAAA")]
  );
  await open("fact_AAAAAA");
  expect(apiGet).toHaveBeenCalledWith(D("fact_AAAAAA"));
  const plate = screen.getByTestId("catalog-plate");
  expect(within(plate).getByRole("heading", { name: "Statement of fact_AAAAAA" })).toBeVisible();
  expect(within(plate).getByText("claude-code")).toBeInTheDocument();
  expect(within(plate).getByText("Acme")).toBeInTheDocument();
  expect(within(plate).getByText("0.94")).toBeInTheDocument();
  expect(within(plate).getByText("internal")).toBeInTheDocument();
  const chain = within(plate).getByTestId("catalog-chain");
  expect(within(chain).getByText("…123456")).toBeInTheDocument();
  expect(within(chain).getByText("Codes and measurement")).toBeInTheDocument();
  expect(within(chain).getByText("This memory")).toBeInTheDocument();
  expect(within(chain).queryByText("Superseded by")).not.toBeInTheDocument();
  expect(within(plate).getByTestId("clock-world")).toHaveAttribute("data-state", "open");
  expect(within(plate).getByTestId("clock-known")).toHaveAttribute("data-state", "open");
});

it("a superseded fact shows hatched spans, the four dates, and a link to its successor", async () => {
  serve(
    {
      [D("old_OOOOOO")]: detail("old_OOOOOO", {
        status: "merged",
        validTo: "2026-11-14T00:00:00.000Z",
        supersededById: "new_NNNNNN",
        supersededAt: "2026-11-14T00:00:00.000Z",
        supersedesIds: [],
      }),
      [R("new_NNNNNN")]: detail("new_NNNNNN", { content: "The newer wording" }),
    },
    []
  );
  await open("old_OOOOOO");
  const plate = screen.getByTestId("catalog-plate");
  expect(within(plate).getByTestId("clock-world")).toHaveAttribute("data-state", "closed");
  expect(within(plate).getByTestId("clock-known")).toHaveAttribute("data-state", "closed");
  // The tracks have a text equivalent: both dates of each clock.
  expect(within(plate).getAllByText(/Aug 12, 2026/).length).toBeGreaterThanOrEqual(2);
  expect(within(plate).getAllByText(/Nov 14, 2026/).length).toBeGreaterThanOrEqual(2);
  const chain = within(plate).getByTestId("catalog-chain");
  expect(within(chain).getByText("Superseded by")).toBeInTheDocument();
  const link = within(chain).getByRole("link", { name: /The newer wording/ });
  expect(link).toHaveAttribute("href", "/browser?open=new_NNNNNN");
});

it("a successor above the ceiling is simply not there: null or absent, no node, no hint", async () => {
  for (const hidden of [{ supersededById: null, supersedesIds: null }, {}]) {
    serve(
      {
        [D("old_OOOOOO")]: detail("old_OOOOOO", {
          validTo: "2026-11-14T00:00:00.000Z",
          ...hidden,
        }),
      },
      []
    );
    await open("old_OOOOOO");
    const chain = screen.getByTestId("catalog-chain");
    expect(within(chain).queryByText("Superseded by")).not.toBeInTheDocument();
    expect(within(chain).queryByText("Supersedes")).not.toBeInTheDocument();
    expect(screen.queryByText(/hidden|above your/i)).not.toBeInTheDocument();
    cleanup();
  }
});

it("a closed fact the list does not hold still shows Cited, from the detail's hitCount", async () => {
  serve(
    {
      [D("gone_CCCCCC")]: detail("gone_CCCCCC", {
        validTo: "2026-11-14T00:00:00.000Z",
        hitCount: 5,
      }),
    },
    []
  );
  await open("gone_CCCCCC");
  const plate = screen.getByTestId("catalog-plate");
  expect(within(plate).getByText("Cited")).toBeInTheDocument();
  expect(within(plate).getByText(/^5 /)).toBeInTheDocument();
});

it("supersedes shows at most three earlier memories, each a link", async () => {
  const ids = ["p1", "p2", "p3", "p4"];
  serve(
    {
      [D("cur_CCCCCC")]: detail("cur_CCCCCC", { supersedesIds: ids }),
      ...Object.fromEntries(ids.map((i) => [R(i), detail(i, { content: `Earlier ${i}` })])),
    },
    []
  );
  await open("cur_CCCCCC");
  const chain = screen.getByTestId("catalog-chain");
  expect(within(chain).getAllByRole("link", { name: /Earlier/ })).toHaveLength(3);
  expect(within(chain).queryByText(/Earlier p4/)).not.toBeInTheDocument();
});

it("with no card open the cards take the width and the prompt waits behind the count's (i)", async () => {
  serve({}, [item("fact_AAAAAA")]);
  render(await BrowserPage({ searchParams: Promise.resolve({}) }));
  expect(screen.queryByTestId("catalog-plate")).toBeNull();
  expect(screen.getByRole("list", { name: "Memories" })).toHaveClass("lg:grid-cols-2");
  expect(screen.getByRole("button", { name: "About: Memory detail" })).toHaveAccessibleDescription(
    /Open a card/
  );
});

it("an open id that cannot be read says so", async () => {
  serve({}, []);
  await open("nope");
  expect(screen.getByTestId("catalog-plate").querySelector("[role=alert]")).not.toBeNull();
});

it("cards link to ?open keeping the other params, and mark the open one", async () => {
  serve({ [D("fact_AAAAAA")]: detail("fact_AAAAAA") }, [item("fact_AAAAAA"), item("fact_BBBBBB")]);
  await open("fact_AAAAAA", { q: "checkout" });
  const list = screen.getByRole("list", { name: "Memories" });
  const cards = within(list).getAllByRole("link");
  expect(cards[0]).toHaveAttribute("aria-current", "page");
  expect(cards[1].getAttribute("href")).toContain("q=checkout");
  expect(cards[1].getAttribute("href")).toContain("open=fact_BBBBBB");
  expect(within(list).getByText("…AAAAAA")).toBeInTheDocument();
});

it("forgotten and merged have labels, in both languages", async () => {
  const list = [
    item("fact_FFFFFF", { status: "forgotten", validTo: "2026-09-01T00:00:00.000Z" }),
    item("fact_MMMMMM", { status: "merged", validTo: "2026-09-01T00:00:00.000Z" }),
  ];
  serve({}, list);
  render(await BrowserPage({ searchParams: Promise.resolve({ status: "all" }) }));
  expect(screen.getByText("forgotten")).toBeInTheDocument();
  expect(screen.getByText("merged")).toBeInTheDocument();
  cleanup();
  locale = "es-419";
  serve({}, list);
  render(await BrowserPage({ searchParams: Promise.resolve({ status: "all" }) }));
  expect(screen.getByText("olvidado")).toBeInTheDocument();
  expect(screen.getByText("fusionado")).toBeInTheDocument();
});

it("an empty catalog is an EmptyState; an empty filter is a plain line", async () => {
  serve({}, []);
  render(await BrowserPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole("heading", { name: "Nothing is catalogued yet" })).toBeInTheDocument();
  cleanup();
  serve({}, []);
  render(await BrowserPage({ searchParams: Promise.resolve({ q: "zzz" }) }));
  expect(screen.getByText("No facts match the current filters.")).toBeInTheDocument();
});

it("the plate is localized to Spanish", async () => {
  locale = "es-419";
  serve({
    [D("old_OOOOOO")]: detail("old_OOOOOO", {
      validTo: "2026-11-14T00:00:00.000Z",
      supersededById: "new_NNNNNN",
      supersededAt: "2026-11-14T00:00:00.000Z",
    }),
    [R("new_NNNNNN")]: detail("new_NNNNNN"),
  });
  await open("old_OOOOOO");
  const plate = screen.getByTestId("catalog-plate");
  expect(within(plate).getByText("Reemplazado por")).toBeInTheDocument();
  expect(within(plate).getByText("Verdadero en el mundo")).toBeInTheDocument();
  expect(within(plate).getByText("Conocido por Mnemosyne")).toBeInTheDocument();
  expect(within(plate).getByText("Procedencia")).toBeInTheDocument();
});

it("month ticks run from the earliest date to now, thinned so labels never touch", () => {
  const ticks = monthTicks(new Date("2026-08-12T00:00:00Z"), new Date("2026-11-14T00:00:00Z"));
  expect(ticks[0].pct).toBe(0);
  // Nov 1 sits at 86 %: it would run into the "now" label at the right end, so it is dropped.
  expect(ticks.map((t) => t.date.toISOString().slice(0, 7))).toEqual(["2026-08", "2026-10"]);
  expect(ticks.every((t) => 100 - t.pct >= 22)).toBe(true);
  expect(ticks.every((t) => t.pct < 100)).toBe(true);
  expect(monthTicks(new Date("2026-11-14T00:00:00Z"), new Date("2026-11-14T00:00:00Z"))).toEqual([
    { pct: 0, date: new Date("2026-11-14T00:00:00Z") },
  ]);
});

it("ids are encoded in every bridge path: ?open=../decisions cannot reach another route", async () => {
  serve({}, []);
  await open("../decisions");
  expect(apiGet).toHaveBeenCalledWith("/facts/..%2Fdecisions?includeClosed=true&provenance=true");
  expect(apiGet).not.toHaveBeenCalledWith(expect.stringContaining("/facts/../"));
});

it("a detail without an id (some other route's JSON) renders the not-found state", async () => {
  serve({ [D("x")]: { items: [] } });
  await open("x");
  expect(screen.getByTestId("catalog-plate").querySelector("[role=alert]")).not.toBeNull();
});

it("an episode that cannot be read still leaves a plate, with the short id", async () => {
  serve({ [D("fact_AAAAAA")]: detail("fact_AAAAAA", { episodeId: "mepi_ZZZZZZ" }) });
  await open("fact_AAAAAA");
  const chain = screen.getByTestId("catalog-chain");
  expect(within(chain).getByRole("link", { name: "…ZZZZZZ" })).toBeInTheDocument();
});

it("a predecessor that cannot be read is an id link only", async () => {
  serve({ [D("cur_CCCCCC")]: detail("cur_CCCCCC", { supersedesIds: ["gone_GGGGGG"] }) });
  await open("cur_CCCCCC");
  const link = within(screen.getByTestId("catalog-chain")).getByRole("link", { name: "…GGGGGG" });
  expect(link).toHaveAttribute("href", "/browser?open=gone_GGGGGG");
});

it("an unparseable end date skips that track and prints a dash instead of NaN", () => {
  const t = (k: string, v?: Record<string, string | number>) =>
    translate(en, k as never, v, "en-US");
  render(
    <Clocks
      t={t as never}
      locale="en-US"
      validFrom="2026-08-12T00:00:00Z"
      validTo="not a date"
      createdAt="2026-08-12T00:00:00Z"
      supersededAt={null}
      now={new Date("2026-11-14T00:00:00Z")}
    />
  );
  expect(screen.getByTestId("clock-world")).toHaveAttribute("data-state", "unknown");
  expect(document.body.innerHTML).not.toContain("NaN");
});

it("an unfiltered empty list with a card open uses the unfiltered copy", async () => {
  serve({ [D("x1")]: detail("x1") }, []);
  await open("x1");
  expect(screen.queryByText("No facts match the current filters.")).not.toBeInTheDocument();
});

it("the entities tab passes q to /entities and keeps it in Load more and the search box", async () => {
  vi.mocked(apiGet).mockResolvedValue({
    items: Array.from({ length: 25 }, (_, i) => ({
      id: `e${i}`,
      name: `Ada ${i}`,
      kind: "person",
    })),
  });
  render(await BrowserPage({ searchParams: Promise.resolve({ type: "entities", q: "ada" }) }));
  expect(vi.mocked(apiGet).mock.calls.map((c) => c[0])).toContain("/entities?limit=25&q=ada");
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("ada");
  const more = screen.getByRole("link", { name: /Load more/ });
  expect(more.getAttribute("href")).toContain("q=ada");
});

it("a superseded memory reads superseded on the plate, not forgotten", async () => {
  serve(
    {
      [D("old_OOOOOO")]: detail("old_OOOOOO", {
        status: "forgotten",
        validTo: "2026-11-14T00:00:00.000Z",
        supersededById: "new_NNNNNN",
        supersededAt: "2026-11-14T00:00:00.000Z",
      }),
      [R("new_NNNNNN")]: detail("new_NNNNNN"),
    },
    []
  );
  await open("old_OOOOOO");
  const plate = screen.getByTestId("catalog-plate");
  expect(within(plate).getByText("superseded")).toBeInTheDocument();
  expect(within(plate).queryByText("forgotten")).not.toBeInTheDocument();
});

it("in the list, a forgotten card whose successor the page knows reads superseded", async () => {
  const closed = { status: "forgotten", validTo: "2026-09-01T00:00:00.000Z" };
  serve(
    {
      [D("cur_CCCCCC")]: detail("cur_CCCCCC", { supersedesIds: ["old_OOOOOO"] }),
      [R("old_OOOOOO")]: detail("old_OOOOOO"),
    },
    [item("cur_CCCCCC"), item("old_OOOOOO", closed), item("gone_GGGGGG", closed)]
  );
  await open("cur_CCCCCC", { status: "all" });
  const list = screen.getByRole("list", { name: "Memories" });
  const [, old, gone] = within(list).getAllByRole("link");
  expect(old).toHaveTextContent("superseded");
  expect(old).not.toHaveTextContent("forgotten");
  // No successor known for this one: the server's status stands.
  expect(gone).toHaveTextContent("forgotten");
});

const decision = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "architecture",
  title: `Decision ${id}`,
  body: "",
  topicKey: null,
  status: "active",
  validFrom: "2026-08-12T00:00:00.000Z",
  validTo: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  ...over,
});
const entity = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "person",
  name: `Entity ${id}`,
  description: null,
  mentionCount: 3,
  createdAt: "2026-08-12T00:00:00.000Z",
  ...over,
});
function serveTab(path: string, items: unknown[]) {
  vi.mocked(apiGet).mockImplementation((async (p: string) =>
    p.startsWith(path) ? { items } : null) as never);
}
const tab = async (type: string, extra: Record<string, string> = {}) =>
  render(await BrowserPage({ searchParams: Promise.resolve({ type, ...extra }) }));
// Half-step spacing and the pre-redesign text-xs/text-sm are off the scale.
const OFF_SCALE = /(^|\s)([a-z]+-)*\d+\.5(\s|$)|(^|\s)text-(xs|sm)(\s|$)/;

it("decisions are index cards: statement, kind, status (withdrawn too) and since when", async () => {
  serveTab("/decisions?", [
    decision("dec_AAAAAA"),
    decision("dec_WWWWWW", { status: "withdrawn", validTo: "2026-10-01T00:00:00.000Z" }),
    decision("dec_SSSSSS", { status: "superseded" }),
  ]);
  await tab("decisions");
  const cards = within(screen.getByRole("list", { name: "Decisions" })).getAllByRole("listitem");
  expect(cards).toHaveLength(3);
  expect(within(cards[0]!).getByText("Decision dec_AAAAAA")).toBeInTheDocument();
  expect(within(cards[0]!).getByText("architecture")).toBeInTheDocument();
  expect(within(cards[0]!).getByText("…AAAAAA")).toBeInTheDocument();
  // validFrom, not createdAt.
  expect(within(cards[0]!).getByText("Aug 12, 2026")).toBeInTheDocument();
  expect(cards[0]).not.toHaveTextContent("active");
  expect(within(cards[1]!).getByText("withdrawn")).toBeInTheDocument();
  expect(within(cards[1]!).getByText("Decision dec_WWWWWW")).toHaveClass("catalog-struck");
  expect(within(cards[2]!).getByText("superseded")).toBeInTheDocument();
});

it("decision cards show the topic key and entity cards the clamped description", async () => {
  serveTab("/decisions?", [
    decision("dec_TTTTTT", { topicKey: "auth/session-ttl" }),
    decision("dec_NNNNNN"),
  ]);
  await tab("decisions");
  const dcards = within(screen.getByRole("list", { name: "Decisions" })).getAllByRole("listitem");
  const key = within(dcards[0]!).getByText("auth/session-ttl");
  expect(key).toHaveClass("font-mono");
  expect(dcards[1]).not.toHaveTextContent("auth/");

  serveTab("/entities?", [
    entity("ent_DDDDDD", { description: "Maintains the billing service." }),
    entity("ent_EEEEEE"),
  ]);
  cleanup();
  await tab("entities");
  const ecards = within(screen.getByRole("list", { name: "Entities" })).getAllByRole("listitem");
  expect(within(ecards[0]!).getByText("Maintains the billing service.")).toHaveClass(
    "line-clamp-2"
  );
  expect(ecards[1]).not.toHaveTextContent("Maintains");
});

it("entities are index cards: name, kind and mentions; both tabs keep Load more", async () => {
  serveTab("/entities?", [entity("ent_PPPPPP"), entity("ent_OOOOOO", { kind: "organization" })]);
  await tab("entities");
  const cards = within(screen.getByRole("list", { name: "Entities" })).getAllByRole("listitem");
  expect(within(cards[0]!).getByText("Entity ent_PPPPPP")).toBeInTheDocument();
  expect(within(cards[0]!).getByText("person")).toBeInTheDocument();
  expect(within(cards[0]!).getByText("3 mentions")).toBeInTheDocument();
  expect(within(cards[1]!).getByText("organization")).toBeInTheDocument();
  cleanup();
  serveTab(
    "/decisions?",
    Array.from({ length: 25 }, (_, i) => decision(`dec_${i}`))
  );
  await tab("decisions");
  expect(apiGet).toHaveBeenCalledWith("/decisions?limit=25");
  expect(screen.getByRole("link", { name: "Load more →" })).toHaveAttribute(
    "href",
    "/browser?type=decisions&limit=50"
  );
  cleanup();
  serveTab(
    "/entities?",
    Array.from({ length: 50 }, (_, i) => entity(`ent_${i}`))
  );
  await tab("entities", { limit: "50" });
  expect(apiGet).toHaveBeenCalledWith("/entities?limit=50");
  expect(screen.getByRole("link", { name: "Load more →" })).toHaveAttribute(
    "href",
    "/browser?type=entities&limit=75"
  );
});

it("decisions and entities are localized, withdrawn included", async () => {
  locale = "es-419";
  serveTab("/decisions?", [decision("dec_WWWWWW", { status: "withdrawn" })]);
  await tab("decisions");
  expect(screen.getByRole("list", { name: "Decisiones" })).toHaveTextContent("retirado");
  cleanup();
  serveTab("/entities?", [entity("ent_PPPPPP", { mentionCount: 1 })]);
  await tab("entities");
  const list = screen.getByRole("list", { name: "Entidades" });
  expect(list).toHaveTextContent("persona");
  expect(list).toHaveTextContent("1 mención");
});

it("tabs, filters, search and Load more sit on the spacing and type scales", async () => {
  serve({}, [item("fact_AAAAAA")]);
  render(await BrowserPage({ searchParams: Promise.resolve({ kind: "bugfix" }) }));
  const filters = screen.getByRole("group", { name: "Filter memories" });
  const controls = [
    ...screen.getAllByRole("link", { name: /^(Facts|Decisions|Entities)$/ }),
    within(filters).getByRole("button", { name: "Kind: bugfix" }),
    within(filters).getByRole("button", { name: "Sensitivity: All" }),
    within(filters).getByRole("searchbox"),
  ];
  for (const el of controls) expect(el.className).not.toMatch(OFF_SCALE);
  expect(screen.getByRole("link", { name: "Facts" })).toHaveAttribute("aria-current", "page");
  // The kinds are radios of the GET form behind the Kind button; the picked one is checked.
  const kinds = screen.getByRole("radio", { name: "bugfix", hidden: true });
  expect(kinds).toBeChecked();
  expect(kinds).toHaveAttribute("name", "kind");
  expect(within(filters).getByText("1 filter")).toBeInTheDocument();
  expect(within(filters).getByRole("link", { name: "Clear filters" })).toHaveAttribute(
    "href",
    "/browser"
  );
  cleanup();
  serveTab(
    "/decisions?",
    Array.from({ length: 25 }, (_, i) => decision(`dec_${i}`))
  );
  await tab("decisions");
  expect(screen.getByRole("link", { name: "Load more →" }).className).not.toMatch(OFF_SCALE);
  expect(screen.getByRole("link", { name: "Decisions" })).toHaveAttribute("aria-current", "page");
});

it("a writer known only by actor id prints as a mono short id", async () => {
  serve({ [D("fact_AAAAAA")]: detail("fact_AAAAAA", { actorId: "key:0123456789abcdef" }) });
  await open("fact_AAAAAA");
  const author = within(screen.getByTestId("catalog-plate")).getByText("…abcdef");
  expect(author).toHaveClass("font-mono");
});

it("fetches the list and the open plate together, not one after the other", async () => {
  // The list answers only once the plate has been asked for: sequential fetches would hang.
  let plateAsked: () => void = () => {};
  const asked = new Promise<void>((r) => (plateAsked = r));
  vi.mocked(apiGet).mockImplementation((async (path: string) => {
    if (path.startsWith("/facts?")) {
      await asked;
      return { items: [item("fact_AAAAAA")], nextCursor: null, total: 1 };
    }
    if (path === D("fact_AAAAAA")) {
      plateAsked();
      return detail("fact_AAAAAA");
    }
    return null;
  }) as never);
  await open("fact_AAAAAA");
  expect(screen.getByRole("heading", { name: "Statement of fact_AAAAAA" })).toBeInTheDocument();
});

it("opens with the catalog's figures, every one from a server aggregate", async () => {
  serve(
    {
      "/facts/stats": {
        live: 40,
        pinned: 3,
        neverRecalled: 10,
        byKind: [{ kind: "preference", count: 40 }],
        bySensitivity: [{ sensitivity: "internal", count: 40 }],
      },
      "/graph/stats": {
        entities: 7,
        decisions: 2,
        episodes: 0,
        relations: 5,
        conflicts: 0,
        isolated: 1,
        entitiesByKind: [],
        relationsByType: [],
        hubs: [],
      },
    },
    [item("top_TTTTTT", { hitCount: 9 }), item("cold_CCCCCC", { hitCount: 0 })]
  );
  render(await BrowserPage({ searchParams: Promise.resolve({}) }));
  const band = screen.getByTestId("metrics-band");
  const values = within(band)
    .getAllByTestId("stat-value")
    .map((v) => v.textContent);
  expect(values).toEqual(["40", "2", "7", "3", "25%"]);
  expect(within(band).getByText("10 of 40")).toBeInTheDocument();
  // The ranking leaves out what was never recalled and links each memory to its plate.
  const top = screen.getByRole("heading", { name: "Most recalled" }).closest("section")!;
  const links = within(top).getAllByRole("link");
  expect(links.map((l) => l.getAttribute("href"))).toEqual(["/browser?open=top_TTTTTT"]);
});

it("says a figure could not load instead of drawing a zero", async () => {
  serve({}, []);
  render(await BrowserPage({ searchParams: Promise.resolve({}) }));
  const band = screen.getByTestId("metrics-band");
  expect(within(band).getAllByText("No data")).toHaveLength(5);
  expect(screen.getAllByText(/Could not load this chart/)).toHaveLength(1);
});

it("APP-043 at the routes' caps, decisions and entities say they list only the first ones", async () => {
  serveTab(
    "/decisions?",
    Array.from({ length: 500 }, (_, i) => decision(`dec_${i}`))
  );
  await tab("decisions", { limit: "9999" });
  expect(apiGet).toHaveBeenCalledWith("/decisions?limit=500");
  expect(screen.queryByRole("link", { name: "Load more →" })).toBeNull();
  expect(screen.getByText("Only the first 500 are listed here.")).toBeInTheDocument();
  cleanup();
  serveTab(
    "/entities?",
    Array.from({ length: 200 }, (_, i) => entity(`ent_${i}`))
  );
  await tab("entities", { limit: "200" });
  expect(screen.getByText("Only the first 200 are listed here.")).toBeInTheDocument();
});

it("5.4 the plate of a live fact offers the writer's actions, Move listing only writable workspaces", async () => {
  vi.mocked(getSession).mockResolvedValue({
    workspaceName: "Acme",
    authMethod: "password",
    scopes: ["memory:read", "memory:write", "memory:delete"],
  } as never);
  serve(
    {
      [D("fact_AAAAAA")]: detail("fact_AAAAAA", { revisionCount: 2 }),
      "/my-workspaces": {
        workspaces: [
          { id: "w", name: "Acme", role: "owner", isPersonal: false, current: true },
          { id: "w2", name: "Team", role: "write", isPersonal: false, current: false },
          { id: "w3", name: "Readonly", role: "read", isPersonal: false, current: false },
        ],
      },
    },
    [item("fact_AAAAAA")]
  );
  await open("fact_AAAAAA");
  const actions = within(screen.getByTestId("catalog-plate")).getByRole("group", {
    name: "Actions on this memory",
  });
  for (const name of ["Pin", "Correct", "Move", "Forget"])
    expect(within(actions).getByRole("button", { name })).toBeInTheDocument();
  fireEvent.click(within(actions).getByRole("button", { name: "Move" }));
  const options = within(screen.getByRole("dialog", { name: "Move this memory" }))
    .getAllByRole("option")
    .map((o) => o.textContent);
  expect(options).toEqual(["Team"]);
});

it("5.4 a closed fact's plate offers no actions", async () => {
  vi.mocked(getSession).mockResolvedValue({
    workspaceName: "Acme",
    scopes: ["memory:read", "memory:write", "memory:delete"],
  } as never);
  serve(
    {
      [D("fact_AAAAAA")]: detail("fact_AAAAAA", {
        validTo: "2026-09-01T00:00:00.000Z",
        status: "forgotten",
      }),
    },
    [item("fact_AAAAAA")]
  );
  await open("fact_AAAAAA");
  expect(screen.queryByRole("group", { name: "Actions on this memory" })).toBeNull();
  expect(apiGet).not.toHaveBeenCalledWith("/my-workspaces");
});
