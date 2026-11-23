import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nProvider } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n/core";
import RecallPage from "../recall/page";
import { parseRecall } from "../recall/model";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

/** Mirrors a POST /recall hit: the primitive's name travels as `kind`. */
const hit = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "fact",
  content: `Statement of ${id}`,
  score: 0.5,
  similarity: 0.82,
  status: "active",
  hitFreshness: "recent",
  validFrom: "2026-08-12T00:00:00.000Z",
  ...over,
});
const stage = (name: string, i: number | null, o: number | null, ms: number) => ({
  name,
  candidatesIn: i,
  candidatesOut: o,
  ms,
});
/** Mirrors the POST /recall response schema: latency and trace live under `debug`. */
const recallBody = (
  over: {
    hits?: unknown[];
    nothingRelevant?: boolean;
    trace?: unknown[];
    relevanceFloor?: number;
  } = {}
) => ({
  hits: over.hits ?? [],
  nothingRelevant: over.nothingRelevant ?? false,
  debug: {
    embedded: true,
    tier: "cold",
    latencyMs: 41,
    ...(over.trace ? { trace: over.trace } : {}),
    ...(over.relevanceFloor !== undefined ? { relevanceFloor: over.relevanceFloor } : {}),
  },
});
const RECALL = recallBody({
  hits: [hit("fact-aaaaaa"), hit("fact-bbbbbb", { similarity: undefined, score: 0.25 })],
  trace: [
    stage("embed", 1, 1, 3),
    stage("vector", null, null, 12),
    stage("eligibility", 20, 20, 2),
    stage("mystery_stage", 20, 9, 5),
  ],
});
const explainHit = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  content: "x",
  primitive: "fact",
  score: 0.5,
  explain: {
    worth: 0.71,
    worthLowerBound: 0.44,
    injectionScore: 0.02,
    provenance: "user_stated",
    contested: false,
    servedFromHotTier: true,
    relationCount: 3,
    ...over,
  },
});
const EXPLAIN = { hits: [explainHit("fact-aaaaaa")], fromHotTier: false, tookMs: 5 };

