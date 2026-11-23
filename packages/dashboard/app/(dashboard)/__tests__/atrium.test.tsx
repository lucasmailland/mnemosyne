import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nProvider } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n/core";
import { apiGet, getSession } from "@/lib/server-api";
import HomePage from "../(home)/page";
import { ConflictCard } from "../atrium/conflict-card";
import { Needs } from "../atrium/needs";
import type { ConflictPair } from "../atrium/types";

const refresh = vi.fn();
let locale: Locale = "en-US";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/server-api", () => ({ apiGet: vi.fn(), getSession: vi.fn() }));
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

const fetchMock = vi.fn();
beforeEach(() => {
  locale = "en-US";
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

// "Today" is read when a test builds its data, never once for the file: a run that crosses
// UTC midnight would otherwise compare yesterday's key with the page's today.
const today = () => new Date().toISOString().slice(0, 10);
const writes = (todayCount: number) =>
  Array.from({ length: 14 }, (_, i) => ({
    day: i === 13 ? today() : `2020-01-${String(i + 1).padStart(2, "0")}`,
    count: i === 13 ? todayCount : i,
  }));

const adminStats = (over: Record<string, unknown> = {}) => ({
  workspaceId: "w",
  generatedAt: new Date().toISOString(),
  facts: { live: 12483, closed: 1, pinned: 2, archived: 0, withZeroHits: 0 },
  decisions: { active: 4 },
  relations: { conflicts: 0 },
  embeddings: { indexed: 10, pending: 2 },
  snapshot: { at: "2026-11-13T10:00:00.000Z", ageSeconds: 100, available: true },
  recall: { lastRecallAt: null, hitRate30d: 0.5, latencyP50Ms7d: 90, latencyP95Ms7d: 182 },
  lastWriteAt: null,
  writesPerDay14d: writes(7),
  ...over,
});
// What a member (memory:read) gets: no embeddings, snapshot, withZeroHits, precision*.
const memberStats = () => {
  const { embeddings: _e, snapshot: _s, ...rest } = adminStats();
  return { ...rest, facts: { live: 12483, closed: 1, pinned: 2 } };
};

// GET /recall/metrics: 30 zero-filled days ending today, 3 calls today.
const recallMetrics = () => ({
  days: Array.from({ length: 30 }, (_, i) => ({
    day: i === 29 ? today() : `2020-02-${String(i + 1).padStart(2, "0")}`,
    queries: i === 29 ? 3 : i % 3,
    zeroHitShare: i % 3 ? 0.25 : null,
    p50Ms: i % 3 ? 36 : null,
    p95Ms: i % 3 ? 140 : null,
  })),
  totals: { queries: 40, zeroHitShare: 0.25, p50Ms: 36, p95Ms: 140 },
});
const factStats = () => ({
  live: 20,
  pinned: 2,
  neverRecalled: 10,
  byKind: [
    { kind: "preference", count: 12 },
    { kind: "architecture", count: 8 },
  ],
  bySensitivity: [{ sensitivity: "internal", count: 20 }],
  byMemoryType: [{ memoryType: "semantic", count: 20 }],
});

const event = (id: string, kind: string, summary: string, at = new Date().toISOString()) => ({
  id,
  at,
  kind,
  factId: `f-${id}`,
  actor: "claude-code",
  summary,
});

// The server's shape (subject, worth and validTo too); Home keeps what it draws.
const pair = {
  relationId: "rel-1",
  confidence: 0.91,
  factA: {
    id: "fact-new",
    subject: "checkout",
    statement: "Reserve the code as long as the checkout can be paid.",
    worth: 1,
    validFrom: "2026-11-14T17:42:00.000Z",
    validTo: null,
  },
  factB: {
    id: "fact-old",
    subject: "checkout",
    statement: "Reserve checkout codes for a fixed 15 minutes.",
    worth: 1,
    validFrom: "2026-08-12T09:00:00.000Z",
    validTo: null,
  },
};

function serve(opts: {
  stats?: unknown;
  events?: unknown[];
  nextCursor?: string | null;
  pairs?: ConflictPair[];
  /** GET /conflicts' total; absent → an older server that sends none. */
  conflictTotal?: number;
  /** GET /recall/metrics and /facts/stats; absent → the request failed. */
  recall?: unknown;
  facts?: unknown;
  /** GET /timeline failed (null). */
  timeline?: null;
  /** GET /facts by updated_at, newest first: the facts behind the day's updates. */
  recent?: unknown[];
}) {
  vi.mocked(apiGet).mockImplementation((async (path: string) => {
    if (path.startsWith("/admin/stats")) return "stats" in opts ? opts.stats : adminStats();
    if (path.startsWith("/recall/metrics")) return opts.recall ?? null;
    if (path.startsWith("/facts/stats")) return opts.facts ?? null;
    if (path.startsWith("/facts?"))
      return { items: opts.recent ?? [], nextCursor: null, total: opts.recent?.length ?? 0 };
    if (path.startsWith("/timeline"))
      if ("timeline" in opts) return null;
      else return { events: opts.events ?? [], nextCursor: opts.nextCursor ?? null };
    if (path.startsWith("/conflicts"))
      return {
        pairs: opts.pairs ?? [],
        ...(opts.conflictTotal === undefined ? {} : { total: opts.conflictTotal }),
      };
    return null;
  }) as never);
}
/** A tile's value and caption, found by its label. */
function tile(label: string) {
  const el = screen
    .getAllByTestId("stat-tile")
    .find((t) => t.querySelector(".eyebrow")?.textContent === label);
  if (!el) throw new Error(`no tile ${label}`);
  return {
    value: el.querySelector("[data-testid=stat-value]")!.textContent,
    text: el.textContent ?? "",
  };
}

async function renderHome(scopes: string[]) {
  vi.mocked(getSession).mockResolvedValue({ role: "admin", scopes } as never);
  render(<I18nProvider locale={locale}>{await HomePage()}</I18nProvider>);
}

it("sums up today in one line of true clauses", async () => {
  serve({
    events: [event("c", "created", "z")],
    pairs: [pair],
    conflictTotal: 3,
    recall: recallMetrics(),
  });
  await renderHome(["memory:admin"]);
  const summary = screen.getByTestId("home-summary");
  expect(summary).toHaveTextContent(
    "7 memories written today · 3 recalls today · 3 open conflicts"
  );
  expect(screen.getByRole("link", { name: "3 open conflicts" })).toHaveAttribute(
    "href",
    "#atrium-conflict"
  );
});

it("leaves out a clause whose source failed and says when no conflict is open", async () => {
  serve({ stats: adminStats({ writesPerDay14d: writes(0) }) });
  await renderHome(["memory:admin"]);
  const summary = screen.getByTestId("home-summary");
  expect(summary).toHaveTextContent("0 memories written today · no open conflicts");
  expect(summary).not.toHaveTextContent(/recall/);
});

it("renders trimmed member stats without admin-only figures", async () => {
  serve({ stats: memberStats(), events: [event("a", "created", "A recent memory")] });
  await renderHome(["memory:read"]);
  expect(screen.getByText("A recent memory")).toBeInTheDocument();
  // Without /facts/stats the live count falls back to /admin/stats, compacted.
  expect(screen.getByRole("link", { name: "12.5K" })).toHaveAttribute("href", "/browser");
  expect(screen.queryByText("Embeddings indexed")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Keep/ })).not.toBeInTheDocument();
});

