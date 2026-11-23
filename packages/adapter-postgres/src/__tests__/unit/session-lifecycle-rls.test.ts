import { describe, expect, it, vi } from "vitest";

import { SessionRepository } from "../../repositories/SessionRepository.js";

const WS = "11111111-1111-1111-1111-111111111111";

function sqlAsText(query: unknown): string {
  const name = (query as { name?: unknown })?.name;
  if (typeof name === "string") return name;
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .flatMap((chunk) => {
      const value = (chunk as { value?: unknown[] }).value;
      if (Array.isArray(value)) {
        return value.filter((part): part is string => typeof part === "string");
      }
      return [sqlAsText(chunk)];
    })
    .join(" ");
}

function makeInsert(events: string[], prefix: "db" | "tx") {
  return vi.fn(() => ({
    values: vi.fn(() => {
      events.push(`${prefix}:insert`);
      return {
        returning: vi.fn(async () => [
          {
            id: "session-1",
            workspaceId: WS,
            agentId: "agent-1",
            status: "active",
            startedAt: new Date("2026-07-16T12:00:00.000Z"),
            collapsedAt: null,
            metadata: { actorId: "actor-1" },
          },
        ]),
      };
    }),
  }));
}

/**
 * `.where()` is awaitable AND chainable, mirroring drizzle: callers that only
 * need the write await it directly, while callers that need to know whether a
 * row matched go on to `.returning()`. The double used to stop at `.where()`,
 * so the first repository method to ask for `.returning()` failed here while
 * working against a real database.
 */
function makeUpdate(events: string[], prefix: "db" | "tx") {
  return vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => {
        events.push(`${prefix}:update`);
        const result = Promise.resolve([{ id: "turn-1" }]);
        return Object.assign(result, {
          returning: vi.fn(async () => [{ id: "turn-1" }]),
        });
      }),
    })),
  }));
}

function makeRepository({
  member = true,
  parentVisible = true,
  role = { rolsuper: false, rolbypassrls: false },
}: {
  member?: boolean;
  parentVisible?: boolean;
  role?: { rolsuper: boolean; rolbypassrls: boolean } | null;
} = {}) {
  const events: string[] = [];
  const selectedRow = {
    id: "session-1",
    workspaceId: WS,
    sessionId: "session-1",
    agentId: "agent-1",
    turnIndex: 0,
    role: "user",
    content: "hello",
    tokenCount: 1,
    status: "active",
    startedAt: new Date("2026-07-16T12:00:00.000Z"),
    collapsedAt: null,
    metadata: { actorId: "actor-1" },
  };
  const tx = {
    execute: vi.fn(async (query: unknown) => {
      const text = sqlAsText(query);
      events.push(`tx:execute:${text}`);
      if (text.includes("pg_has_role")) return [{ m: member }];
      if (text.includes("pg_roles")) return role ? [role] : [];
      if (text.includes("mnemo_prompt_version")) return [];
      return [];
    }),
    insert: makeInsert(events, "tx"),
    update: makeUpdate(events, "tx"),
    select: vi.fn((selection?: Record<string, unknown>) => ({
      from: vi.fn(() => {
        events.push("tx:select");
        return {
          where: vi.fn(() => {
            const selected = parentVisible ? [selectedRow] : [];
            const result =
              selection && Object.keys(selection).length === 1 && "turnIndex" in selection
                ? [{ turnIndex: 0 }]
                : selected;
            return Object.assign(Promise.resolve(result), {
              limit: vi.fn(() =>
                Object.assign(Promise.resolve(selected), {
                  for: vi.fn(async () => selected),
                })
              ),
              orderBy: vi.fn(async () => selected),
            });
          }),
        };
      }),
    })),
    transaction: vi.fn(),
  };
  tx.transaction.mockImplementation(async (fn: (value: typeof tx) => unknown) => fn(tx));
  const db = {
    transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
    execute: vi.fn(async () => {
      events.push("db:execute");
      return [];
    }),
    insert: makeInsert(events, "db"),
    update: makeUpdate(events, "db"),
  };
  return {
    repository: new SessionRepository(db as never, db as never),
    transaction: db.transaction,
    events,
  };
}

function expectScopedBefore(events: string[], operation: string, member = true) {
  const joined = events.join("\n");
  const operationIndex = events.findIndex((event) => event.includes(operation));
  const appWorkspaceIndex = events.findIndex((event) => event.includes("app.workspace_id"));
  const mnemoWorkspaceIndex = events.findIndex((event) => event.includes("mnemosyne.workspace_id"));

  expect(joined).toContain("pg_has_role");
  expect(appWorkspaceIndex).toBeGreaterThan(-1);
  expect(mnemoWorkspaceIndex).toBeGreaterThan(-1);
  expect(appWorkspaceIndex).toBeLessThan(operationIndex);
  expect(mnemoWorkspaceIndex).toBeLessThan(operationIndex);
  expect(events.some((event) => event.startsWith("db:"))).toBe(false);

  if (member) {
    const roleIndex = events.findIndex((event) => event.includes("SET LOCAL ROLE app_user"));
    const searchPathIndex = events.findIndex((event) =>
      event.includes("SET LOCAL search_path TO mnemosyne, public")
    );
    expect(roleIndex).toBeGreaterThan(-1);
    expect(searchPathIndex).toBeGreaterThan(roleIndex);
    expect(searchPathIndex).toBeLessThan(appWorkspaceIndex);
  } else {
    expect(joined).not.toContain("SET LOCAL ROLE app_user");
    expect(joined).not.toContain("SET LOCAL search_path TO mnemosyne, public");
    expect(joined).toContain("pg_roles");
  }
}

