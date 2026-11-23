import { describe, expect, it, vi } from "vitest";
import { FactRepository } from "../../repositories/FactRepository.js";

const WS = "11111111-1111-1111-1111-111111111111";

function sqlAsText(query: unknown): string {
  const name = (query as { name?: unknown })?.name;
  if (typeof name === "string") return name;
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .flatMap((chunk) => {
      const value = (chunk as { value?: unknown[] }).value;
      if (Array.isArray(value))
        return value.filter((part): part is string => typeof part === "string");
      return [sqlAsText(chunk)];
    })
    .join(" ");
}

/**
 * WP-5 (CHAOS-8): updateFact now reads its row `.limit(1).for("update")`. The
 * double resolves both the bare `.limit()` and the locked form to the rows.
 */
function lockable<T>(rows: T[]) {
  return Object.assign(Promise.resolve(rows), { for: vi.fn(async () => rows) });
}

function factRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date("2026-07-14T12:00:00.000Z");
  return {
    id: "fact-1",
    workspaceId: WS,
    agentId: null,
    actorId: null,
    scope: "global",
    scopeRef: null,
    scopeOwner: `workspace:${WS}`,
    statement: "old statement",
    subject: "test",
    kind: "other",
    confidence: "0.7",
    relevance: 1,
    hitCount: 0,
    lastRecalledAt: null,
    worthSuccess: "0",
    worthFailure: "0",
    worthAlpha: "2",
    worthBeta: "2",
    worth: "0.5",
    memoryType: "semantic",
    memoryStrength: 1,
    memoryStability: 1,
    lastStrengthUpdate: null,
    attribution: "inferred",
    attributedTo: null,
    sourceMessageIds: [],
    sessionId: null,
    extractionSource: null,
    topicKey: null,
    revisionCount: 1,
    protocolVersion: "3.0",
    entityId: null,
    episodeId: null,
    status: "active",
    pinned: false,
    canonical: false,
    sensitivity: "internal",
    mergedIntoId: null,
    validFrom: now,
    validTo: null,
    embeddingModel: null,
    embeddingStale: true,
    createdAt: now,
    updatedAt: now,
    metadata: {},
    ...overrides,
  };
}

function makeRepository(
  existingRows: Record<string, unknown>[],
  role = { member: true, rolsuper: false, rolbypassrls: false }
) {
  const events: string[] = [];
  const executeSql: string[] = [];
  let updateWhere: unknown;
  const returned = factRow({ statement: "new statement", revisionCount: 2 });
  const tx = {
    execute: vi.fn(async (query: unknown) => {
      events.push("execute");
      const text = sqlAsText(query);
      executeSql.push(text);
      if (text.includes("pg_has_role")) return [{ m: role.member }];
      if (text.includes("pg_roles")) {
        return [{ rolsuper: role.rolsuper, rolbypassrls: role.rolbypassrls }];
      }
      return [];
    }),
    select: vi.fn(() => {
      events.push("select");
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(() => lockable(existingRows)) })),
        })),
      };
    }),
    // WP-5 (PRIM-4): a statement change enqueues its re-embed in the same tx.
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          updateWhere = condition;
          return { returning: vi.fn(async () => [returned]) };
        }),
      })),
    })),
    // P126: a statement change now also drops the orphaned mnemo_fact_hash row
    // in the same transaction. Recorded rather than ignored so a test can tell
    // "the delete ran" from "the double happened to tolerate it".
    delete: vi.fn(() => {
      events.push("delete");
      return { where: vi.fn(async () => undefined) };
    }),
  };
  const db = { transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)) };
  return {
    repository: new FactRepository(db as never, db as never),
    events,
    executeSql,
    getUpdateWhere: () => updateWhere,
  };
}