const responses: Record<string, { status: number; body: unknown }> = {};
const fetchMock = vi.fn();
beforeEach(() => {
  responses["/dashboard/api/recall"] = { status: 200, body: RECALL };
  responses["/dashboard/api/recall/explain"] = { status: 200, body: EXPLAIN };
  fetchMock.mockImplementation(async (url: string) => {
    const r = responses[url];
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const renderPage = (locale: Locale = "en-US") =>
  render(
    <I18nProvider locale={locale}>
      <RecallPage />
    </I18nProvider>
  );
const calls = (url: string) => fetchMock.mock.calls.filter((c) => c[0] === url);
const search = async (text = "checkout", locale: Locale = "en-US") => {
  renderPage(locale);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  await screen.findByTestId("lethe-strip");
};

it("does not fetch while typing", () => {
  renderPage();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "check" } });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "checkout" } });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("submits query, topK, kinds, asOf and debug:true", async () => {
  renderPage();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: " checkout " } });
  // Kinds and the options sit behind their buttons.
  fireEvent.click(screen.getByRole("button", { name: "Kinds: All" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "decision" }));
  expect(screen.getByRole("button", { name: "Kinds: decision" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Options" }));
  fireEvent.change(screen.getByLabelText("As of"), { target: { value: "2026-08-12" } });
  fireEvent.change(screen.getByLabelText("Results to return"), { target: { value: "100" } });
  expect(
    screen.getByRole("button", { name: "Options: Top 100 · as of Aug 12" })
  ).toBeInTheDocument();
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  await screen.findByTestId("lethe-strip");
  const [, init] = calls("/dashboard/api/recall")[0];
  expect(JSON.parse(init.body)).toEqual({
    query: "checkout",
    topK: 100,
    kinds: ["decision"],
    asOf: "2026-08-12T23:59:59.999Z",
    debug: true,
  });
});

it("omits kinds and asOf when none are chosen", async () => {
  await search();
  expect(JSON.parse(calls("/dashboard/api/recall")[0][1].body)).toEqual({
    query: "checkout",
    topK: 10,
    debug: true,
  });
});

it("renders the pipeline with localized stage names, in → out, ms and a total", async () => {
  await search();
  const strip = screen.getByTestId("lethe-strip");
  expect(within(strip).getByText("Embed")).toBeInTheDocument();
  expect(within(strip).getByText("Eligibility")).toBeInTheDocument();
  expect(within(strip).getByText("20 → 20")).toBeInTheDocument();
  expect(within(strip).getByText("12 ms")).toBeInTheDocument();
  // an unknown stage falls back to its raw name
  expect(within(strip).getByText("mystery_stage")).toBeInTheDocument();
  expect(within(strip).getByText("41 ms")).toBeInTheDocument();
});

it("renders null counts as an em dash with a title, never null → null", async () => {
  await search();
  const strip = screen.getByTestId("lethe-strip");
  expect(strip.textContent).not.toMatch(/null/);
  expect(within(strip).getAllByText("Hidden by your access level").length).toBeGreaterThan(0);
  const hidden = within(strip).getAllByTitle("Hidden by your access level");
  expect(hidden.length).toBeGreaterThan(0);
  expect(hidden[0].textContent).toBe("— → — Hidden by your access level");
  expect(within(hidden[0]).getByText("Hidden by your access level")).toHaveClass("sr-only");
});

it("scrolls the strip inside its own focusable region", async () => {
  await search();
  const region = screen.getByRole("region", { name: "Recall pipeline, one cell per stage" });
  expect(region).toContainElement(screen.getByTestId("lethe-strip"));
  expect(region.getAttribute("tabindex")).toBe("0");
});

it("ranks hits with the kind, status, freshness, date, short id and a score bar", async () => {
  await search();
  const first = screen.getAllByTestId("lethe-hit")[0];
  expect(within(first).getByText("Statement of fact-aaaaaa")).toBeInTheDocument();
  expect(within(first).getByText("fact")).toBeInTheDocument();
  expect(within(first).getByText("active")).toBeInTheDocument();
  expect(within(first).getByText("recent")).toBeInTheDocument();
  expect(within(first).getByText(/12 Aug 2026|Aug 12, 2026/)).toBeInTheDocument();
  expect(within(first).getByText("…aaaaaa")).toBeInTheDocument();
  // similarity wins over score; without one the normalized score is shown
  expect(within(first).getByText("similarity 0.82")).toBeInTheDocument();
  const second = screen.getAllByTestId("lethe-hit")[1];
  expect(within(second).getByText("score 0.250")).toBeInTheDocument();
  expect(within(first).getByRole("meter")).toHaveAttribute("aria-valuenow", "82");
  expect(within(second).getByRole("meter")).toHaveAttribute("aria-valuenow", "50");
});

it("calls explain once per query however many hits are expanded, and matches by id", async () => {
  await search();
  const [a, b] = screen.getAllByRole("button", { name: "Why this result" });
  fireEvent.click(a);
  fireEvent.click(b);
  await screen.findByText("0.71");
  expect(calls("/dashboard/api/recall/explain")).toHaveLength(1);
  expect(JSON.parse(calls("/dashboard/api/recall/explain")[0][1].body)).toEqual({
    query: "checkout",
    limit: 50,
  });
  const first = screen.getAllByTestId("lethe-hit")[0];
  expect(within(first).getByText("0.44")).toBeInTheDocument();
  expect(within(first).getByText("stated by a user")).toBeInTheDocument();
  expect(within(first).getByText("3")).toBeInTheDocument();
  // the second hit is not in the explain response
  const second = screen.getAllByTestId("lethe-hit")[1];
  expect(within(second).getByText("No explanation for this result.")).toBeInTheDocument();
  // collapsing and reopening does not fetch again
  fireEvent.click(a);
  fireEvent.click(a);
  expect(calls("/dashboard/api/recall/explain")).toHaveLength(1);
});

it("never calls explain before an expand, and asks again for a new query", async () => {
  await search();
  expect(calls("/dashboard/api/recall/explain")).toHaveLength(0);
  fireEvent.click(screen.getAllByRole("button", { name: "Why this result" })[0]);
  await screen.findByText("0.71");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "other" } });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  await waitFor(() => expect(calls("/dashboard/api/recall")).toHaveLength(2));
  await screen.findByTestId("lethe-strip");
  fireEvent.click(screen.getAllByRole("button", { name: "Why this result" })[0]);
  await screen.findByText("0.71");
  expect(calls("/dashboard/api/recall/explain")).toHaveLength(2);
});

it("degrades a failed explanation to a message with a retry", async () => {
  responses["/dashboard/api/recall/explain"] = { status: 500, body: {} };
  await search();
  fireEvent.click(screen.getAllByRole("button", { name: "Why this result" })[0]);
  await screen.findByText("Could not load the explanation. Something went wrong. (500)");
  responses["/dashboard/api/recall/explain"] = { status: 200, body: EXPLAIN };
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("0.71");
  expect(calls("/dashboard/api/recall/explain")).toHaveLength(2);
});

it("says quietly when nothing is relevant, and when nothing came back", async () => {
  responses["/dashboard/api/recall"].body = { ...RECALL, nothingRelevant: true };
  await search();
  expect(
    screen.getByText("Nothing here clearly matches. These are the closest results.")
  ).toBeInTheDocument();
  cleanup();
  responses["/dashboard/api/recall"].body = recallBody({ nothingRelevant: true });
  renderPage();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  // The visible line (the status region repeats it for screen readers).
  await screen.findByText("Nothing recalled for that query.", { selector: "section p" });
});