describe("SessionRepository lifecycle write RLS", () => {
  it("scopes prompt-version lookup and session insert in the same transaction", async () => {
    const { repository, transaction, events } = makeRepository();

    await repository.createSession({
      workspaceId: WS,
      agentId: "agent-1",
      actorId: "actor-1",
    });

    expect(transaction).toHaveBeenCalledOnce();
    expectScopedBefore(events, "mnemo_prompt_version");
    expect(events.findIndex((event) => event.includes("mnemo_prompt_version"))).toBeLessThan(
      events.indexOf("tx:insert")
    );
  });

  it("scopes appendTurn before inserting the turn", async () => {
    const { repository, transaction, events } = makeRepository();

    await repository.appendTurn("session-1", {
      workspaceId: WS,
      sessionId: "session-1",
      turnIndex: 0,
      role: "user",
      content: "hello",
    });

    expect(transaction).toHaveBeenCalledOnce();
    expectScopedBefore(events, "tx:insert");
    expect(events.indexOf("tx:select")).toBeLessThan(events.indexOf("tx:insert"));
  });

  it("rejects appendTurn before insert when the scoped parent session is absent", async () => {
    const { repository, events } = makeRepository({ parentVisible: false });

    await expect(
      repository.appendTurn("session-a", {
        workspaceId: WS,
        sessionId: "session-a",
        turnIndex: 0,
        role: "user",
        content: "hello",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(events).toContain("tx:select");
    expect(events).not.toContain("tx:insert");
  });

  it("scopes listTurns before reading turns", async () => {
    const { repository, transaction, events } = makeRepository();

    await repository.listTurns("session-1", WS);

    expect(transaction).toHaveBeenCalledOnce();
    expectScopedBefore(events, "tx:select");
  });

  it("scopes closeSession before reading or updating the session", async () => {
    const { repository, transaction, events } = makeRepository();

    await repository.closeSession("session-1", WS);

    expect(transaction).toHaveBeenCalledOnce();
    expectScopedBefore(events, "tx:select");
  });

  it("scopes archiveSession before reading or updating the session", async () => {
    const { repository, transaction, events } = makeRepository();

    await repository.archiveSession("session-1", WS);

    expect(transaction).toHaveBeenCalledOnce();
    expectScopedBefore(events, "tx:select");
  });

  it("scopes getSession before reading the session", async () => {
    const { repository, transaction, events } = makeRepository();

    await repository.getSession("session-1", WS);

    expect(transaction).toHaveBeenCalledOnce();
    expectScopedBefore(events, "tx:select");
  });

  it("scopes pinSessionTurn before updating the turn", async () => {
    const { repository, transaction, events } = makeRepository();

    await repository.pinSessionTurn({
      sessionId: "session-1",
      workspaceId: WS,
      turnId: "turn-1",
      pinned: true,
    });

    expect(transaction).toHaveBeenCalledOnce();
    expectScopedBefore(events, "tx:update");
  });

  it("scopes updateSessionSummary before updating the session", async () => {
    const { repository, transaction, events } = makeRepository();

    await repository.updateSessionSummary({
      sessionId: "session-1",
      workspaceId: WS,
      summary: { outcome: "resolved" },
      factCount: 1,
    });

    expect(transaction).toHaveBeenCalledOnce();
    expectScopedBefore(events, "tx:update");
  });

  it("keeps a safe non-member role while setting both workspace GUCs", async () => {
    const { repository, events } = makeRepository({ member: false });

    await repository.appendTurn("session-1", {
      workspaceId: WS,
      sessionId: "session-1",
      turnIndex: 0,
      role: "user",
      content: "hello",
    });

    expectScopedBefore(events, "tx:insert", false);
  });

  it("fails closed for an unsafe non-member role before setting GUCs or querying tables", async () => {
    const { repository, events } = makeRepository({
      member: false,
      role: { rolsuper: false, rolbypassrls: true },
    });

    await expect(
      repository.appendTurn("session-1", {
        workspaceId: WS,
        sessionId: "session-1",
        turnIndex: 0,
        role: "user",
        content: "hello",
      })
    ).rejects.toThrow(/unsafe database role/i);

    expect(events.some((event) => event.includes("app.workspace_id"))).toBe(false);
    expect(events.some((event) => event.includes("mnemosyne.workspace_id"))).toBe(false);
    expect(events).not.toContain("tx:select");
    expect(events).not.toContain("tx:insert");
  });
});