describe("FactRepository.updateFact RLS", () => {
  it("establishes the canonical role and workspace context before reading", async () => {
    const { repository, events, executeSql } = makeRepository([factRow()]);

    await repository.updateFact("fact-1", WS, { confidence: 0.9 });

    expect(events.indexOf("execute")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("execute")).toBeLessThan(events.indexOf("select"));
    expect(executeSql.join(" ")).toContain("pg_has_role");
    expect(executeSql.join(" ")).toContain("SET LOCAL ROLE app_user");
    expect(executeSql.join(" ")).toContain("SET LOCAL search_path TO mnemosyne, public");
    expect(executeSql.join(" ")).toContain("app.workspace_id");
    expect(executeSql.join(" ")).toContain("mnemosyne.workspace_id");
  });

  it("returns null when the workspace-scoped source is not visible", async () => {
    const { repository } = makeRepository([]);

    await expect(repository.updateFact("fact-1", WS, { confidence: 0.9 })).resolves.toBeNull();
  });

  it("fails closed when the connection role can bypass RLS", async () => {
    const { repository } = makeRepository([factRow()], {
      member: false,
      rolsuper: true,
      rolbypassrls: true,
    });

    await expect(repository.updateFact("fact-1", WS, { confidence: 0.9 })).rejects.toThrow(
      "Unsafe database role cannot enforce workspace RLS"
    );
  });

  it("guards statement updates with workspace, active, and open predicates", async () => {
    const { repository, getUpdateWhere } = makeRepository([factRow()]);

    await repository.updateFact("fact-1", WS, { statement: "new statement" });

    const whereSql = sqlAsText(getUpdateWhere());
    expect(whereSql).toContain("workspace_id");
    expect(whereSql).toContain("status");
    expect(whereSql).toContain("valid_to");
  });

  it("guards pinned updates with the pending-consolidation-marker exclusion", async () => {
    const { repository, getUpdateWhere } = makeRepository([factRow()]);

    await repository.updateFact("fact-1", WS, { pinned: true });

    const whereSql = sqlAsText(getUpdateWhere());
    expect(whereSql).toContain("__mnemoConsolidationPending");
  });

  it("does NOT add the marker exclusion for a plain confidence update", async () => {
    const { repository, getUpdateWhere } = makeRepository([factRow()]);

    await repository.updateFact("fact-1", WS, { confidence: 0.9 });

    const whereSql = sqlAsText(getUpdateWhere());
    expect(whereSql).not.toContain("__mnemoConsolidationPending");
  });

  it("metadata updates strip a forged marker and reattach the genuine current value", async () => {
    const genuine = { operationId: "op-1", survivorId: "fact-1" };
    const { repository } = makeRepository([
      factRow({ metadata: { __mnemoConsolidationPending: genuine } }),
    ]);

    // Capture the drizzle .set() payload.
    let captured: Record<string, unknown> | undefined;
    const db = (repository as unknown as { db: { transaction: unknown } }).db;
    void db; // db is already wired in the mock; we assert through a fresh spy below.

    // Re-run with an instrumented mock to capture the set() argument.
    const setArg = await captureSet(
      [factRow({ metadata: { __mnemoConsolidationPending: genuine } })],
      {
        metadata: { extra: "field", __mnemoConsolidationPending: { operationId: "spoofed" } },
      }
    );
    captured = setArg.metadata as Record<string, unknown>;
    expect(captured).toMatchObject({ extra: "field" });
    expect(captured!.__mnemoConsolidationPending).toEqual(genuine);
  });
});

describe("FactRepository.setCanonical RLS", () => {
  it("guards canonical updates with the pending-consolidation-marker exclusion", async () => {
    let updateWhere: unknown;
    const tx = {
      execute: vi.fn(async () => []),
      delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn((condition: unknown) => {
            updateWhere = condition;
            return Promise.resolve([]);
          }),
        })),
      })),
    };
    const db = { transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)) };
    const repository = new FactRepository(db as never, db as never);

    await repository.setCanonical("fact-1", WS, true);

    expect(sqlAsText(updateWhere)).toContain("__mnemoConsolidationPending");
  });
});

/** Instrument a fresh FactRepository mock to capture the drizzle .set() payload for updateFact. */
async function captureSet(
  existingRows: Record<string, unknown>[],
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  let setArg: Record<string, unknown> = {};
  const tx = {
    execute: vi.fn(async (query: unknown) => {
      const text = sqlAsText(query);
      if (text.includes("pg_has_role")) return [{ m: true }];
      return [];
    }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(() => lockable(existingRows)) })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    update: vi.fn(() => ({
      set: vi.fn((arg: Record<string, unknown>) => {
        setArg = arg;
        return { where: vi.fn(() => ({ returning: vi.fn(async () => [existingRows[0]]) })) };
      }),
    })),
  };
  const db = { transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)) };
  const repository = new FactRepository(db as never, db as never);
  await repository.updateFact("fact-1", WS, input as never);
  return setArg;
}
