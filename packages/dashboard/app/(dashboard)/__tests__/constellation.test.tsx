import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nProvider } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n/core";
import RelationsPage from "../relations/page";
import { drawLink, drawNode } from "../relations/sky-2d";
import { isMention, parseGraph, placeLabels, radius, shortLabel } from "../relations/model";

// jsdom has no canvas or WebGL: react-force-graph is replaced by a stand-in that keeps the props
// it was given (the page's drawing callbacks, its data, its settings) and a camera to spy on.
type Props = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const { drawn, camera, stub } = vi.hoisted(() => {
  const drawn: { "2d": Props | null; "3d": Props | null } = { "2d": null, "3d": null };
  const camera = {
    zoom: vi.fn((..._: unknown[]) => 1),
    zoomToFit: vi.fn(),
    centerAt: vi.fn(),
    d3ReheatSimulation: vi.fn(),
    screen2GraphCoords: (x: number, y: number) => ({ x, y }),
    graph2ScreenCoords: (x: number, y: number) => ({ x, y }),
    camera: () => ({ position: { x: 0, y: 0, z: 100 } }),
    cameraPosition: vi.fn(),
  };
  const stub = async (mode: "2d" | "3d") => {
    const { useImperativeHandle } = await import("react");
    return {
      default: function ForceGraph(props: Props) {
        drawn[mode] = props;
        useImperativeHandle(props.ref, () => camera);
        return <canvas data-testid={`fg-${mode}`} />;
      },
    };
  };
  return { drawn, camera, stub };
});
vi.mock("react-force-graph-2d", () => stub("2d"));
vi.mock("react-force-graph-3d", () => stub("3d"));

const node = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "entity",
  entityKind: "person",
  label: `Node ${id}`,
  description: `About ${id}`,
  mentionCount: 3,
  factCount: 2,
  avgMemoryStrength: 0.5,
  createdAt: "2026-08-12T09:30:00.000Z",
  ...over,
});
const edge = (id: string, source: string, target: string, over: Record<string, unknown> = {}) => ({
  id,
  source,
  target,
  relation: "works_with",
  confidence: 0.9,
  provenance: "user_stated",
  ...over,
});
const graph = (nodes: unknown[], edges: unknown[]) => ({
  nodes,
  edges,
  meta: {
    entityCount: nodes.length,
    episodeCount: 0,
    decisionCount: 0,
    relationCount: edges.length,
  },
});

const SAMPLE = graph(
  [
    node("a", { label: "Ana", mentionCount: 12 }),
    node("b", { label: "Bea", mentionCount: 1 }),
    node("c", { label: "Cora", mentionCount: 0, factCount: 9 }),
    node("d", { label: "Plan", kind: "decision", entityKind: undefined }),
  ],
  [
    edge("e1", "a", "b"),
    edge("e2", "a", "c", {
      relation: "semantically_related",
      confidence: 0.82,
      provenance: "semantic_knn",
    }),
    edge("e3", "d", "a", { relation: "decided_by", confidence: 0.6, provenance: "inferred" }),
    edge("e4", "b", "c", { relation: "knows", provenance: null }),
  ]
);
// Ana's neighbourhood (GET /graph?focus=a).
const NEAR_ANA = graph(
  [node("a", { label: "Ana", mentionCount: 12 }), node("b", { label: "Bea", mentionCount: 1 })],
  [edge("e1", "a", "b")]
);

