import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discardHarnessQueue, readHarnessLifecycleState } from "../host-runtime.js";
import { enqueueVisibleMessage, readPendingEvents } from "../outbox.js";

const roots: string[] = [];

function temporaryHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mnemo-discard-test-")));
  roots.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function enqueue(home: string, host: "opencode" | "codex" | "claude-code", id: string) {
  await enqueueVisibleMessage(
    {
      host,
      hostSessionId: `session-${host}`,
      clientInstanceId: "client-1",
      sourceGeneration: 0,
      hostMessageId: id,
      role: "user",
      content: `turn ${id}`,
      occurredAt: "2000-01-01T00:00:00.000Z",
    },
    { home }
  );
}

describe("discardHarnessQueue", () => {
  it("discards only the named host's queue on uninstall", async () => {
    const home = temporaryHome();
    await enqueue(home, "codex", "c1");
    await enqueue(home, "codex", "c2");
    await enqueue(home, "opencode", "o1");
    await enqueue(home, "claude-code", "k1");

    const codexState = await readHarnessLifecycleState({
      host: "codex",
      home,
      serverUrl: "http://127.0.0.1:9",
      apiKey: "mk_test",
      workspaceId: "ws",
      transport: {
        post: async () => {
          throw new Error("offline");
        },
      },
    });
    expect(codexState.queued).toBe(2);

    expect(await discardHarnessQueue({ home, host: "codex", reason: "uninstall codex" })).toEqual({
      discarded: 2,
    });
    const left = (await readPendingEvents({ home })).map((entry) => entry.event.host).sort();
    expect(left).toEqual(["claude-code", "opencode"]);
  });

  it("still discards every host's queue when no host is named", async () => {
    const home = temporaryHome();
    await enqueue(home, "codex", "c1");
    await enqueue(home, "opencode", "o1");
    expect(await discardHarnessQueue({ home, reason: "operator discard" })).toEqual({
      discarded: 2,
    });
    expect(await readPendingEvents({ home })).toHaveLength(0);
  });
});