it("shows the embeddings tile to admins only, and the archive card to everyone", async () => {
  serve({});
  await renderHome(["memory:admin"]);
  expect(tile("Embeddings indexed").value).toBe("10");
  expect(tile("Embeddings indexed").text).toContain("2 pending");
  expect(screen.getByTestId("atrium-archive")).toHaveTextContent("The archive is in order");
  cleanup();
  serve({ stats: memberStats() });
  await renderHome(["memory:read"]);
  expect(screen.getByTestId("atrium-figures")).not.toHaveTextContent(/indexed/);
  expect(screen.getByTestId("atrium-archive")).toBeInTheDocument();
});

it("labels decision events instead of printing raw keys", async () => {
  serve({
    events: [
      event("a", "decision_created", "Use a payment window"),
      event("b", "decision_superseded", "Old window"),
      event("c", "decision_withdrawn", "Dropped idea"),
      event("d", "made_up_kind", "Unknown"),
    ],
  });
  await renderHome(["memory:admin"]);
  expect(screen.getByText("decision made")).toBeInTheDocument();
  expect(screen.getByText("decision superseded")).toBeInTheDocument();
  expect(screen.getByText("decision withdrawn")).toBeInTheDocument();
  expect(screen.getByText("made_up_kind")).toBeInTheDocument();
  expect(screen.queryByText(/home\.event/)).not.toBeInTheDocument();
});

