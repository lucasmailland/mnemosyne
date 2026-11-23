/**
 * p45 Slice B — SessionRepository.createSession() mapping.
 *
 * Regression guard for the credential-in-user_id bug: `createSession` used to
 * write `input.actorId` (a namespaced credential ActorRef, e.g. "key:<id>")
 * straight into `mnemo_session.user_id`, a column that MUST hold a real
 * `mnemo_user.id` or null. `user_id` now comes exclusively from the new
 * `input.userId` field; `actorId`/`actorType` are provenance and are folded
 * into `metadata` only.
 */
import { describe, expect, it, vi } from "vitest";

import { SessionRepository } from "../../repositories/SessionRepository.js";

const WS = "11111111-1111-4111-8111-111111111111";

function sqlAsText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks
    .flatMap((chunk) => {
      const value = (chunk as { value?: unknown[] })?.value;
      return Array.isArray(value)
        ? value.filter((part): part is string => typeof part === "string")
        : [sqlAsText(chunk)];
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeRepository() {
  const insertedValues: Array<Record<string, unknown>> = [];
  const insertedRow = {
    id: "sess-1",
    workspace_id: WS,
    agent_id: null,
    status: "active",
    started_at: new Date("2026-08-01T00:00:00.000Z"),
    collapsed_at: null,
    metadata: {},
    label: null,
  };

  const insertChain = {
    values: vi.fn((v: Record<string, unknown>) => {
      insertedValues.push(v);
      return {
        returning: vi.fn(async () => [insertedRow]),
      };
    }),
  };

  const tx = {
    execute: vi.fn(async (query: unknown) => {
      const text = sqlAsText(query);
      if (text.includes("pg_has_role")) return [{ m: true }];
      return [];
    }),
    insert: vi.fn(() => insertChain),
    transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };

  const db = {
    transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };

  return {
    repository: new SessionRepository(db as never, db as never),
    getInsertedValues: () => insertedValues,
  };
}

describe("SessionRepository.createSession — user_id mapping (p45 Slice B)", () => {
  it("writes the real userId into user_id, never the credential actorId", async () => {
    const { repository, getInsertedValues } = makeRepository();

    await repository.createSession({
      workspaceId: WS,
      actorId: "key:abcd1234",
      userId: "user-real-42",
      actorType: "user",
    });

    const [values] = getInsertedValues();
    expect(values?.userId).toBe("user-real-42");
    expect(values?.userId).not.toBe("key:abcd1234");
    expect((values?.metadata as Record<string, unknown>)?.actorId).toBe("key:abcd1234");
    expect((values?.metadata as Record<string, unknown>)?.actorType).toBe("user");
  });

  it("no key-ref ever lands in user_id — null when only actorId is supplied", async () => {
    const { repository, getInsertedValues } = makeRepository();

    await repository.createSession({
      workspaceId: WS,
      actorId: "key:apikeyonly",
    });

    const [values] = getInsertedValues();
    expect(values?.userId).toBeNull();
    expect((values?.metadata as Record<string, unknown>)?.actorId).toBe("key:apikeyonly");
  });

  it("caller-supplied metadata cannot overwrite real actor provenance", async () => {
    const { repository, getInsertedValues } = makeRepository();

    await repository.createSession({
      workspaceId: WS,
      actorId: "key:real",
      userId: "user-1",
      actorType: "agent",
      metadata: { actorId: "spoofed", actorType: "spoofed-type", note: "kept" },
    });

    const [values] = getInsertedValues();
    const metadata = values?.metadata as Record<string, unknown>;
    expect(metadata.actorId).toBe("key:real");
    expect(metadata.actorType).toBe("agent");
    expect(metadata.note).toBe("kept");
  });
});
