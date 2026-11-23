/**
 * P135 — `createCore` resolves `scopeRef` against the workspace's `project`
 * entities: a write stores the canonical name, a recall filtered by a project
 * reaches memories written under any of its spellings.
 */
import { describe, it, expect, vi } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { AuthContext, RecallFilter } from "@mnemo-ai/types";
import { createCore } from "../index.js";
import { withProjectScope } from "../project-scope.js";
import { matchesRecallFilter } from "../recall-filter.js";

vi.mock("../compositionality.js", () => ({ composeInferences: vi.fn(async () => []) }));

const WS = "ws-proj";
const AUTH = {
  workspaceId: WS,
  actorId: "key:k1",
  actorType: "agent",
  scopes: ["memory:read", "memory:write"],
  sensitivityCeiling: "restricted",
} as unknown as AuthContext;

const VEC = new Float32Array([1, 0, 0]);

function makeCore(storage: InMemoryStorageAdapter) {
  return createCore({
    storage,
    vector: { search: vi.fn(async () => []) },
    embed: {
      id: "test",
      model: "test-model",
      dimensions: 3,
      embedSingle: vi.fn(async () => VEC),
      embed: vi.fn(async (texts: string[]) => texts.map(() => VEC)),
    },
    outbox: { append: vi.fn(async () => undefined) },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    telemetry: {
      startSpan: () => ({ end: vi.fn(), setAttribute: vi.fn() }),
      histogram: vi.fn(),
      counter: vi.fn(),
      gauge: vi.fn(),
    },
  } as never);
}

async function storageWithAcme() {
  const storage = new InMemoryStorageAdapter();
  const project = await storage.createEntity({
    workspaceId: WS,
    name: "acme",
    kind: "project",
    aliases: ["Acme", "acme-hr"],
  });
  return { storage, project };
}

describe("createCore().remember — P135 scopeRef canonicalization", () => {
  it("stores an alias as the project's canonical name and says so", async () => {
    const { storage, project } = await storageWithAcme();
    const res = await makeCore(storage).remember(
      { workspaceId: WS, kind: "fact", content: "Payroll closes on the 25th", scopeRef: "Acme" },
      AUTH
    );
    const stored = await storage.getFact(res.id, WS);
    expect(stored?.scopeRef).toBe("acme");
    expect(res.scopeRefResolution).toEqual({
      canonicalized: { received: "Acme", storedAs: "acme", entityId: project.id },
    });
  });

  it("canonicalizes decisions too", async () => {
    const { storage } = await storageWithAcme();
    const res = await makeCore(storage).remember(
      {
        workspaceId: WS,
        kind: "decision",
        content: "Use SFTP for payroll files",
        scopeRef: "acme-hr",
      },
      AUTH
    );
    const { items } = await storage.queryDecisions({ workspaceId: WS });
    expect(items.find((d) => d.id === res.id)?.scopeRef).toBe("acme");
  });

  it("stores an unknown value as sent, with a suggestion when it resembles a project", async () => {
    const { storage, project } = await storageWithAcme();
    const res = await makeCore(storage).remember(
      { workspaceId: WS, kind: "fact", content: "Holidays sync nightly", scopeRef: "acme_hr" },
      AUTH
    );
    expect((await storage.getFact(res.id, WS))?.scopeRef).toBe("acme_hr");
    expect(res.scopeRefResolution).toEqual({
      suggestion: { received: "acme_hr", project: "acme", entityId: project.id },
    });
  });

  it("changes nothing in a workspace without project entities", async () => {
    const storage = new InMemoryStorageAdapter();
    const res = await makeCore(storage).remember(
      { workspaceId: WS, kind: "fact", content: "Anything at all", scopeRef: "Acme" },
      AUTH
    );
    expect((await storage.getFact(res.id, WS))?.scopeRef).toBe("Acme");
    expect(res.scopeRefResolution).toBeUndefined();
  });
});

describe("recall by project — P135", () => {
  it("withProjectScope keeps the canonical name and adds the other spellings", async () => {
    const { storage } = await storageWithAcme();
    const q = await withProjectScope(storage, {
      workspaceId: WS,
      text: "payroll",
      filter: { scopeRef: "ACME" },
    });
    expect(q.filter?.scopeRef).toBe("acme");
    expect(q.filter?.scopeRefAliases?.sort()).toEqual(["Acme", "acme-hr"]);
  });

  it("withProjectScope returns the same query when no project matches", async () => {
    const { storage } = await storageWithAcme();
    const query = { workspaceId: WS, text: "x", filter: { scopeRef: "orchester" } };
    expect(await withProjectScope(storage, query)).toBe(query);
  });

  it("the filter matches a memory written under any spelling, and nothing else", () => {
    const filter: RecallFilter = { scopeRef: "acme", scopeRefAliases: ["Acme", "acme-hr"] };
    const base = {
      primitive: "fact" as const,
      validFrom: new Date("2026-01-01T00:00:00Z"),
      sensitivity: "internal" as const,
    };
    expect(matchesRecallFilter({ ...base, scopeRef: "acme" }, filter)).toBe(true);
    expect(matchesRecallFilter({ ...base, scopeRef: "Acme" }, filter)).toBe(true);
    expect(matchesRecallFilter({ ...base, scopeRef: "acme-hr" }, filter)).toBe(true);
    expect(matchesRecallFilter({ ...base, scopeRef: "orchester" }, filter)).toBe(false);
    expect(matchesRecallFilter({ ...base }, filter)).toBe(false);
  });

  it("createCore().recall resolves the filter before searching", async () => {
    const { storage } = await storageWithAcme();
    const spy = vi.spyOn(storage, "queryEntities");
    await makeCore(storage)
      .recall({ workspaceId: WS, text: "payroll closes", filter: { scopeRef: "Acme" } }, AUTH)
      .catch(() => undefined);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, kind: "project" }));
  });

  it("listing facts by an alias returns memories stored under every spelling", async () => {
    const { storage } = await storageWithAcme();
    for (const scopeRef of ["acme", "Acme", "orchester"]) {
      await storage.createFact({
        workspaceId: WS,
        scope: "global",
        statement: `fact under ${scopeRef}`,
        subject: "s",
        scopeRef,
      } as never);
    }
    const page = await storage.queryFactsPage({
      workspaceId: WS,
      scopeRef: "acme",
      scopeRefAliases: ["Acme", "acme-hr"],
      limit: 50,
    });
    expect(page.items.map((f) => f.scopeRef).sort()).toEqual(["Acme", "acme"]);
  });
});
