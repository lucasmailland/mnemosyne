import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCaptureFixture, WS } from "./capture-fixture.js";
let fixture: Awaited<ReturnType<typeof createCaptureFixture>>;
beforeAll(async () => {
  fixture = await createCaptureFixture();
}, 120000);
afterAll(async () => {
  await fixture?.close();
});

describe("capture origin under a NOSUPERUSER NOBYPASSRLS role", () => {
  it("keeps visible content and typed origin across HTTP, buffer and PG", async () => {
    const session = await (await fixture.post("/session/start", {})).json();
    const messages = [
      ["human", "a human prompt"],
      ["agent_message", "<agent-message>agent result</agent-message>"],
      ["task_notification", "<task-notification>complete</task-notification>"],
      ["pasted_content", "<pasted_content>quoted</pasted_content>"],
      ["unknown", "human words <agent-message>mixed</agent-message>"],
      ["unknown", "&lt;agent-message&gt;escaped&lt;/agent-message&gt;"],
      ["assistant", "visible reply"],
    ];
    for (const [i, [turnOrigin, content]] of messages.entries()) {
      const result = await fixture.post(`/session/${session.id}/turn`, {
        role: turnOrigin === "assistant" ? "assistant" : "user",
        content,
        turnOrigin,
        turnOriginEvidence: `fixture:${turnOrigin}`,
        sourceMessageId: `origin-${i}`,
      });
      expect(result.status).toBe(204);
    }
    const rows = await fixture.buffer.getDurableTurns(WS, session.id);
    expect(rows.map((t) => [t.turnOrigin, t.content])).toEqual(messages);
    expect(rows.map((t) => t.turnOriginEvidence)).toEqual(
      messages.map(([origin]) => `fixture:${origin}`)
    );
    expect((await fixture.storage.getSession(session.id, WS))?.trafficOrigin).toBe("organic");
  });
  it("rejects synthetic traffic assertions from an ordinary credential without opening sessions", async () => {
    const before = (await fixture.storage.listSessions(WS)).length;
    for (let i = 0; i < 2; i++)
      expect(
        (await fixture.post("/session/start", { trafficOrigin: "installer_verify" })).status
      ).toBe(403);
    expect((await fixture.storage.listSessions(WS)).length).toBe(before);
  });
});
