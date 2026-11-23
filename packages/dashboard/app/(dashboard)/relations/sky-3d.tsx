"use client";

import { useEffect, useMemo, useRef } from "react";
import ForceGraph3D, { type ForceGraphMethods } from "react-force-graph-3d";
import { MeshLambertMaterial, Mesh, OctahedronGeometry, SphereGeometry } from "three";

import {
  CAMERA_MS,
  DOUBLE_CLICK_MS,
  SETTLE_MS,
  SETTLE_TICKS,
  isInferred,
  isMention,
  radius,
  type GraphEdge,
  type GraphNode,
  type SkyProps,
} from "./model";

/**
 * The constellation in 3D (react-force-graph-3d, WebGL), downloaded only when the reader turns it
 * on. Same ivory on the electric scene; the shapes are approximate: entities are spheres, episodes
 * wire spheres (hollow), decisions octahedrons (diamonds). Inferred and mention edges are fainter
 * instead of dashed, conflicts thicker. A node's name shows on hover.
 */

type SkyNode = GraphNode & {
  x?: number;
  y?: number;
  z?: number;
  fx?: number;
  fy?: number;
  fz?: number;
};
type SkyLink = { id: string; source: string | SkyNode; target: string | SkyNode; edge: GraphEdge };

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export default function Sky3D(props: SkyProps) {
  const { nodes, edges, selectedId, ringId, width, height, paused, reduced, colors } = props;
  const fg = useRef<ForceGraphMethods<SkyNode, SkyLink> | undefined>(undefined);
  const data = useMemo(
    () => ({
      nodes: nodes.map((n): SkyNode => ({ ...n })),
      links: edges.map((e): SkyLink => ({ id: e.id, source: e.source, target: e.target, edge: e })),
    }),
    [nodes, edges]
  );

  const ms = reduced ? 0 : CAMERA_MS;
  const fitPending = useRef(true);
  // The 3D engine runs for its full cooldown (15 s): frame the graph once it has spread out.
  useEffect(() => {
    fitPending.current = true;
    const id = setTimeout(() => fg.current?.zoomToFit(ms, 48), reduced ? 0 : SETTLE_MS);
    return () => clearTimeout(id);
  }, [props.frame, ms, reduced]);
  useEffect(() => {
    props.api.current = {
      zoomBy: (f) => {
        const g = fg.current;
        if (!g) return;
        const p = g.camera().position;
        g.cameraPosition({ x: p.x / f, y: p.y / f, z: p.z / f }, undefined, ms / 2);
      },
      fit: () => fg.current?.zoomToFit(ms, 48),
      reveal: () => {},
    };
  });
  // Only on a resume, never on mount: before its first update the engine has no layout to warm.
  const wasPaused = useRef(paused);
  useEffect(() => {
    if (wasPaused.current && !paused && !reduced) fg.current?.d3ReheatSimulation();
    wasPaused.current = paused;
  }, [paused, reduced]);

  const last = useRef<{ id: string; at: number } | null>(null);
  const alpha = (e: GraphEdge) => (isMention(e) ? 0.35 : isInferred(e) ? 0.55 : 0.85);
  const ivoryA = (a: number) => withAlpha(colors.ivory, a);

  return (
    <ForceGraph3D<SkyNode, SkyLink>
      ref={fg}
      graphData={data}
      width={width}
      height={height}
      backgroundColor="rgba(0,0,0,0)"
      showNavInfo={false}
      warmupTicks={reduced ? SETTLE_TICKS : 0}
      cooldownTicks={paused || reduced ? 0 : Infinity}
      onEngineStop={() => {
        if (!fitPending.current) return;
        fitPending.current = false;
        fg.current?.zoomToFit(ms, 48);
      }}
      nodeLabel={(n) => escapeHtml(n.label)}
      nodeThreeObject={(n) => {
        const r = radius(n) * 0.8;
        const on = n.id === selectedId || n.id === ringId;
        const mesh = new Mesh(
          n.kind === "decision" ? new OctahedronGeometry(r * 1.2) : new SphereGeometry(r, 16, 12),
          new MeshLambertMaterial({
            color: colors.ivory,
            emissive: colors.ivory,
            emissiveIntensity: 0.55,
            wireframe: n.kind === "episode",
          })
        );
        if (on) mesh.scale.setScalar(1.5);
        return mesh;
      }}
      linkColor={(l) =>
        l.edge.relation === "conflicts_with" ? colors.ivory : ivoryA(alpha(l.edge))
      }
      linkWidth={(l) => (l.edge.relation === "conflicts_with" ? 1.5 : 0)}
      linkOpacity={0.9}
      onNodeClick={(n) => {
        const now = Date.now();
        const twice = last.current?.id === n.id && now - last.current.at < DOUBLE_CLICK_MS;
        last.current = { id: n.id, at: now };
        if (twice) props.onEnter(n.id);
        else props.onSelect(n.id === selectedId ? null : n.id);
      }}
      onBackgroundClick={() => props.onSelect(null)}
      onNodeDragEnd={(n) => {
        n.fx = n.x;
        n.fy = n.y;
        n.fz = n.z;
      }}
    />
  );
}

/** #rrggbb plus an alpha, as rgba(); three-forcegraph turns the alpha into the line's opacity. */
function withAlpha(hex: string, a: number) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${a})`;
}
