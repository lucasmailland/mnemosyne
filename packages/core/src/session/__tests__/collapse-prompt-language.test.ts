/**
 * The collapse prompt must keep extracted knowledge in the conversation's
 * language. Without the instruction, Haiku wrote English facts from Spanish
 * sessions, and the lexical recall arm (Postgres FTS) never matched a Spanish
 * query against them, so hybrid recall degraded to pure semantic.
 */
import { describe, it, expect } from "vitest";
import type { SessionTurn } from "@mnemo-ai/types";
import { buildCollapsePrompt } from "../collapse.js";

const FIXED_DATE = new Date("2026-10-13T00:00:00Z");

function turn(i: number, role: SessionTurn["role"], content: string): SessionTurn {
  return {
    id: `t${i}`,
    workspaceId: "ws",
    sessionId: "s1",
    turnIndex: i,
    role,
    content,
    createdAt: FIXED_DATE,
  } as SessionTurn;
}

describe("buildCollapsePrompt language", () => {
  const prompt = buildCollapsePrompt([
    turn(0, "user", "¿por qué el collapse de sesiones no producía episodios?"),
    turn(1, "assistant", "Porque Haiku devolvía 403."),
  ]);

  it("asks for extracted text in the conversation's language", () => {
    expect(prompt).toMatch(/same language as the\s+conversation/i);
    expect(prompt).toMatch(/do not\s+translate/i);
  });

  it("keeps the machine-readable fields stable", () => {
    // Enum values are validated against fixed lists, and topic keys dedupe
    // against keys written before this instruction existed.
    expect(prompt).toMatch(/topicKey.*English/i);
    expect(prompt).toMatch(/outcome.*kind.*exactly as listed/i);
  });
});
