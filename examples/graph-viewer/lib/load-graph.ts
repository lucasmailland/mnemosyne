// Server-only: loads the GraphResponse the page and the API route serve.
//
// With MNEMO_URL and MNEMO_KEY set it asks a running Mnemosyne server for the
// workspace's graph (`GET /graph`, the same shape `@mnemo-ai/core/graph`
// renders). The key stays on the server: the browser only ever receives the
// graph JSON. With either unset it returns the bundled sample, so the demo
// runs with zero setup.
import type { GraphResponse } from "@mnemo-ai/core/graph";
import { sampleGraph } from "./sample-graph";

export async function loadGraph(): Promise<{ graph: GraphResponse; live: boolean }> {
  const url = process.env.MNEMO_URL;
  const key = process.env.MNEMO_KEY;
  if (!url || !key) return { graph: sampleGraph, live: false };

  const res = await fetch(`${url.replace(/\/+$/, "")}/graph?includeMentions=true`, {
    headers: { authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`GET /graph answered ${res.status}`);
  return { graph: (await res.json()) as GraphResponse, live: true };
}
