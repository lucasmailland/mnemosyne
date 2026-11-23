"use client";

import { useEffect, useMemo, useRef } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";

import {
  ALPHA_DECAY,
  CAMERA_MS,
  MAX_ZOOM,
  SETTLE_MS,
  DOUBLE_CLICK_MS,
  SETTLE_TICKS,
  isInferred,
  isMention,
  placeLabels,
  radius,
  shortLabel,
  type GraphEdge,
  type GraphNode,
  type SkyProps,
} from "./model";

/**
 * The constellation in 2D: react-force-graph-2d on a transparent canvas over the electric scene.
 * Nodes and edges are drawn by hand so they keep the room's marks: entities solid, episodes
 * hollow, decisions diamonds; stated edges solid, inferred dashed, mentions dotted, conflicts
 * doubled. Labels are placed each frame where they cover no other label or node. Loaded only in
 * the browser (next/dynamic, no SSR).
 */

type SkyNode = GraphNode & {
  r: number;
  text: string;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
};
type SkyLink = { id: string; source: string | SkyNode; target: string | SkyNode; edge: GraphEdge };

const LABEL_PX = 12;

export default function Sky2D(props: SkyProps) {
  const { nodes, edges, labelled, selectedId, ringId, width, height, paused, reduced, colors } =
    props;
  const fg = useRef<ForceGraphMethods<SkyNode, SkyLink> | undefined>(undefined);
  // The simulation moves the node objects in place: keep them, so a filter change or a resize
  // leaves every node where it was.
  const known = useRef(new Map<string, SkyNode>());
  const data = useMemo(() => {
    const prev = known.current;
    const list: SkyNode[] = nodes.map((n) => {
      const p = prev.get(n.id);
      return {
        ...n,
        r: radius(n),
        text: shortLabel(n.label),
        ...(p ? { x: p.x, y: p.y, fx: p.fx, fy: p.fy } : {}),
      };
    });
    known.current = new Map(list.map((n) => [n.id, n]));
    const links: SkyLink[] = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      edge: e,
    }));
    return { nodes: list, links };
  }, [nodes, edges]);

  const font = useRef("sans-serif");
  useEffect(() => {
    font.current =
      getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim() ||
      "sans-serif";
  }, []);

  const ms = reduced ? 0 : CAMERA_MS;
  const fitPending = useRef(true);
  useEffect(() => {
    fitPending.current = true;
  }, [props.frame]);
  // Longer links and a stronger push than the library's defaults, so the lines between the
  // large ivory nodes stay visible instead of collapsing under them.
  useEffect(() => {
    const g = fg.current;
    if (!g || typeof g.d3Force !== "function") return;
    (g.d3Force("link") as { distance?: (d: number) => unknown } | undefined)?.distance?.(70);
    (g.d3Force("charge") as { strength?: (s: number) => unknown } | undefined)?.strength?.(-180);
    g.d3ReheatSimulation();
  }, [data]);
  useEffect(() => {
    props.api.current = {
      zoomBy: (f) => {
        const g = fg.current;
        if (g) g.zoom(g.zoom() * f, ms / 2);
      },
      fit: () => fg.current?.zoomToFit(ms, 48),
      reveal: (id) => {
        const g = fg.current;
        const n = known.current.get(id);
        if (!g || !n || n.x === undefined || n.y === undefined) return;
        const p = g.graph2ScreenCoords(n.x, n.y);
        if (p.x < 24 || p.y < 24 || p.x > width - 24 || p.y > height - 24)
          g.centerAt(n.x, n.y, ms / 2);
      },
    };
  });
  // Resuming warms the simulation up again; pausing just lets it stop (cooldownTicks 0).
  // Only on a resume, never on mount: before its first update the engine has no layout to warm.
  const wasPaused = useRef(paused);
  useEffect(() => {
    if (wasPaused.current && !paused && !reduced) fg.current?.d3ReheatSimulation();
    wasPaused.current = paused;
  }, [paused, reduced]);

  const last = useRef<{ id: string; at: number } | null>(null);

  return (
    <ForceGraph2D<SkyNode, SkyLink>
      ref={fg}
      graphData={data}
      width={width}
      height={height}
      backgroundColor="rgba(0,0,0,0)"
      warmupTicks={reduced ? SETTLE_TICKS : 0}
      cooldownTicks={paused || reduced ? 0 : Infinity}
      d3AlphaDecay={ALPHA_DECAY}
      // force-graph stops on time only (its alpha floor is 0): the layout has settled by then.
      cooldownTime={SETTLE_MS}
      maxZoom={MAX_ZOOM}
      onEngineStop={() => {
        if (!fitPending.current) return;
        fitPending.current = false;
        fg.current?.zoomToFit(ms, 48);
      }}
      nodeLabel={() => ""}
      linkLabel={() => ""}
      nodeCanvasObject={(n, ctx) => drawNode(ctx, n, colors, n.id === selectedId, n.id === ringId)}
      nodePointerAreaPaint={(n, color, ctx, k) => {
        // At least a 24 px target on screen, whatever the zoom.
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, Math.max(n.r, 12 / k), 0, 2 * Math.PI);
        ctx.fill();
      }}
      linkCanvasObjectMode={() => "replace"}
      linkCanvasObject={(l, ctx, k) => drawLink(ctx, l, k, colors, selectedId)}
      onRenderFramePost={(ctx, k) =>
        drawLabels(
          ctx,
          k,
          data.nodes,
          labelled,
          selectedId,
          fg.current,
          width,
          height,
          font.current,
          colors
        )
      }
      onNodeClick={(n) => {
        const now = Date.now();
        const twice = last.current?.id === n.id && now - last.current.at < DOUBLE_CLICK_MS;
        last.current = { id: n.id, at: now };
        if (twice) props.onEnter(n.id);
        else props.onSelect(n.id === selectedId ? null : n.id);
      }}
      onBackgroundClick={() => props.onSelect(null)}
      // A node dropped by hand stays where it was put.
      onNodeDragEnd={(n) => {
        n.fx = n.x;
        n.fy = n.y;
      }}
    />
  );
}

