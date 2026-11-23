/**
 * §35 monotonic per-workspace event ids (MEMORY_IMPROVEMENT.md:4713-4716).
 * Format: evt_{wsShort}_{tsMs}_{seq}  e.g. evt_ws12_1717500000000_0042
 */
function wsShort(workspaceId: string): string {
  return workspaceId.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "ws";
}

export class EventIdGenerator {
  private seqByWs = new Map<string, { ms: number; seq: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  next(workspaceId: string): string {
    const ms = this.now();
    const st = this.seqByWs.get(workspaceId);
    const seq = st && st.ms === ms ? st.seq + 1 : 0;
    this.seqByWs.set(workspaceId, { ms, seq });
    return `evt_${wsShort(workspaceId)}_${ms}_${String(seq).padStart(4, "0")}`;
  }
}

export interface ParsedEventId {
  wsShort: string;
  ms: number;
  seq: number;
}

export function parseEventId(id: string): ParsedEventId {
  const m = /^evt_([a-z0-9]+)_(\d+)_(\d+)$/i.exec(id);
  if (!m) throw new Error(`invalid event id: ${id}`);
  return { wsShort: m[1]!, ms: Number(m[2]), seq: Number(m[3]) };
}

/** The workspace's replay list: every event, all channels (see server replayBuffer.ts). */
export function wsBufferKey(workspaceId: string): string {
  return `mnemo:${workspaceId}:ws_buffer`;
}
