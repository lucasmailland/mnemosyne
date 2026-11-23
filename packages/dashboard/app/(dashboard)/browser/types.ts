import { shortId } from "@/lib/short-id";

/** One row of GET /facts (the list). */
export interface Fact {
  id: string;
  kind: string;
  subject: string;
  statement: string;
  confidence: number;
  pinned: boolean;
  relevance: number;
  hitCount: number;
  lastRecalledAt: string | null;
  status: string;
  sensitivity?: string;
  scope: string;
  scopeRef: string | null;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
  agentId?: string | null;
  attributedTo?: string | null;
  actorId?: string | null;
}

/** GET /facts/{id}?includeClosed=true&provenance=true. null and absent mean the same. */
export interface FactDetail {
  id: string;
  content: string;
  attribution?: Record<string, unknown> | null;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  kind?: string;
  confidence?: number;
  sensitivity?: string;
  status?: string;
  episodeId?: string | null;
  sessionId?: string | null;
  /** How many times recall served it; also on a closed fact, which the list may not hold. */
  hitCount?: number | null;
  supersededById?: string | null;
  supersededAt?: string | null;
  supersedesIds?: string[] | null;
  pinned?: boolean;
  /** The revision PATCH /facts/:id `expectedRevision` compares with. */
  revisionCount?: number;
  agentId?: string | null;
  attributedTo?: string | null;
  actorId?: string | null;
}

export function buildQuery(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * Written by = agentId, else attributedTo, else the short actor id (`id` true: print it in mono,
 * like every short id). Looks at the top level and at `attribution`.
 */
export function writtenBy(src: {
  agentId?: unknown;
  attributedTo?: unknown;
  actorId?: unknown;
  attribution?: Record<string, unknown> | null;
}): { text: string; id: boolean } | null {
  const pick = (k: "agentId" | "attributedTo" | "actorId") =>
    str(src[k]) ?? str(src.attribution?.[k]);
  const name = pick("agentId") ?? pick("attributedTo");
  if (name) return { text: name, id: false };
  const actor = pick("actorId");
  return actor ? { text: shortId(actor), id: true } : null;
}
