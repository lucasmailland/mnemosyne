import { expect, it } from "vitest";
import type { SessionTurn } from "@mnemo-ai/types";
import { buildCollapsePrompt, conversationalTurnsForRecurrence } from "../collapse.js";
it("labels all bytes for extraction but separates injected content from the conversational RecMem signal", () => {
  const origins = [
    "human",
    "agent_message",
    "task_notification",
    "pasted_content",
    "unknown",
    "assistant",
  ] as const;
  const turns = origins.map((turnOrigin, turnIndex) => ({
    id: `turn-${turnIndex}`,
    workspaceId: "ws",
    sessionId: "session",
    turnIndex,
    role: turnOrigin === "assistant" ? "assistant" : "user",
    content: `visible ${turnOrigin}`,
    turnOrigin,
    turnOriginEvidence: `fixture:${turnOrigin}`,
    createdAt: new Date(0),
  })) as SessionTurn[];
  expect(conversationalTurnsForRecurrence(turns).map((t) => t.turnOrigin)).toEqual([
    "human",
    "unknown",
    "assistant",
  ]);
  const prompt = buildCollapsePrompt(turns);
  for (const turn of turns) {
    expect(prompt).toContain(turn.content);
    expect(prompt).toContain(`origin=${turn.turnOrigin}`);
  }
  expect(prompt).toContain("not the human user speaking");
});