let body: unknown = SAMPLE;
let status = 200;
const fetchMock = vi.fn();
beforeEach(() => {
  body = SAMPLE;
  status = 200;
  fetchMock.mockImplementation(async (url: string) => ({
    ok: status === 200,
    status,
    json: async () => (url.includes("focus=") ? NEAR_ANA : body),
  }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  drawn["2d"] = drawn["3d"] = null;
});

const renderPage = async (locale: Locale = "en-US") => {
  const view = render(
    <I18nProvider locale={locale}>
      <RelationsPage />
    </I18nProvider>
  );
  await screen.findByTestId("fg-2d");
  return view;
};
const svgNode = (label: RegExp) =>
  within(screen.getByTestId("sky-graph")).getByRole("button", { name: label });
const proxies = () => within(screen.getByTestId("sky-graph")).getAllByRole("button");

/** A 2D context that records what is drawn. */
function fakeCtx() {
  const calls: Array<[string, unknown[]]> = [];
  const ctx: Record<string, unknown> = { calls };
  for (const m of [
    "beginPath",
    "arc",
    "moveTo",
    "lineTo",
    "closePath",
    "fill",
    "stroke",
    "setLineDash",
    "fillText",
    "strokeText",
  ])
    ctx[m] = (...args: unknown[]) => calls.push([m, args]);
  ctx.measureText = (s: string) => ({ width: s.length * 6 });
  return ctx as unknown as CanvasRenderingContext2D & { calls: typeof calls };
}
const COLORS = { ivory: "#f5ecde", electric: "#1a18f0" };

it("fetches the graph with the semantic overlay and owns the room's h1", async () => {
  await renderPage();
  expect(fetchMock).toHaveBeenCalledWith(
    "/dashboard/api/graph?includeSemantic=true&includeMentions=true",
    // APP-043: the load gives up on a server that never answers.
    { signal: expect.any(AbortSignal) }
  );
  const h1 = screen.getByRole("heading", { level: 1 });
  expect(h1.textContent).toMatch(/^Graph — /);
  expect(screen.getByTestId("scene-heading")).toContainElement(h1);
});

it("draws inferred edges dashed, mentions dotted, stated solid and conflicts doubled", () => {
  const a = { id: "a", x: 0, y: 0 };
  const b = { id: "b", x: 10, y: 0 };
  const drawOf = (over: Record<string, unknown>) => {
    const ctx = fakeCtx();
    const e = parseGraph({ nodes: [], edges: [edge("e", "a", "b", over)] })!.edges[0]!;
    drawLink(ctx, { id: "e", source: a as never, target: b as never, edge: e }, 2, COLORS, null);
    return {
      dash: ctx.calls.find(([m]) => m === "setLineDash")![1][0],
      strokes: ctx.calls.filter(([m]) => m === "stroke").length,
    };
  };
  // Screen px at zoom 2: the dash is halved in graph units.
  expect(drawOf({ provenance: "semantic_knn" }).dash).toEqual([3, 2]);
  expect(drawOf({ provenance: "inferred" }).dash).toEqual([3, 2]);
  expect(drawOf({ provenance: "episode_facts", relation: "mentions" }).dash).toEqual([1.5, 2]);
  expect(drawOf({}).dash).toEqual([]);
  expect(drawOf({}).strokes).toBe(1);
  expect(drawOf({ relation: "conflicts_with" }).strokes).toBe(2);
});

it("draws entities solid, episodes hollow and decisions as diamonds, ringed when focused", () => {
  const shape = (kind: string, selected = false, ring = false) => {
    const ctx = fakeCtx();
    const n = { ...node("n", { kind }), r: 8, text: "n", x: 0, y: 0 } as never;
    drawNode(ctx, n, COLORS, selected, ring);
    return ctx;
  };
  const arcs = (ctx: ReturnType<typeof fakeCtx>) => ctx.calls.filter(([m]) => m === "arc").length;
  expect(arcs(shape("entity"))).toBe(1);
  expect(shape("entity").fillStyle).toBe(COLORS.ivory);
  expect(shape("episode").fillStyle).toBe(COLORS.electric);
  const diamond = shape("decision");
  expect(arcs(diamond)).toBe(0);
  expect(diamond.calls.filter(([m]) => m === "lineTo")).toHaveLength(3);
  // The keyboard's focus ring, and the selection's two rings.
  expect(arcs(shape("entity", false, true))).toBe(2);
  expect(arcs(shape("entity", true))).toBe(3);
});

it("sizes nodes by mentionCount and falls back to factCount", async () => {
  await renderPage();
  const r = (label: string) =>
    (drawn["2d"]!.graphData.nodes as Props[]).find((n) => n.label === label)!.r as number;
  expect(r("Ana")).toBeGreaterThan(r("Bea"));
  // Cora has no mentions but 9 facts: bigger than Bea (1 mention)
  expect(r("Cora")).toBeGreaterThan(r("Bea"));
  expect(r("Ana")).toBe(radius(parseGraph(SAMPLE)!.nodes[0]!));
});

it("makes the graph one tab stop; arrows move focus, a press selects, Escape clears and returns focus", async () => {
  await renderPage();
  expect(proxies()).toHaveLength(4);
  // Native buttons: Enter and Space press them.
  expect(proxies().every((b) => b.tagName === "BUTTON")).toBe(true);
  // Tab enters the graph once (one tabindex 0); the next Tab leaves it (all others -1).
  expect(proxies().filter((n) => n.getAttribute("tabindex") === "0")).toHaveLength(1);
  const ana = svgNode(/^Ana/);
  expect(ana.getAttribute("tabindex")).toBe("0");
  ana.focus();
  fireEvent.keyDown(ana, { key: "ArrowRight" });
  expect(document.activeElement).toBe(svgNode(/^Cora/));
  expect(svgNode(/^Cora/).getAttribute("tabindex")).toBe("0");
  expect(ana.getAttribute("tabindex")).toBe("-1");
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement).toBe(svgNode(/^Bea/));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(svgNode(/^Plan/));
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(document.activeElement).toBe(svgNode(/^Ana/));
  expect(svgNode(/^Ana/).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(svgNode(/^Ana/));
  expect(svgNode(/^Ana/).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByTestId("sky-card")).toHaveTextContent("Ana");
  fireEvent.keyDown(svgNode(/^Ana/), { key: "ArrowRight" });
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByTestId("sky-card")).toBeNull();
  expect(document.activeElement).toBe(svgNode(/^Ana/));
  fireEvent.click(svgNode(/^Bea/));
  expect(screen.getByTestId("sky-card")).toHaveTextContent("Bea");
  fireEvent.click(within(screen.getByTestId("sky-card")).getByRole("button", { name: "Close" }));
  expect(document.activeElement).toBe(svgNode(/^Bea/));
});

it("labels the drawing as a group with a hint and a summary; the canvas is hidden from AT", async () => {
  await renderPage();
  const sky = screen.getByTestId("sky-graph");
  expect(sky.getAttribute("role")).toBe("group");
  expect(sky.getAttribute("aria-label")).toBe("Relation graph");
  const hint = document.getElementById(sky.getAttribute("aria-describedby")!)!;
  expect(hint).toHaveTextContent(
    "Use the arrow keys to move between nodes; Enter selects and Escape clears the selection or goes back."
  );
  expect(hint.className).toContain("sr-only");
  expect(screen.getByTestId("fg-2d").closest("[aria-hidden=true]")).not.toBeNull();
  expect(screen.getByText("Showing 4 of 4 nodes and 4 relations.")).toBeInTheDocument();
  // Every node stays named and pressable.
  expect(svgNode(/^Cora, entity/).getAttribute("aria-pressed")).toBe("false");
});

it("announces the selection politely with its relation count", async () => {
  await renderPage();
  const status = () => screen.getByRole("status");
  expect(status()).toHaveTextContent("");
  fireEvent.click(svgNode(/^Ana/));
  expect(status()).toHaveTextContent("Ana selected · 3 relations");
  fireEvent.click(svgNode(/^Bea/));
  expect(status()).toHaveTextContent("Bea selected · 2 relations");
});

it("a click on a canvas node selects it, a click on the background clears it", async () => {
  await renderPage();
  const ana = (drawn["2d"]!.graphData.nodes as Props[]).find((n) => n.label === "Ana")!;
  act(() => drawn["2d"]!.onNodeClick(ana));
  expect(screen.getByTestId("sky-card")).toHaveTextContent("Ana");
  act(() => drawn["2d"]!.onBackgroundClick());
  expect(screen.queryByTestId("sky-card")).toBeNull();
});

it("clears the selection when the kind filter hides the selected node", async () => {
  await renderPage();
  fireEvent.click(svgNode(/^Ana/));
  fireEvent.click(screen.getByRole("radio", { name: "decision" }));
  fireEvent.click(screen.getByRole("radio", { name: "All" }));
  expect(screen.queryByTestId("sky-card")).toBeNull();
  expect(svgNode(/^Ana/).getAttribute("aria-pressed")).toBe("false");
});

it("has a legend entry for conflicts", async () => {
  await renderPage();
  expect(screen.getByText("Conflict")).toBeInTheDocument();
});

it("keeps hit targets at 24 px on screen whatever the zoom", async () => {
  await renderPage();
  const paint = drawn["2d"]!.nodePointerAreaPaint;
  const radiusAt = (r: number, k: number) => {
    const ctx = fakeCtx();
    paint({ r, x: 0, y: 0 }, "#000", ctx, k);
    return ctx.calls.find(([m]) => m === "arc")![1][2] as number;
  };
  expect(radiusAt(7, 0.38)).toBeCloseTo(12 / 0.38);
  expect(radiusAt(20, 1)).toBe(20);
  expect(radiusAt(5, 1)).toBe(12);
});

it("derived episode → entity lines are mentions, not relations", () => {
  const g = parseGraph({
    nodes: [node("a", { kind: "episode" }), node("b")],
    edges: [
      { id: "r1", source: "a", target: "b", relation: "related", confidence: 1, provenance: null },
      {
        id: "men:a:b",
        source: "a",
        target: "b",
        relation: "mentions",
        confidence: 1,
        provenance: "episode_facts",
      },
    ],
    meta: { entityCount: 1, episodeCount: 1, decisionCount: 0, relationCount: 2 },
  })!;
  expect(g.edges.filter(isMention).map((e) => e.id)).toEqual(["men:a:b"]);
  expect(g.counts.relation).toBe(1);
});

it("labels of neighbouring nodes never overlap or leave the view; one with no free spot is left out", () => {
  const size = 12;
  const bounds = { x0: 0, y0: 0, x1: 900, y1: 600 };
  // Two episodes side by side: both labels centred under them would collide.
  const items = [
    { id: "a", x: 400, y: 300, r: 9, w: 108 },
    { id: "b", x: 470, y: 300, r: 9, w: 108 },
    { id: "c", x: 435, y: 330, r: 9, w: 48 },
  ];
  const placed = placeLabels(items, items, size, bounds);
  expect(placed.has("a")).toBe(true);
  const boxes = items
    .filter((it) => placed.has(it.id))
    .map((it) => {
      const p = placed.get(it.id)!;
      return {
        x0: p.x - it.w / 2,
        x1: p.x + it.w / 2,
        y0: p.y - size * 0.8,
        y1: p.y + size * 0.25,
      };
    });
  for (let i = 0; i < boxes.length; i++) {
    const p = boxes[i]!;
    expect(p.x0 >= 0 && p.x1 <= 900 && p.y0 >= 0 && p.y1 <= 600).toBe(true);
    for (let j = i + 1; j < boxes.length; j++) {
      const q = boxes[j]!;
      expect(p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1).toBe(false);
    }
  }
  // A lone node: the label goes under it; at the bottom edge, above it.
  const lone = { id: "x", x: 450, y: 300, r: 9, w: 30 };
  expect(placeLabels([lone], [lone], size, bounds).get("x")!.y).toBeGreaterThan(300);
  const low = { ...lone, y: 595 };
  expect(placeLabels([low], [low], size, bounds).get("x")!.y).toBeLessThan(595);
});

it("draws only the biggest nodes' labels, 12 px on screen", async () => {
  const many = Array.from({ length: 120 }, (_, i) =>
    node(`n${i}`, { label: `B${i}`, mentionCount: i })
  );
  body = graph(many, []);
  await renderPage();
  expect(screen.getByText(/120 entities/)).toBeInTheDocument();
  // Spread the nodes wide apart, so only the label cap limits them.
  const nodes = drawn["2d"]!.graphData.nodes as Props[];
  nodes.forEach((n, i) =>
    Object.assign(n, { x: (i % 12) * 80 + 40, y: Math.floor(i / 12) * 40 + 20 })
  );
  const ctx = fakeCtx();
  drawn["2d"]!.onRenderFramePost(ctx, 1);
  const labels = ctx.calls.filter(([m]) => m === "fillText").map(([, a]) => a[0]);
  expect(labels.length).toBeGreaterThan(0);
  expect(labels.length).toBeLessThanOrEqual(60);
  expect(ctx.font).toMatch(/^12px /);
  expect(labels).toContain("B119");
  expect(labels).not.toContain("B0");
});

it("lists the selected node's relations from the edges, with direction and stated or inferred", async () => {
  await renderPage();
  fireEvent.click(svgNode(/^Ana/));
  const card = screen.getByTestId("sky-card");
  expect(card).toHaveTextContent("About a");
  expect(card).toHaveTextContent("Facts");
  expect(card).toHaveTextContent("Mentions");
  const rels = within(card)
    .getAllByRole("listitem")
    .map((li) => li.textContent);
  expect(rels).toHaveLength(3);
  expect(rels.join("|")).toContain("works_with → Bea");
  expect(rels.join("|")).toContain("Plan → decided_by");
  expect(rels.join("|")).toMatch(/works_with → Bea.*stated · 0\.90/);
  // Known verbs are words; an unknown one prints as sent.
  expect(rels.join("|")).toMatch(/similar in meaning to → Cora.*inferred · 0\.82/);
});

it("the card localizes relation verbs and the entity kind", async () => {
  await renderPage("es-419");
  fireEvent.click(svgNode(/^Ana/));
  const card = screen.getByTestId("sky-card");
  expect(card).toHaveTextContent("entidad · persona");
  expect(card).toHaveTextContent("de significado similar a → Cora");
});

it("filters by kind with a segmented radio group that reports its state", async () => {
  await renderPage();
  const group = screen.getByRole("radiogroup", { name: "Filter by kind" });
  expect(within(group).getByRole("radio", { name: "All" })).toBeChecked();
  fireEvent.click(within(group).getByRole("radio", { name: "decision" }));
  expect(proxies()).toHaveLength(1);
  expect(within(group).getByRole("radio", { name: "decision" })).toBeChecked();
  expect(drawn["2d"]!.graphData.nodes).toHaveLength(1);
});

it("keeps the controls and the legend in bands of their own, outside the drawing", async () => {
  await renderPage();
  const drawing = screen.getByTestId("sky-graph").parentElement!;
  expect(drawing).not.toContainElement(screen.getByRole("radiogroup", { name: "Filter by kind" }));
  expect(drawing).not.toContainElement(screen.getByRole("group", { name: "Graph controls" }));
  expect(drawing).not.toContainElement(screen.getByText("Conflict"));
  // The size note waits behind the legend's (i).
  expect(screen.getByRole("button", { name: "About: Node size" })).toHaveAccessibleDescription(
    "Size shows mentions, or facts when a node has none."
  );
});

it("zooms, frames and pauses from the controls", async () => {
  await renderPage();
  const controls = screen.getByRole("group", { name: "Graph controls" });
  fireEvent.click(within(controls).getByRole("button", { name: "Zoom in" }));
  expect(camera.zoom).toHaveBeenLastCalledWith(1.5, 300);
  fireEvent.click(within(controls).getByRole("button", { name: "Zoom out" }));
  expect(camera.zoom).toHaveBeenLastCalledWith(1 / 1.5, 300);
  fireEvent.click(within(controls).getByRole("button", { name: "Fit" }));
  expect(camera.zoomToFit).toHaveBeenLastCalledWith(600, 48);
  // The simulation runs live; Pause stops it, pressing again warms it up.
  expect(drawn["2d"]!.cooldownTicks).toBe(Infinity);
  expect(drawn["2d"]!.warmupTicks).toBe(0);
  const pause = within(controls).getByRole("button", { name: "Pause" });
  fireEvent.click(pause);
  expect(pause).toHaveAttribute("aria-pressed", "true");
  expect(drawn["2d"]!.cooldownTicks).toBe(0);
  camera.d3ReheatSimulation.mockClear();
  fireEvent.click(pause);
  expect(camera.d3ReheatSimulation).toHaveBeenCalled();
});

it("under reduced motion draws the graph settled, moves the camera at once and has no Pause", async () => {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("reduce"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  await renderPage();
  await waitFor(() => expect(drawn["2d"]!.cooldownTicks).toBe(0));
  expect(drawn["2d"]!.warmupTicks).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Fit" }));
  expect(camera.zoomToFit).toHaveBeenLastCalledWith(0, 48);
});

it("enters an entity's neighbourhood and comes back with Escape, focus following", async () => {
  await renderPage();
  fireEvent.click(svgNode(/^Ana/));
  fireEvent.click(screen.getByRole("button", { name: "Enter the neighbourhood of Ana" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/dashboard/api/graph?focus=a&includeSemantic=true&includeMentions=true",
      expect.anything()
    )
  );
  await waitFor(() => expect(proxies()).toHaveLength(2));
  const trail = screen.getByRole("navigation", { name: "Where you are in the graph" });
  expect(trail).toHaveTextContent("Whole constellation›Ana");
  expect(within(trail).getByText("Ana")).toHaveAttribute("aria-current", "page");
  const back = screen.getByRole("button", { name: "Back to Whole constellation" });
  await waitFor(() => expect(document.activeElement).toBe(back));
  // Already inside: the card offers no second Enter.
  expect(screen.queryByRole("button", { name: /^Enter the neighbourhood/ })).toBeNull();
  // The first Escape closes the card, the second goes back.
  fireEvent.keyDown(back, { key: "Escape" });
  expect(screen.queryByTestId("sky-card")).toBeNull();
  fireEvent.keyDown(back, { key: "Escape" });
  await waitFor(() => expect(proxies()).toHaveLength(4));
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/dashboard/api/graph?includeSemantic=true&includeMentions=true",
    expect.anything()
  );
  expect(screen.queryByRole("navigation", { name: "Where you are in the graph" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(svgNode(/^Ana/)));
  expect(screen.getByTestId("sky-card")).toHaveTextContent("Ana");
});

it("a double click enters an entity; decisions have no neighbourhood to enter", async () => {
  await renderPage();
  const nodes = () => drawn["2d"]!.graphData.nodes as Props[];
  const plan = nodes().find((n) => n.label === "Plan")!;
  act(() => drawn["2d"]!.onNodeClick(plan));
  expect(screen.queryByRole("button", { name: /^Enter the neighbourhood/ })).toBeNull();
  act(() => drawn["2d"]!.onNodeClick(plan));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const ana = nodes().find((n) => n.label === "Ana")!;
  act(() => drawn["2d"]!.onNodeClick(ana));
  act(() => drawn["2d"]!.onNodeClick(ana));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/dashboard/api/graph?focus=a&includeSemantic=true&includeMentions=true",
      expect.anything()
    )
  );
});

it("turns to 3D with the same nodes and edges, and back", async () => {
  await renderPage();
  fireEvent.click(screen.getByRole("radio", { name: "3D" }));
  await screen.findByTestId("fg-3d");
  expect(screen.queryByTestId("fg-2d")).toBeNull();
  expect(drawn["3d"]!.graphData.nodes).toHaveLength(4);
  expect(drawn["3d"]!.graphData.links).toHaveLength(4);
  // A node's name shows on hover, escaped (the tooltip is HTML).
  expect(drawn["3d"]!.nodeLabel({ label: "<b>x</b>" })).toBe("&#60;b&#62;x&#60;/b&#62;");
  // The keyboard works the same over the 3D drawing.
  expect(proxies()).toHaveLength(4);
  fireEvent.click(screen.getByRole("radio", { name: "2D" }));
  await screen.findByTestId("fg-2d");
});

it("shows the empty state over the scene when there are no nodes", async () => {
  body = graph([], []);
  render(
    <I18nProvider locale="en-US">
      <RelationsPage />
    </I18nProvider>
  );
  expect(await screen.findByText(/The graph fills up/)).toBeInTheDocument();
  expect(screen.getByTestId("scene-heading")).toBeInTheDocument();
  expect(screen.queryByTestId("sky-graph")).toBeNull();
  // The HUD flows above the overlay instead of sitting under it: the heading is never covered.
  const hud = screen.getByTestId("scene-heading").closest(".sky-hud")!;
  expect(hud).not.toHaveClass("absolute");
  expect(hud.compareDocumentPosition(screen.getByTestId("sky-overlay"))).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING
  );
});

it("turns a failed request or a bad shape into an error state, never a crash", async () => {
  status = 503;
  const { unmount } = render(
    <I18nProvider locale="en-US">
      <RelationsPage />
    </I18nProvider>
  );
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  unmount();
  status = 200;
  body = { nodes: [{ nope: 1 }], edges: "x" };
  render(
    <I18nProvider locale="en-US">
      <RelationsPage />
    </I18nProvider>
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("could not be read");
  expect(screen.queryByTestId("sky-graph")).toBeNull();
});

it("renders in Spanish with no English left", async () => {
  await renderPage("es-419");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Grafo — /);
  expect(screen.getByTestId("sky-graph").getAttribute("aria-label")).toBe("Grafo de relaciones");
  expect(screen.getByRole("radiogroup", { name: "Filtrar por tipo" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Controles del grafo" })).toBeInTheDocument();
  fireEvent.click(svgNode(/^Ana/));
  const card = screen.getByTestId("sky-card");
  expect(card).toHaveTextContent("Hechos");
  expect(card).toHaveTextContent("Menciones");
  expect(card).toHaveTextContent("declarada · 0.90");
  expect(card).toHaveTextContent("inferida · 0.82");
  expect(
    within(card).getByRole("button", { name: "Entrar al vecindario de Ana" })
  ).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText(/stated|Facts|Zoom/)).toBeNull());
});

it("Escape on the filter clears the selection and leaves focus on it", async () => {
  await renderPage();
  fireEvent.click(svgNode(/^Ana/));
  expect(screen.getByTestId("sky-card")).toBeInTheDocument();
  const chip = screen.getByRole("radio", { name: "All" });
  chip.focus();
  fireEvent.keyDown(chip, { key: "Escape" });
  expect(screen.queryByTestId("sky-card")).toBeNull();
  expect(document.activeElement).toBe(chip);
});

it("a selection the 200-node cap drops is cleared, not kept for later", async () => {
  const big = Array.from({ length: 200 }, (_, i) =>
    node(`n${i}`, { label: `Big${i}`, mentionCount: 100 + i })
  );
  body = graph([...big, node("small", { kind: "decision", label: "Small", mentionCount: 0 })], []);
  await renderPage();
  const group = screen.getByRole("radiogroup", { name: "Filter by kind" });
  fireEvent.click(within(group).getByRole("radio", { name: "decision" }));
  fireEvent.click(svgNode(/^Small/));
  expect(screen.getByTestId("sky-card")).toHaveTextContent("Small");
  // All kinds: the smallest node is past the cap, so it is not drawn and not selected.
  fireEvent.click(within(group).getByRole("radio", { name: "All" }));
  expect(screen.queryByTestId("sky-card")).toBeNull();
  fireEvent.click(within(group).getByRole("radio", { name: "decision" }));
  expect(svgNode(/^Small/).getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByTestId("sky-card")).toBeNull();
});

it("shortens a long label by characters as people read them, never splitting an emoji", () => {
  expect(shortLabel("aaaaaaaaaaaaaaaa😀😀b")).toBe("aaaaaaaaaaaaaaaa😀…");
  expect(shortLabel("Ana")).toBe("Ana");
});

it("APP-043 past the node cap the summary is said visibly, not only to screen readers", async () => {
  body = graph(
    Array.from({ length: 205 }, (_, i) => node(`n${i}`)),
    []
  );
  await renderPage();
  const summary = screen.getByText("Showing 200 of 205 nodes and 0 relations.");
  expect(summary.className).not.toContain("sr-only");
  // Under the cap it stays a screen-reader summary.
  cleanup();
  body = SAMPLE;
  await renderPage();
  expect(screen.getByText("Showing 4 of 4 nodes and 4 relations.").className).toContain("sr-only");
});

it("5.4 the card links a node to where it lives: entity to the catalog, episode to its session", async () => {
  body = graph(
    [
      node("a", { label: "Ana", mentionCount: 12 }),
      node("mepi_1", { label: "Codes session", kind: "episode", entityKind: undefined }),
      node("d", { label: "Plan", kind: "decision", entityKind: undefined }),
    ],
    []
  );
  await renderPage();
  fireEvent.click(svgNode(/^Ana/));
  expect(
    within(screen.getByTestId("sky-card")).getByRole("link", { name: "Open in the catalog" })
  ).toHaveAttribute("href", "/browser?type=entities&q=Ana");
  fireEvent.click(svgNode(/^Codes session/));
  expect(
    within(screen.getByTestId("sky-card")).getByRole("link", { name: "Open the session" })
  ).toHaveAttribute("href", "/sessions?open=mepi_1");
  fireEvent.click(svgNode(/^Plan/));
  expect(
    within(screen.getByTestId("sky-card")).getByRole("link", { name: "Open in the catalog" })
  ).toHaveAttribute("href", "/browser?type=decisions");
});

it("APP-043 a graph the server takes too long to send says so, and can be asked for again", async () => {
  fetchMock.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
  render(
    <I18nProvider locale="en-US">
      <RelationsPage />
    </I18nProvider>
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The server took too long to answer. Try again in a moment."
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByTestId("fg-2d");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("APP-058 the List view gives the same nodes and relations as tables, without the canvas", async () => {
  await renderPage();
  fireEvent.click(screen.getByRole("radio", { name: "List" }));
  expect(screen.queryByTestId("sky-graph")).toBeNull();
  expect(screen.queryByTestId("fg-2d")).toBeNull();
  // The canvas tools have nothing to act on in a list.
  expect(screen.queryByRole("group", { name: "Graph controls" })).toBeNull();

  const nodes = screen.getByRole("table", { name: "Nodes" });
  expect(
    within(nodes)
      .getAllByRole("columnheader")
      .map((h) => h.textContent)
  ).toEqual(["Name", "Kind", "Facts", "Mentions", "Relations"]);
  expect(within(nodes).getAllByRole("row")).toHaveLength(5);
  const ana = within(nodes).getByRole("row", { name: /Ana/ });
  expect(
    within(ana)
      .getAllByRole("cell")
      .map((c) => c.textContent)
  ).toEqual(["Ana", "entity · person", "2", "12", "3"]);

  const rels = screen.getByRole("table", { name: "Relations" });
  expect(within(rels).getAllByRole("row")).toHaveLength(5);
  const similar = within(rels).getByRole("row", { name: /similar in meaning to/ });
  expect(
    within(similar)
      .getAllByRole("cell")
      .map((c) => c.textContent)
  ).toEqual(["Ana", "similar in meaning to", "Cora", "inferred · 0.82"]);

  // A name opens the same card as the drawing.
  fireEvent.click(within(nodes).getByRole("button", { name: "Ana" }));
  expect(screen.getByTestId("sky-card")).toHaveTextContent("Mentions");
  // The kind filter narrows the list too.
  fireEvent.click(screen.getByRole("radio", { name: "decision" }));
  expect(within(screen.getByRole("table", { name: "Nodes" })).getAllByRole("row")).toHaveLength(2);
  expect(within(screen.getByRole("table", { name: "Relations" })).getAllByRole("row")).toHaveLength(
    1
  );
  // And back to the drawing.
  fireEvent.click(screen.getByRole("radio", { name: "2D" }));
  await screen.findByTestId("fg-2d");
  expect(screen.queryByRole("table")).toBeNull();
});

it("APP-058 the List view speaks Spanish", async () => {
  await renderPage("es-419");
  fireEvent.click(screen.getByRole("radio", { name: "Lista" }));
  expect(screen.getByRole("table", { name: "Nodos" })).toBeInTheDocument();
  expect(screen.getByRole("table", { name: "Relaciones" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Nombre" })).toBeInTheDocument();
});
