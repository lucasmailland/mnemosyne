import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCaptureFixture, WS, OTHER_WS } from "./capture-fixture.js";
import { shouldCollapseUnderPolicy } from "../../session-sweep.js";
let fixture: Awaited<ReturnType<typeof createCaptureFixture>>;
beforeAll(async () => {
  fixture = await createCaptureFixture();
}, 120000);
afterAll(async () => {
  await fixture?.close();
});

describe("durable legacy continuity under RLS", () => {
  it("segments 60 occurrences at both limits, survives concurrent successor start and lost ACK", async () => {
    const binding = {
      sourceSessionId: "long-conversation",
      sourceClientInstanceId: "client",
      sourceGeneration: 0,
    };
    let session = await (await fixture.post("/session/start", binding)).json();
    const ids: string[] = [];
    const chain: string[] = [session.id];
    for (let i = 0; i < 60; i++) {
      const body = {
        role: i % 2 ? "assistant" : "user",
        content: i < 2 ? "yes" : "x".repeat(4000),
        sourceMessageId: `occurrence-${i}`,
        sourceGeneration: session.sourceGeneration,
      };
      const response = await fixture.post(`/session/${session.id}/turn`, body);
      expect(response.status).toBe(204);
      ids.push(body.sourceMessageId);
      const current = (await fixture.storage.getSession(session.id, WS))!;
      const reason = shouldCollapseUnderPolicy(
        current,
        chain.length === 1
          ? { maxTokens: 100000, maxTurns: 50 }
          : { maxTokens: 8192, maxTurns: 100 }
      );
      if (reason && i < 59) {
        await fixture.storage.closeSession(session.id, WS);
        const late = await fixture.post(`/session/${session.id}/turn`, {
          ...body,
          sourceMessageId: `new-${i}`,
        });
        expect(late.status).toBe(409);
        expect((await late.json()).error.details.cause).toBe("SESSION_TERMINAL");
        const successor = {
          ...binding,
          sourceGeneration: session.sourceGeneration + 1,
          predecessorSessionId: session.id,
        };
        const [a, b] = await Promise.all([
          fixture.post("/session/start", successor),
          fixture.post("/session/start", successor),
        ]);
        expect(a.status).toBe(201);
        expect(b.status).toBe(201);
        const left = await a.json(),
          right = await b.json();
        expect(left.id).toBe(right.id);
        session = left;
        chain.push(session.id);
        // The final ACK of the predecessor was lost. Replay in its successor
        // must find the original occurrence rather than increment counters.
        expect(
          (
            await fixture.post(`/session/${session.id}/turn`, {
              ...body,
              sourceGeneration: session.sourceGeneration,
            })
          ).status
        ).toBe(204);
      }
    }
    const rows = (await Promise.all(chain.map((id) => fixture.storage.listTurns(id, WS)))).flat();
    expect(rows.map((t) => t.sourceMessageId)).toEqual(ids);
    expect(new Set(chain).size).toBe(chain.length);
    for (const id of chain) {
      const state = (await fixture.storage.getSession(id, WS))!;
      expect(state.turnCount).toBe(rows.filter((t) => t.sessionId === id).length);
      expect(state.tokenCount).toBe(
        rows.filter((t) => t.sessionId === id).reduce((n, t) => n + (t.tokenCount ?? 0), 0)
      );
    }
    expect(
      (
        await fixture.post(
          "/session/start",
          { ...binding, sourceGeneration: 1, predecessorSessionId: chain[0] },
          OTHER_WS
        )
      ).status
    ).toBe(404);
  });
});