it("shows an ErrorState with retry on HTTP errors, network failures and bad shapes", async () => {
  responses["/dashboard/api/recall"] = { status: 502, body: {} };
  renderPage();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong. (502)");
  responses["/dashboard/api/recall"] = { status: 200, body: { hits: "nope" } };
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("cannot read"));
  fetchMock.mockRejectedValueOnce(new Error("down"));
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Could not reach the Mnemosyne server.")
  );
});

it("parseRecall drops malformed hits and stages instead of crashing", () => {
  const parsed = parseRecall({
    hits: [hit("ok"), { id: 7 }, null],
    debug: { trace: [stage("embed", 1, 1, 3), { name: 3 }, { name: "x", ms: "y" }] },
  });
  expect(parsed?.latencyMs).toBeNull();
  expect(parseRecall(recallBody({ hits: [hit("a")] }))?.latencyMs).toBe(41);
  expect(parsed?.hits.map((h) => h.id)).toEqual(["ok"]);
  expect(parsed?.trace.map((s) => s.name)).toEqual(["embed"]);
  expect(parseRecall(null)).toBeNull();
  expect(parseRecall({ hits: {} })).toBeNull();
});

it("APP-039 parseRecall reads the primitive from the wire's `kind`", () => {
  const kinds = ["decision", "strategy", "task"];
  const parsed = parseRecall(recallBody({ hits: kinds.map((kind) => hit(kind, { kind })) }));
  expect(parsed?.hits.map((h) => h.primitive)).toEqual(kinds);
  // an older body that still says `primitive`, and one that names neither
  const legacy = parseRecall({
    hits: [
      { id: "a", content: "x", score: 1, primitive: "episode" },
      { id: "b", content: "x", score: 1 },
    ],
  });
  expect(legacy?.hits.map((h) => h.primitive)).toEqual(["episode", "fact"]);
});

it("APP-039 labels a decision as a decision, not as a fact", async () => {
  responses["/dashboard/api/recall"] = {
    status: 200,
    body: recallBody({
      hits: [hit("dec-aaaaaa", { kind: "decision" })],
      trace: [stage("embed", 1, 1, 3)],
    }),
  };
  await search("checkout", "es-419");
  const first = screen.getAllByTestId("lethe-hit")[0];
  expect(within(first).getByText("decisión")).toBeInTheDocument();
  expect(within(first).queryByText("hecho")).toBeNull();
});

it("renders in Spanish", async () => {
  await search("pagos", "es-419");
  const strip = screen.getByTestId("lethe-strip");
  expect(within(strip).getByText("Elegibilidad")).toBeInTheDocument();
  expect(within(strip).getAllByTitle("Oculto por tu nivel de acceso").length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "Recuperar" })).toBeInTheDocument();
  expect(screen.getByLabelText("Al")).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "Por qué este resultado" })[0]);
  await screen.findByText("dicho por un usuario");
});

it("announces the run and its outcome in a status region", async () => {
  let answer: (v: unknown) => void = () => {};
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
  renderPage();
  const status = screen.getByRole("status");
  expect(status).toHaveClass("sr-only");
  expect(status).toBeEmptyDOMElement();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "checkout" } });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  await waitFor(() => expect(status).toHaveTextContent("Recalling…"));
  answer({ ok: true, status: 200, json: async () => RECALL });
  await waitFor(() => expect(status).toHaveTextContent("2 results"));
});

it("announces nothing relevant, nothing at all, and leaves errors to the alert", async () => {
  responses["/dashboard/api/recall"].body = { ...RECALL, nothingRelevant: true };
  await search();
  expect(screen.getByRole("status")).toHaveTextContent(
    "2 results. Nothing here clearly matches. These are the closest results."
  );
  cleanup();
  responses["/dashboard/api/recall"].body = recallBody({});
  renderPage();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Nothing recalled for that query.")
  );
  cleanup();
  responses["/dashboard/api/recall"] = { status: 502, body: {} };
  renderPage();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  // The ErrorState is role="alert": it says it once, the status region stays quiet.
  await screen.findByRole("alert");
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});

it("announces the count with Spanish plurals", async () => {
  await search("pagos", "es-419");
  expect(screen.getByRole("status")).toHaveTextContent("2 resultados");
});