it("lists at most 8 events of the day, newest first", async () => {
  const events = Array.from({ length: 11 }, (_, i) =>
    event(
      `e${i}`,
      "created",
      `Memory ${i}`,
      `2026-11-14T${String(i + 1).padStart(2, "0")}:00:00.000Z`
    )
  );
  serve({ events });
  await renderHome(["memory:admin"]);
  const items = screen.getByTestId("atrium-day").querySelectorAll("li");
  expect(items).toHaveLength(8);
  expect(items[0]).toHaveTextContent("Memory 10");
  expect(items[7]).toHaveTextContent("Memory 3");
});

const emptyStats = () =>
  adminStats({ facts: { live: 0, closed: 0, pinned: 0 }, writesPerDay14d: writes(0) });

it("APP-040 an empty workspace shows the first-use steps: a key, the MCP snippet or the CLI, then waiting", async () => {
  serve({ stats: emptyStats() });
  await renderHome(["memory:admin", "admin:keys"]);
  expect(screen.getByText("The tablet is still smooth.")).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("The atrium");
  const steps = screen.getByTestId("first-steps");
  expect(within(steps).getByRole("link", { name: "Create an API key" })).toHaveAttribute(
    "href",
    "/admin/keys?create=1"
  );
  expect(
    within(steps).getByText(
      "claude mcp add --scope user mnemosyne -e MNEMO_URL=http://localhost:3939 -e MNEMO_KEY=<your API key> -- npx -y @mnemo-ai/mcp"
    )
  ).toBeInTheDocument();
  // The one command the CLI accepts: --capture needs a host (APP-042).
  expect(within(steps).getByText("mnemo install --capture claude-code")).toBeInTheDocument();
  expect(within(steps).getAllByRole("button", { name: /^Copy/ })).toHaveLength(2);
  expect(within(steps).getByRole("status")).toHaveTextContent("Waiting for the first memory…");
});

it("APP-040 without admin:keys the first step names the missing permission instead of a dead link", async () => {
  serve({ stats: emptyStats() });
  await renderHome(["memory:read", "memory:write"]);
  const steps = screen.getByTestId("first-steps");
  expect(within(steps).queryByRole("link", { name: "Create an API key" })).toBeNull();
  expect(steps).toHaveTextContent("needs the admin:keys permission");
});

it("says the stats could not load, without crashing", async () => {
  serve({ stats: null });
  await renderHome(["memory:admin"]);
  expect(screen.getByText(/Could not load workspace stats/)).toBeInTheDocument();
});

it("hides the conflict buttons from a read session but keeps the lineage link", async () => {
  serve({ pairs: [pair], stats: adminStats({ relations: { conflicts: 1 } }) });
  await renderHome(["memory:read"]);
  expect(screen.getByText("Reserve checkout codes for a fixed 15 minutes.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Keep the newer" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Keep both" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Show lineage" })).toHaveAttribute(
    "href",
    "/browser?open=fact-new"
  );
  expect(screen.queryByTestId("atrium-archive")).not.toBeInTheDocument();
});

