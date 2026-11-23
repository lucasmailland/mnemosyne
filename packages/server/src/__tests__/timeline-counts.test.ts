/**
 * GET /timeline/counts counts the decision events GET /timeline lists since an
 * instant — the same numbers, without paging — within the caller's ceiling.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import bcrypt from "bcrypt";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountTimeline } from "../routes/timeline.js";
import { buildMountHarness } from "./_mountHarness.js";

const KEY = "mns_live_timelinecounts000000001";
const WS = "00000000-0000-0000-0000-0000000000d5";

afterEach(() => vi.useRealTimers());

describe("GET /timeline/counts", () => {
  it("matches GET /timeline's decision events and leaves out hidden decisions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const storage = new InMemoryStorageAdapter();
    const decision = (title: string, sensitivity = "internal") =>
      storage.createDecision({
        workspaceId: WS,
        kind: "architecture",
        title,
        body: `${title} body`,
        sensitivity,
      } as never);
    vi.setSystemTime(new Date("2026-02-28T10:00:00.000Z"));
    const yesterday = await decision("yesterday");
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    const a = await decision("a");
    const b = await decision("b");
    const c = await decision("c");
    const secret = await decision("secret", "restricted");
    const secretNext = await decision("secret next", "restricted");
    vi.setSystemTime(new Date("2026-03-01T11:00:00.000Z"));
    await storage.supersedeDecision({ id: a.id, workspaceId: WS, supersededById: b.id } as never);
    await storage.supersedeDecision({
      id: yesterday.id,
      workspaceId: WS,
      supersededById: b.id,
    } as never);
    await storage.supersedeDecision({
      id: secret.id,
      workspaceId: WS,
      supersededById: secretNext.id,
    } as never);
    await storage.archiveDecision(c.id, WS);

    const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
    const apiKeys = {
      listActive: async () => [
        { id: "k1", keyHash, workspaceId: WS, scopes: ["memory:read"], plan: "free" },
      ],
      touch: async () => {},
    } as unknown as ApiKeyLookup;
    const app = buildMountHarness({ apiKeys, storage } as unknown as ServerDeps, [mountTimeline]);
    const get = async (path: string) => {
      const res = await app.request(path, { headers: { authorization: `Bearer ${KEY}` } });
      expect(res.status).toBe(200);
      return res.json() as never;
    };

    const since = "2026-03-01T00:00:00.000Z";
    const counts = (await get(`/timeline/counts?since=${since}`)) as {
      since: string;
      counts: Record<string, number>;
    };
    expect(counts).toEqual({
      since,
      counts: { decision_created: 3, decision_superseded: 2, decision_withdrawn: 1 },
    });
    const { events } = (await get(`/timeline?since=${since}&limit=500`)) as {
      events: Array<{ kind: string }>;
    };
    for (const kind of Object.keys(counts.counts)) {
      expect(events.filter((e) => e.kind === kind)).toHaveLength(counts.counts[kind]!);
    }
  });
});
