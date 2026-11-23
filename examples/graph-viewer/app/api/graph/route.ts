// Route handler: returns a Mnemosyne GraphResponse as JSON — the live
// workspace graph when MNEMO_URL and MNEMO_KEY are set, the bundled sample
// otherwise (see lib/load-graph.ts).
import { NextResponse } from "next/server";
import type { GraphResponse } from "@mnemo-ai/core/graph";
import { loadGraph } from "../../../lib/load-graph";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<GraphResponse>> {
  const { graph } = await loadGraph();
  return NextResponse.json(graph);
}