it("reads the aggregates it draws: recall metrics for 30 and 7 days, fact stats, the conflict queue", async () => {
  serve({});
  await renderHome(["memory:admin"]);
  const paths = vi.mocked(apiGet).mock.calls.map(([p]) => p);
  expect(paths).toEqual(
    expect.arrayContaining([
      "/recall/metrics?days=30",
      "/recall/metrics?days=7",
      "/facts/stats",
      "/conflicts?limit=20",
    ])
  );
  expect(paths).toContainEqual(expect.stringMatching(/^\/timeline\?.*limit=8$/));
});

it("APP-051 self-hosted has no quotas: Home neither reads /usage nor draws plan limits", async () => {
  serve({ recall: recallMetrics(), facts: factStats() });
  await renderHome(["memory:admin"]);
  expect(vi.mocked(apiGet).mock.calls.map(([p]) => p)).not.toContain("/usage");
  expect(screen.queryByText("Plan usage")).toBeNull();
  expect(screen.queryByText(/Free plan/)).toBeNull();
});

it("takes the conflict magnitude from the list's ceiling-aware total, not the snapshot", async () => {
  serve({ pairs: [pair], conflictTotal: 2, stats: adminStats({ relations: { conflicts: 9 } }) });
  await renderHome(["memory:admin"]);
  expect(screen.getByTestId("home-summary")).toHaveTextContent("2 open conflicts");
  expect(tile("Open conflicts").value).toBe("2");
});

it("the live conflict list wins over a stale snapshot count of zero", async () => {
  serve({ pairs: [pair], stats: adminStats({ relations: { conflicts: 0 } }) });
  await renderHome(["memory:admin"]);
  expect(screen.getByTestId("home-summary")).toHaveTextContent("1 open conflict");
  expect(tile("Open conflicts").value).toBe("1");
  expect(screen.queryByTestId("atrium-archive")).not.toBeInTheDocument();
});

it("an empty live list wins over a stale snapshot count", async () => {
  serve({ pairs: [], stats: adminStats({ relations: { conflicts: 3 } }) });
  await renderHome(["memory:admin"]);
  expect(screen.getByTestId("home-summary")).toHaveTextContent("no open conflicts");
  expect(tile("Open conflicts").value).toBe("0");
  expect(screen.getByTestId("atrium-archive")).toBeInTheDocument();
});

it("draws the figures and charts from the aggregates, each chart with its table", async () => {
  serve({ recall: recallMetrics(), facts: factStats() });
  await renderHome(["memory:admin"]);
  expect(tile("Recall hit rate · 30 days").value).toBe("75%");
  expect(tile("Recall hit rate · 30 days").text).toContain("of 40 recalls");
  expect(tile("Recall latency p50 · 7 days").value).toBe("36 ms");
  expect(tile("Recall latency p50 · 7 days").text).toContain("p95 140 ms");
  expect(tile("Never recalled").value).toBe("50%");
  expect(tile("Never recalled").text).toContain("10 of 20 memories");
  expect(tile("Memories live").value).toBe("20");
  expect(screen.getByRole("meter", { name: "Recall hit rate · 30 days" })).toHaveAttribute(
    "aria-valuetext",
    "75%"
  );
  for (const name of [
    "Memories written per day",
    "Recalls per day",
    "Recall latency",
    "Memory by kind",
  ])
    expect(screen.getByRole("table", { name })).toBeInTheDocument();
  expect(
    screen.getByRole("img", { name: /^Memory by kind: preference 12 \(60%\)/ })
  ).toBeInTheDocument();
});

