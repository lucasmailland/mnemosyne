import { isStr } from "@/lib/fetch-memory";

export interface Episode {
  id: string;
  title: string;
  narrative: string;
  occurredAt: string;
  durationMinutes: number | null;
  participants: string[];
  topics: string[];
  linkedFactIds: string[];
  sourceConversationId: string | null;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);

/** Validates an episode row from the API; anything unexpected becomes null so it is skipped, never rendered. */
export function parseEpisode(v: unknown): Episode | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  if (!isStr(e.id) || typeof e.title !== "string") return null;
  if (!isStr(e.occurredAt) || Number.isNaN(new Date(e.occurredAt).getTime())) return null;
  return {
    id: e.id,
    title: e.title,
    narrative: typeof e.narrative === "string" ? e.narrative : "",
    occurredAt: e.occurredAt,
    durationMinutes: typeof e.durationMinutes === "number" ? e.durationMinutes : null,
    participants: strs(e.participants),
    topics: strs(e.topics),
    linkedFactIds: strs(e.linkedFactIds),
    sourceConversationId: isStr(e.sourceConversationId) ? e.sourceConversationId : null,
  };
}
