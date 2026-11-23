// Server component. Loads the GraphResponse (the live workspace graph when
// MNEMO_URL and MNEMO_KEY are set, the bundled sample otherwise) and hands it
// to the client renderer. The fetch runs server-side, so the key never reaches
// the browser.
import { loadGraph } from "../lib/load-graph";
import { MemoryGraph } from "./MemoryGraph";

export const dynamic = "force-dynamic";

const wrap: React.CSSProperties = {
  maxWidth: 1280,
  margin: "0 auto",
  padding: "40px 24px 24px",
};

const accent = "linear-gradient(90deg, #8a98ff 0%, #22d3ee 50%, #c084fc 100%)";

export default async function Page() {
  const { graph, live } = await loadGraph();

  return (
    <main style={wrap}>
      <header style={{ marginBottom: 20 }}>
        <div
          style={{
            display: "inline-block",
            fontSize: 12,
            letterSpacing: 2,
            textTransform: "uppercase",
            color: "#9fb0ff",
            opacity: 0.8,
          }}
        >
          Mnemosyne · Memory Graph
        </div>
        <h1
          style={{
            margin: "8px 0 6px",
            fontSize: 34,
            fontWeight: 700,
            backgroundImage: accent,
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
            width: "fit-content",
          }}
        >
          A constellation of memories
        </h1>
        <p style={{ margin: 0, maxWidth: 720, color: "#aab6dd", lineHeight: 1.5 }}>
          Entities, episodes and decisions linked by relations with confidence and provenance —
          rendered live from a <code style={{ color: "#c9d4ff" }}>GraphResponse</code> produced by{" "}
          <code style={{ color: "#c9d4ff" }}>@mnemo-ai/core</code>.{" "}
          {live ? (
            <span style={{ color: "#7ef0c0" }}>Connected to your workspace.</span>
          ) : (
            <span style={{ color: "#f0d27e" }}>
              Showing the bundled sample (MNEMO_URL and MNEMO_KEY are not set).
            </span>
          )}
        </p>
        <div style={{ display: "flex", gap: 18, marginTop: 12, fontSize: 13, color: "#8ea0cf" }}>
          <span>{graph.meta.entityCount} entities</span>
          <span>{graph.meta.episodeCount} episodes</span>
          <span>{graph.meta.decisionCount} decisions</span>
          <span>{graph.meta.relationCount} relations</span>
        </div>
      </header>

      <MemoryGraph graph={graph} />
    </main>
  );
}