it("says a chart's source failed in its own card, and an empty period as such", async () => {
  serve({ stats: adminStats({ writesPerDay14d: writes(0).map((d) => ({ ...d, count: 0 })) }) });
  await renderHome(["memory:admin"]);
  expect(screen.getByText("No memories written in the last 14 days.")).toBeInTheDocument();
  expect(screen.getAllByText(/Could not load this chart/)).toHaveLength(3); // recalls, latency, kinds
});

it("links each event of the day to its memory in the Explorer", async () => {
  serve({
    events: [
      event("a", "created", "A fact"),
      { ...event("b", "decision_created", "A decision"), factId: undefined, decisionId: "d1" },
    ],
  });
  await renderHome(["memory:admin"]);
  expect(screen.getByRole("link", { name: "A fact" })).toHaveAttribute("href", "/browser?open=f-a");
  expect(screen.getByRole("link", { name: "A decision" })).toHaveAttribute(
    "href",
    "/browser?type=decisions"
  );
});

it("shows the buttons to a writer", async () => {
  serve({ pairs: [pair], stats: adminStats({ relations: { conflicts: 1 } }) });
  await renderHome(["memory:read", "memory:write"]);
  expect(screen.getByRole("button", { name: "Keep the newer" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Keep both" })).toBeInTheDocument();
});

const card = (canWrite = true, p: ConflictPair = pair) =>
  render(
    <I18nProvider locale={locale}>
      <Needs title="One thing needs you">
        <ConflictCard pair={p} canWrite={canWrite} />
      </Needs>
    </I18nProvider>
  );

/** Pick a resolution on the card, then confirm it in the dialog. */
function resolveWith(button: string, dialog: string, confirm = "Resolve") {
  fireEvent.click(screen.getByRole("button", { name: button }));
  fireEvent.click(within(screen.getByRole("dialog", { name: dialog })).getByRole("button", { name: confirm }));
}
const NEWER = "Keep the newer memory?";
const BOTH = "Keep both memories?";

it("APP-044 a resolution posts nothing until it is confirmed, and the dialog says it cannot be undone", async () => {
  card();
  fireEvent.click(screen.getByRole("button", { name: "Keep the newer" }));
  const dialog = screen.getByRole("dialog", { name: NEWER });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(dialog).toHaveTextContent("Reserve checkout codes for a fixed 15 minutes.");
  expect(dialog).toHaveTextContent("cannot be undone");
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("Keep newer supersedes the older fact (factB here) and refreshes", async () => {
  card();
  resolveWith("Keep the newer", NEWER);
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledWith(
    "/dashboard/api/conflicts/rel-1/resolve",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "supersede_b" }) })
  );
});

it("Keep newer supersedes factA when A is the older one", async () => {
  card(true, { ...pair, factA: pair.factB, factB: pair.factA });
  resolveWith("Keep the newer", NEWER);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: "supersede_a" });
});

it("Keep both posts keep_both", async () => {
  card();
  resolveWith("Keep both", BOTH);
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: "keep_both" });
});

