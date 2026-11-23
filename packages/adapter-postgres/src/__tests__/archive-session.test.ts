// packages/adapter-postgres/src/__tests__/archive-session.test.ts
import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";

const WS = "11111111-1111-1111-1111-111111111111";

describe("archiveSession writes status='archived' (WP6.6)", () => {
  it("sets status to 'archived' (not 'collapsed') and does NOT touch context_snapshot", async () => {
    const storage = new InMemoryStorageAdapter();
    const s = await storage.createSession({ workspaceId: WS });
    await storage.appendTurn(s.id, { workspaceId: WS, sessionId: s.id, turnIndex: 0, role: "user", content: "x" });

    await storage.archiveSession!(s.id, WS);

    const after = await storage.getSession(s.id, WS);
    expect(after?.status).toBe("archived");
    // Discard must NOT have produced a collapse summary.
    expect((after as { contextSnapshot?: unknown }).contextSnapshot ?? null).toBeNull();
  });
});

import { SessionBuffer } from "@mnemo-ai/core";

describe("discard does NOT extract knowledge (WP6.6)", () => {
  it("archiveSession leaves zero facts derivable from the session (no collapse ran)", async () => {
    const storage = new InMemoryStorageAdapter();
    const WS2 = "22222222-2222-2222-2222-222222222222";
    const s = await storage.createSession({ workspaceId: WS2 });
    await storage.appendTurn(s.id, { workspaceId: WS2, sessionId: s.id, turnIndex: 0, role: "user", content: "remember: prod db is on port 5432" });

    const buf = new SessionBuffer(null, storage, {
      replaceSessionScratch: async () => true,
      getSessionScratch: async () => null,
    });
    await storage.archiveSession!(s.id, WS2);
    await buf.clear(WS2, s.id);

    // No collapse → no facts created for this session.
    const facts = await storage.queryFacts({ workspaceId: WS2, sessionId: s.id });
    expect(facts.items.length).toBe(0);
    const after = await storage.getSession(s.id, WS2);
    expect(after?.status).toBe("archived");
  });
});
