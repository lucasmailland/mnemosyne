import { apiGet } from "@/lib/server-api";

/** Reads shared by the rooms that open one memory: the catalog plate and the columbarium niche. */

export const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const enc = encodeURIComponent;

/** The statement of a fact, closed ones included; null when it cannot be read (missing, above the ceiling). */
export async function factStatement(id: string): Promise<string | null> {
  // No .catch: apiGet answers null on failure, and only rejects to redirect to the login.
  const f = await apiGet<{ content?: unknown }>(`/facts/${enc(id)}?includeClosed=true`);
  return isStr(f?.content) ? f.content : null;
}

/** GET /episodes/{id} answers { episode, linkedFacts }: the episode's fields (unvalidated), or null. */
export function episodeOf(r: { episode?: unknown } | null): Record<string, unknown> | null {
  const e = r?.episode;
  return e && typeof e === "object" ? (e as Record<string, unknown>) : null;
}

export async function fetchEpisode(id: string): Promise<Record<string, unknown> | null> {
  return episodeOf(await apiGet<{ episode?: unknown }>(`/episodes/${enc(id)}`));
}