it("keeps both buttons disabled until the refresh after a resolution lands", async () => {
  // router.refresh() as Next runs it: the transition stays pending until the new page arrives.
  let land!: () => void;
  refresh.mockImplementation(() => new Promise<void>((r) => (land = r)));
  card();
  resolveWith("Keep both", BOTH);
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  try {
    // The POST is done; the page has not refreshed yet, so a second click must not go out.
    expect(screen.getByRole("button", { name: "Keep both" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep the newer" })).toBeDisabled();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  } finally {
    // A pending async transition holds every later one: always let it land.
    land();
  }
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Kept both memories."));
  expect(screen.getByRole("button", { name: "Keep both" })).toBeEnabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("reports a failed resolution and does not refresh", async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
  card();
  resolveWith("Keep both", BOTH);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(refresh).not.toHaveBeenCalled();
});

it("renders the whole atrium in Spanish with no English leftovers", async () => {
  locale = "es-419";
  serve({
    events: [event("a", "decision_created", "Algo"), event("b", "pinned", "Otro")],
    pairs: [pair],
    stats: adminStats({ relations: { conflicts: 1 } }),
  });
  await renderHome(["memory:admin", "memory:write"]);
  expect(screen.getByTestId("home-summary")).toHaveTextContent("7 recuerdos guardados hoy");
  expect(screen.getByText("decisión tomada")).toBeInTheDocument();
  expect(screen.getByText("fijado")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Conservar el más reciente" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Conservar ambos" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Ver linaje" })).toBeInTheDocument();
  expect(screen.queryByText("Keep both")).not.toBeInTheDocument();
  expect(screen.queryByText(/^The day/)).not.toBeInTheDocument();
});

it("renders the Spanish empty workspace", async () => {
  locale = "es-419";
  serve({ stats: emptyStats() });
  await renderHome(["memory:admin", "admin:keys"]);
  expect(screen.getByText("La tablilla sigue lisa.")).toBeInTheDocument();
  const steps = screen.getByTestId("first-steps");
  expect(within(steps).getByRole("link", { name: "Crear una clave de API" })).toBeInTheDocument();
  expect(within(steps).getByRole("status")).toHaveTextContent("Esperando el primer recuerdo…");
  expect(steps.textContent).not.toMatch(/Waiting|Create an/);
});

it("after Keep the newer lands, says what happened and moves focus to the heading", async () => {
  card();
  const status = screen.getByRole("status");
  expect(status).toBeEmptyDOMElement();
  resolveWith("Keep the newer", NEWER);
  await waitFor(() =>
    expect(status).toHaveTextContent("Kept the newer memory. The older one is superseded.")
  );
  expect(refresh).toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "One thing needs you" }));
});

it("after Keep both lands, says so in Spanish too", async () => {
  locale = "es-419";
  card();
  resolveWith("Conservar ambos", "¿Conservar ambos recuerdos?", "Resolver");
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Se conservaron ambos recuerdos.")
  );
  expect(document.activeElement).toHaveAttribute("tabindex", "-1");
});

it("a failed resolution announces nothing and keeps focus where it was", async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
  card();
  const button = screen.getByRole("button", { name: "Keep both" });
  button.focus();
  resolveWith("Keep both", BOTH);
  await screen.findByRole("alert");
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  // The dialog closed and gave focus back to the button that opened it.
  await waitFor(() => expect(document.activeElement).toBe(button));
});

it("names the band and says today and the peak in the sparkline", async () => {
  serve({});
  await renderHome(["memory:admin"]);
  expect(screen.getByTestId("atrium-figures")).toHaveAccessibleName("Key figures");
  // writes(7): 0..12 on the earlier days and 7 today → peak 12.
  expect(
    screen.getByRole("img", { name: /^Memories written per day, last 14 days/ })
  ).toHaveAccessibleName("Memories written per day, last 14 days: 7 today, peak 12");
});

it("validates what it fetches: bad events, stats and pairs are dropped, never thrown on", async () => {
  serve({
    events: [
      event("ok", "created", "A good one"),
      event("bad", "created", "Not a date", "yesterday-ish"),
      { id: 7, kind: "created", at: new Date().toISOString() },
      null,
    ],
    pairs: [{ ...pair, factA: { ...pair.factA, statement: 42 } } as never],
    stats: adminStats({ writesPerDay14d: [{ day: today(), count: "7" }, null] }),
  });
  await renderHome(["memory:admin"]);
  const day = screen.getByTestId("atrium-day");
  expect(day.querySelectorAll("li")).toHaveLength(1);
  expect(day).toHaveTextContent("A good one");
  // The malformed pair is skipped.
  expect(document.getElementById("atrium-conflict")).toBeNull();
  cleanup();
  serve({ stats: { facts: { live: "many" } } });
  await renderHome(["memory:admin"]);
  expect(screen.getByText(/Could not load workspace stats/)).toBeInTheDocument();
});

