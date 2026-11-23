/**
 * APP-052 (audit 2026-11-22): a recall bumps hit_count/last_recalled_at, the
 * fact's BEFORE UPDATE trigger moves updated_at to the same instant, and the
 * timeline turned that into an "updated" event — every recalled fact looked
 * edited. An update stamped at the very instant of the last recall is the
 * recall, not an edit.
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { MnemoFact } from "@mnemo-ai/types";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountTimeline } from "../routes/timeline.js";
import { buildMountHarness } from "./_mountHarness.js";

const KEY = "mns_live_timelinerecallbump00001";
const WS = "00000000-0000-0000-0000-0000000000d6";

describe("GET /timeline — a recall is not an update", () => {
  it("lists an edit as updated and leaves a recall bump out", async () => {
    const storage = new InMemoryStorageAdapter();
    const facts = (storage as unknown as { state: { facts: Map<string, MnemoFact> } }).state.facts;
    const make = (statement: string) =>
      storage.createFact({
        workspaceId: WS,
        scope: "global",
        statement,
        subject: "s",
        kind: "trait",
      });
    const recalled = await make("recalled only");
    const edited = await make("edited");
    const created = new Date("2026-03-01T09:00:00.000Z");
    const recallAt = new Date("2026-03-01T10:00:00.000Z");
    const editAt = new Date("2026-03-01T11:00:00.000Z");
    Object.assign(facts.get(recalled.id)!, {
      createdAt: created,
      updatedAt: recallAt,
      lastRecalledAt: recallAt,
    });
    Object.assign(facts.get(edited.id)!, { createdAt: created, updatedAt: editAt });

    const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
    const apiKeys = {
      listActive: async () => [
        { id: "k1", keyHash, workspaceId: WS, scopes: ["memory:read"], plan: "free" },
      ],
      touch: async () => {},
    } as unknown as ApiKeyLookup;
    const app = buildMountHarness({ apiKeys, storage } as unknown as ServerDeps, [mountTimeline]);
    const res = await app.request("/timeline?since=2026-03-01T00:00:00.000Z&limit=500", {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.status).toBe(200);
    const { events } = (await res.json()) as { events: Array<{ kind: string; factId?: string }> };
    const updated = events.filter((e) => e.kind === "updated").map((e) => e.factId);
    expect(updated).toContain(edited.id);
    expect(updated).not.toContain(recalled.id);
  });

  it("APP-052 residual: a pinned or closed fact recalled since still shows its state", async () => {
    const storage = new InMemoryStorageAdapter();
    const facts = (storage as unknown as { state: { facts: Map<string, MnemoFact> } }).state.facts;
    const make = (statement: string) =>
      storage.createFact({
        workspaceId: WS,
        scope: "global",
        statement,
        subject: "s",
        kind: "trait",
      });
    const pinned = await make("pinned, then recalled");
    const closed = await make("closed, then recalled with includeArchived");
    const created = new Date("2026-03-01T09:00:00.000Z");
    const recallAt = new Date("2026-03-01T10:00:00.000Z");
    Object.assign(facts.get(pinned.id)!, {
      createdAt: created,
      updatedAt: recallAt,
      lastRecalledAt: recallAt,
      pinned: true,
    });
    Object.assign(facts.get(closed.id)!, {
      createdAt: created,
      updatedAt: recallAt,
      lastRecalledAt: recallAt,
      validTo: recallAt,
      status: "forgotten",
    });

    const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
    const apiKeys = {
      listActive: async () => [
        { id: "k1", keyHash, workspaceId: WS, scopes: ["memory:read"], plan: "free" },
      ],
      touch: async () => {},
    } as unknown as ApiKeyLookup;
    const app = buildMountHarness({ apiKeys, storage } as unknown as ServerDeps, [mountTimeline]);
    const res = await app.request("/timeline?since=2026-03-01T00:00:00.000Z&limit=500", {
      headers: { authorization: `Bearer ${KEY}` },
    });
    const { events } = (await res.json()) as { events: Array<{ kind: string; factId?: string }> };
    expect(events).toContainEqual(expect.objectContaining({ kind: "pinned", factId: pinned.id }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "closed", factId: closed.id }));
  });
});
