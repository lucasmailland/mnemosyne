import { describe, expect, it } from "vitest";

import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

const WS_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

describe("InMemoryStorageAdapter appendTurn", () => {
  it.each([
    ["missing", crypto.randomUUID(), WS_A],
    ["cross-workspace", null, WS_B],
  ])("rejects a %s parent without inserting a turn", async (_case, suppliedId, workspaceId) => {
    const storage = new InMemoryStorageAdapter();
    const session = await storage.createSession({ workspaceId: WS_A });
    const sessionId = suppliedId ?? session.id;

    await expect(storage.appendTurn(sessionId, {
      workspaceId,
      sessionId,
      turnIndex: 0,
      role: "user",
      content: "invalid parent",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(storage.listTurns(sessionId, workspaceId)).resolves.toEqual([]);
  });
});