it("a hit with no explanation says why when the run was narrowed past what explain covers", async () => {
  renderPage();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "checkout" } });
  // Kinds and the options sit behind their buttons.
  fireEvent.click(screen.getByRole("button", { name: "Kinds: All" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "decision" }));
  expect(screen.getByRole("button", { name: "Kinds: decision" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Options" }));
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  await screen.findByTestId("lethe-strip");
  fireEvent.click(screen.getAllByRole("button", { name: "Why this result" })[1]);
  const second = screen.getAllByTestId("lethe-hit")[1];
  await within(second).findByText(
    "No explanation for this result. Explanations cover the top 50 results of the query alone, without kinds, a date, or more than 50 results."
  );
});

it("5.4 hits below the response's relevance floor wait, dimmed, behind a closed disclosure", async () => {
  responses["/dashboard/api/recall"].body = recallBody({
    hits: [
      hit("fact-aaaaaa", { similarity: 0.82 }),
      hit("fact-bbbbbb", { similarity: 0.31 }),
      hit("fact-cccccc", { similarity: 0.12 }),
    ],
    trace: [stage("embed", 1, 1, 3)],
    relevanceFloor: 0.5,
  });
  await search();
  const below = screen.getByTestId("lethe-below");
  expect(below.tagName).toBe("DETAILS");
  expect(below).not.toHaveAttribute("open");
  expect(below.querySelector("summary")).toHaveTextContent(
    "2 results below the relevance floor (0.50)"
  );
  const hits = screen.getAllByTestId("lethe-hit");
  expect(hits[0]!.closest("details")).toBeNull();
  expect(within(below).getAllByTestId("lethe-hit")).toHaveLength(2);
  expect(within(below).getAllByTestId("lethe-hit")[0]).toHaveAttribute("data-below", "true");
  // The ranks stay the server's order.
  expect(within(below).getByText("Rank 2")).toBeInTheDocument();
});

it("5.4 with nothing relevant the closest results show, all dimmed, with no disclosure", async () => {
  responses["/dashboard/api/recall"].body = { ...RECALL, nothingRelevant: true };
  await search();
  expect(screen.queryByTestId("lethe-below")).toBeNull();
  for (const h of screen.getAllByTestId("lethe-hit"))
    expect(h).toHaveAttribute("data-below", "true");
});

it("5.4 when no hit on the page clears the floor, they all show dimmed, never an empty page behind a fold", async () => {
  // nothingRelevant is judged over every candidate, so it can be false while this page has none.
  responses["/dashboard/api/recall"].body = recallBody({
    hits: [hit("fact-aaaaaa", { similarity: 0.41 }), hit("fact-bbbbbb", { similarity: 0.12 })],
    trace: [stage("embed", 1, 1, 3)],
    relevanceFloor: 0.5,
  });
  await search();
  expect(screen.queryByTestId("lethe-below")).toBeNull();
  const hits = screen.getAllByTestId("lethe-hit");
  expect(hits).toHaveLength(2);
  for (const h of hits) {
    expect(h.closest("details")).toBeNull();
    expect(h).toHaveAttribute("data-below", "true");
  }
});

it("5.4 a long text is cut with a button that shows it all", async () => {
  const long = `${"Long statement words ".repeat(30)}END`;
  responses["/dashboard/api/recall"].body = recallBody({
    hits: [hit("fact-aaaaaa", { content: long })],
    trace: [stage("embed", 1, 1, 3)],
  });
  await search();
  const row = screen.getAllByTestId("lethe-hit")[0]!;
  expect(row).not.toHaveTextContent("END");
  const more = within(row).getByRole("button", { name: "Show all" });
  expect(more).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(more);
  expect(row).toHaveTextContent("END");
  expect(within(row).getByRole("button", { name: "Show less" })).toHaveAttribute(
    "aria-expanded",
    "true"
  );
});

it("5.4 a fact hit links to its memory in the catalog; other kinds do not", async () => {
  responses["/dashboard/api/recall"].body = recallBody({
    hits: [hit("fact-aaaaaa"), hit("dec-1", { kind: "decision" })],
    trace: [stage("embed", 1, 1, 3)],
  });
  await search();
  const [fact, decision] = screen.getAllByTestId("lethe-hit");
  expect(within(fact!).getByRole("link", { name: "Open the memory" })).toHaveAttribute(
    "href",
    "/browser?open=fact-aaaaaa"
  );
  expect(within(decision!).queryByRole("link")).toBeNull();
});

it("APP-043 a recall or an explain the server takes too long on says so, and can be retried", async () => {
  const timeout = () => new DOMException("The operation timed out.", "TimeoutError");
  renderPage();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "checkout" } });
  fetchMock.mockRejectedValueOnce(timeout());
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The server took too long to answer. Try again in a moment."
  );
  expect(calls("/dashboard/api/recall")[0][1].signal).toBeInstanceOf(AbortSignal);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByTestId("lethe-strip");
  // the explain behind "Why this result" too
  fetchMock.mockRejectedValueOnce(timeout());
  fireEvent.click(screen.getAllByRole("button", { name: "Why this result" })[0]);
  expect(await screen.findByText(/took too long to answer/)).toBeInTheDocument();
  expect(calls("/dashboard/api/recall/explain")[0][1].signal).toBeInstanceOf(AbortSignal);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("0.71");
});