it("says the archive is in order only when the conflicts list loaded and is empty", async () => {
  vi.mocked(apiGet).mockImplementation((async (path: string) => {
    if (path.startsWith("/admin/stats")) return adminStats();
    if (path.startsWith("/timeline")) return { events: [], nextCursor: null };
    return null; // /conflicts failed
  }) as never);
  await renderHome(["memory:admin"]);
  expect(screen.queryByTestId("atrium-archive")).not.toBeInTheDocument();
  expect(screen.getByText(/Could not check for conflicts/)).toBeInTheDocument();
});

it("APP-043 a failed timeline says so in the day card, never 'nothing changed today'", async () => {
  serve({ timeline: null });
  await renderHome(["memory:admin"]);
  expect(screen.getByText("Could not load today's events.")).toBeInTheDocument();
  expect(screen.queryByText("No memory has changed yet today.")).toBeNull();
});

it("APP-043 a failed timeline on a workspace with no facts is not read as an empty workspace", async () => {
  serve({
    stats: adminStats({ facts: { live: 0, closed: 0, pinned: 0 }, writesPerDay14d: writes(0) }),
    timeline: null,
  });
  await renderHome(["memory:admin"]);
  expect(screen.queryByText("The tablet is still smooth.")).toBeNull();
  expect(screen.getByText("Could not load today's events.")).toBeInTheDocument();
});

it("APP-043 without the writes series, 'written today' is left out, not said as zero", async () => {
  const { writesPerDay14d: _w, ...noSeries } = adminStats();
  serve({ stats: noSeries, recall: recallMetrics() });
  await renderHome(["memory:admin"]);
  const summary = screen.getByTestId("home-summary");
  expect(summary).not.toHaveTextContent(/written today/);
  expect(summary).toHaveTextContent("3 recalls today");
});

it("APP-052 the day's times and the date say they are UTC", async () => {
  serve({ events: [event("a", "created", "Noted", `${today()}T09:05:00.000Z`)] });
  await renderHome(["memory:admin"]);
  expect(screen.getByTestId("atrium-day").querySelector("time")).toHaveTextContent("09:05 UTC");
  expect(screen.getByTestId("home-date")).toHaveTextContent(/UTC/);
});

const pairN = (n: number): ConflictPair => ({
  ...pair,
  relationId: `rel-${n}`,
  factA: { ...pair.factA, id: `new-${n}`, statement: `Newer statement ${n}` },
  factB: { ...pair.factB, id: `old-${n}`, statement: `Older statement ${n}` },
});

it("APP-044 lists the open conflicts as a queue, and says how many more there are", async () => {
  serve({ pairs: [pairN(1), pairN(2)], conflictTotal: 5 });
  await renderHome(["memory:read", "memory:write"]);
  const queue = screen.getByRole("list", { name: "Open conflicts" });
  expect(queue).toHaveAttribute("id", "atrium-conflict");
  expect(within(queue).getAllByRole("listitem")).toHaveLength(2);
  expect(queue).toHaveTextContent("Older statement 2");
  expect(screen.getAllByRole("button", { name: "Keep both" })).toHaveLength(2);
  expect(screen.getByText("Showing 2 of 5.")).toBeInTheDocument();
});

// GET /admin/stats for an admin: the context economy and the precision report (APP-015).
const context = (over: Record<string, unknown> = {}) => ({
  recalls7d: 40,
  servedCharsAvg7d: 1200,
  servedCharsP95_7d: 3000,
  liveFacts: 20,
  liveFactChars: 48000,
  methodology: "servedChars: …",
  ...over,
});
const precision = {
  precisionAtK: [
    { k: 1, precision: 0.9, sampleSize: 30 },
    { k: 3, precision: 0.8, sampleSize: 30 },
    { k: 5, precision: 0.7, sampleSize: 30 },
  ],
  precisionInsufficientData: false,
  precisionUnavailable: false,
};