/** Entities are solid, episodes hollow, decisions diamonds; every outline is ivory. */
export function drawNode(
  ctx: CanvasRenderingContext2D,
  n: SkyNode,
  colors: SkyProps["colors"],
  selected: boolean,
  ring: boolean
) {
  const x = n.x ?? 0;
  const y = n.y ?? 0;
  const r = n.r;
  ctx.strokeStyle = colors.ivory;
  const circle = (radius: number) => {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
  };
  if (selected) {
    ctx.lineWidth = 1.5;
    circle(r + 7);
    ctx.stroke();
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    circle(r + 13);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (ring) {
    ctx.lineWidth = 2;
    circle(r + 5);
    ctx.stroke();
  }
  if (n.kind === "decision") {
    const d = r * 1.06; // the 1.5 r square of the legend, turned 45°
    ctx.beginPath();
    ctx.moveTo(x, y - d);
    ctx.lineTo(x + d, y);
    ctx.lineTo(x, y + d);
    ctx.lineTo(x - d, y);
    ctx.closePath();
    ctx.fillStyle = colors.ivory;
    ctx.lineWidth = 1.5;
  } else {
    circle(r);
    ctx.fillStyle = n.kind === "episode" ? colors.electric : colors.ivory;
    ctx.lineWidth = n.kind === "episode" ? 2 : 1.5;
  }
  ctx.fill();
  ctx.stroke();
}

/** Solid stated, dashed inferred, dotted mentions, conflicts doubled; widths in screen px. */
export function drawLink(
  ctx: CanvasRenderingContext2D,
  l: SkyLink,
  k: number,
  colors: SkyProps["colors"],
  selectedId: string | null
) {
  const a = l.source;
  const b = l.target;
  if (typeof a !== "object" || typeof b !== "object" || a.x === undefined || b.x === undefined)
    return;
  const e = l.edge;
  const conflict = e.relation === "conflicts_with";
  const mention = isMention(e);
  const touches = selectedId !== null && (a.id === selectedId || b.id === selectedId);
  const dash = mention ? [3, 4] : isInferred(e) ? [6, 4] : [];
  const line = (width: number, color: string) => {
    ctx.beginPath();
    ctx.moveTo(a.x!, a.y!);
    ctx.lineTo(b.x!, b.y!);
    ctx.strokeStyle = color;
    ctx.lineWidth = width / k;
    ctx.setLineDash(dash.map((d) => d / k));
    ctx.stroke();
  };
  ctx.globalAlpha = 0.9;
  line(conflict ? 5 : touches ? 3.5 : 2, colors.ivory);
  ctx.globalAlpha = 1;
  if (conflict) line(2, colors.electric);
  ctx.setLineDash([]);
}

/** Labels of the biggest nodes, 12 px on screen, where they cover no other label or node. */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  k: number,
  nodes: SkyNode[],
  labelled: ReadonlySet<string>,
  selectedId: string | null,
  g: ForceGraphMethods<SkyNode, SkyLink> | undefined,
  width: number,
  height: number,
  font: string,
  colors: SkyProps["colors"]
) {
  if (!g) return;
  const size = LABEL_PX / k;
  ctx.font = `${size}px ${font}`;
  const tl = g.screen2GraphCoords(0, 0);
  const br = g.screen2GraphCoords(width, height);
  // A selected node's rings count as the node, so its label goes outside them.
  const reach = (n: SkyNode) => (n.id === selectedId ? n.r + 13 : n.r);
  const discs = nodes.flatMap((n) =>
    n.x === undefined || n.y === undefined ? [] : [{ id: n.id, x: n.x, y: n.y, r: reach(n) }]
  );
  // Nodes come biggest first; one smaller than 4 px on screen gets no label until zoomed in.
  const items = nodes.flatMap((n) =>
    labelled.has(n.id) && n.x !== undefined && n.y !== undefined && n.r * k >= 4
      ? [{ id: n.id, x: n.x, y: n.y, r: reach(n), w: ctx.measureText(n.text).width }]
      : []
  );
  const placed = placeLabels(items, discs, size, { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y });
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineWidth = size * 0.3;
  // A halo in the sky's colour, so a line that passes under a label never cuts through it.
  ctx.strokeStyle = colors.electric;
  ctx.fillStyle = colors.ivory;
  for (const n of nodes) {
    const p = placed.get(n.id);
    if (!p) continue;
    ctx.strokeText(n.text, p.x, p.y);
    ctx.fillText(n.text, p.x, p.y);
  }
}