it("5.4 the value band sets context served per recall against all live memory, with precision", async () => {
  const base = adminStats();
  serve({ stats: { ...base, context: context(), recall: { ...base.recall, ...precision } } });
  await renderHome(["memory:admin"]);
  const band = screen.getByRole("region", { name: "What memory saves" });
  const served = within(band).getAllByTestId("stat-tile")[0]!;
  expect(served).toHaveTextContent("Context served per recall · 7 days");
  expect(within(served).getByTestId("stat-value")).toHaveTextContent("1,200 characters");
  expect(served).toHaveTextContent("p95 3,000 · 40 recalls");
  expect(tile("All live memory").value).toBe("48,000 characters");
  expect(tile("All live memory").text).toContain("20 live memories · about 12,000 tokens");
  expect(tile("Share of memory per recall").value).toBe("2.5%");
  expect(tile("Recall precision@3").value).toBe("80%");
  expect(tile("Recall precision@3").text).toContain("p@1 90% · p@5 70%");
});

it("5.4 a context figure the server could not measure reads 'not measured yet', never 0", async () => {
  const base = adminStats();
  serve({
    stats: {
      ...base,
      context: context({ servedCharsAvg7d: null, servedCharsP95_7d: null, liveFactChars: null }),
      recall: { ...base.recall, ...precision, precisionInsufficientData: true },
    },
  });
  await renderHome(["memory:admin"]);
  expect(tile("Context served per recall · 7 days").value).toBe("not measured yet");
  expect(tile("All live memory").value).toBe("not measured yet");
  expect(tile("Share of memory per recall").value).toBe("not measured yet");
  expect(tile("Recall precision@3").value).toBe("not measured yet");
  expect(screen.getByRole("region", { name: "What memory saves" })).not.toHaveTextContent(/\b0\b/);
});

it("5.4 the value band is hidden from a member: /admin/stats sends no context to them", async () => {
  serve({ stats: memberStats() });
  await renderHome(["memory:read"]);
  expect(screen.queryByRole("region", { name: "What memory saves" })).toBeNull();
});

it("5.4 the value band in Spanish", async () => {
  locale = "es-419";
  serve({ stats: { ...adminStats(), context: context() } });
  await renderHome(["memory:admin"]);
  const band = screen.getByRole("region", { name: "Lo que ahorra la memoria" });
  expect(band).toHaveTextContent("Toda la memoria viva");
  expect(band.textContent).not.toMatch(/characters|recalls|not measured/);
});

it("APP-052 a recall is not an update: an 'updated' event that is only a recall's bump reads 'recalled'", async () => {
  const at = `${today()}T09:05:00.000Z`;
  serve({
    events: [
      { ...event("a", "updated", "Recalled only", at), factId: "f-a" },
      { ...event("b", "updated", "Really edited", at), factId: "f-b" },
    ],
    recent: [
      { id: "f-a", updatedAt: at, lastRecalledAt: at },
      { id: "f-b", updatedAt: at, lastRecalledAt: `${today()}T08:00:00.000Z` },
    ],
  });
  await renderHome(["memory:admin"]);
  expect(vi.mocked(apiGet)).toHaveBeenCalledWith(
    "/facts?status=all&sortBy=updated_at&order=desc&limit=8"
  );
  const [a, b] = [...screen.getByTestId("atrium-day").querySelectorAll("li")].sort((x, y) =>
    (x.textContent ?? "").localeCompare(y.textContent ?? "")
  );
  expect(b).toHaveTextContent("Recalled only");
  expect(b).toHaveTextContent(/recalled$/);
  expect(a).toHaveTextContent("Really edited");
  expect(a).toHaveTextContent(/updated$/);
});

it("APP-052 without the facts read, an update stays an update", async () => {
  serve({ events: [event("a", "updated", "Something")] });
  await renderHome(["memory:admin"]);
  expect(screen.getByTestId("atrium-day")).toHaveTextContent(/updated$/);
});
