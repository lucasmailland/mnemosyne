/**
 * Contract tests for `memory_status`, `memory_strategy`, `memory_stats` and
 * `memory_compare` (tool-promise-remediation phases 3–16), covering their four
 * audit docs under `docs/archive/openspec/tool-promise-remediation/tools/`.
 *
 * The through-line, and why they share a file: all four REPORT rather than
 * write, and a reporting tool fails in the reassuring direction. A broken
 * diagnostic that says "ok" is worse than no diagnostic, because it actively
 * tells the reader to stop looking — the same reasoning `memory_doctor`'s
 * contract test opens with.
 *
 * `memory_status` — the audit asks whether an unhealthy dependency actually
 * changes what is reported. The tool merges FOUR independent calls, each with
 * its own failure mode; if a `degraded` readiness result is swallowed by the
 * blanket try/catch, the tool reports a healthy workspace on a broken
 * instance.
 *
 * `memory_strategy` — `store`/`recall` are documented as aliases of
 * `create`/`list`. An alias that is "almost" its target is worse than no
 * alias: the caller believes they used the documented operation. But `recall`
 * is NOT a pure alias — it defaults to the active slice — and that difference
 * is deliberate, so it is pinned rather than smoothed over.
 *
 * `memory_stats` — its own audit says the counts must agree with the other
 * tools' view. What is checkable here is the trap CLAUDE.md names explicitly:
 * four snapshot-derived counts are `number | null`, and `null` means "no usable
 * snapshot", NOT zero. A tool that renders them with `?? 0` reports an empty
 * workspace as confidently as a real one.
 *
 * `memory_compare` — all five suggested verbs must be REACHABLE. A verb the
 * server can return but the tool mangles is a relation an agent will never
 * create.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerStatus } from "../../tools/status.js";
import { registerStrategy } from "../../tools/strategy.js";
import { registerStats } from "../../tools/stats.js";
import { registerCompare } from "../../tools/compare.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type Handler = (a: Record<string, unknown>) => Promise<ToolResult>;

function capture(
  register: (s: McpServer, c: MnemosyneClient) => void,
  toolName: string,
  client: Record<string, unknown>
): { call: Handler; description: string } {
  const server = new McpServer({ name: "t", version: "0.0.0" });
  let handler: Handler | undefined;
  let description = "";
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, config: unknown, cb: (a: Record<string, unknown>) => Promise<unknown>) => {
      if (name === toolName) {
        handler = cb as Handler;
        description = (config as { description?: string }).description ?? "";
      }
      return orig(name, config as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  register(server, client as unknown as MnemosyneClient);
  if (!handler) throw new Error(`${toolName} was not registered`);
  return { call: handler, description };
}

const STATS = {
  facts: { live: 3, pinned: 1, archived: 0 },
  embeddings: { pending: 0 },
};

describe("memory_status — contract", () => {
  const base = () => ({
    health: vi.fn(async () => ({ status: "ok", checks: {} })),
    getStats: vi.fn(async () => STATS),
    getMe: vi.fn(async () => ({ workspaceId: "ws_1" })),
    healthReady: vi.fn(async () => ({ ready: true, degraded: false, checks: {} })),
  });

  it("calls the readiness probe, not only the liveness one", async () => {
    // The audit's first finding: `healthReady` existed on the client and was
    // never called from here, so "the instance is up" was being reported as
    // "the instance is working". They are different questions.
    const client = base();
    const { call } = capture(registerStatus, "memory_status", client);

    await call({});

    expect(client.healthReady).toHaveBeenCalled();
  });

  it("an unhealthy dependency changes what is reported", async () => {
    const client = {
      ...base(),
      healthReady: vi.fn(async () => ({
        ready: false,
        degraded: true,
        checks: { postgres: "ok", vector: "error" },
      })),
    };
    const { call } = capture(registerStatus, "memory_status", client);

    const res = await call({});
    const text = JSON.stringify(res.structuredContent ?? res.content);

    // The exact rendering may change; that a degraded instance is
    // DISTINGUISHABLE from a healthy one may not.
    expect(text).toMatch(/degraded|not_ready|false/);
    expect(res.isError).toBeFalsy();
  });

  it("a failing readiness probe does not take the whole tool down", async () => {
    // Same shape as memory_doctor's rule: the moment the instance is sick is
    // exactly when an operator needs whatever else the tool can still say.
    const client = {
      ...base(),
      healthReady: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    };
    const { call } = capture(registerStatus, "memory_status", client);

    const res = await call({});

    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.structuredContent ?? res.content)).toContain("facts");
  });

  it("omits the personal-workspace section when the key has no bound user", async () => {
    // Absent must mean "this key has no personal workspace", never "the lookup
    // failed" — the audit's second finding was those two being
    // indistinguishable.
    const client = { ...base(), getMe: vi.fn(async () => ({ workspaceId: "ws_1" })) };
    const { call } = capture(registerStatus, "memory_status", client);

    const res = await call({});

    expect(JSON.stringify(res.structuredContent ?? {})).not.toContain("personalWorkspaceId");
  });

  it("includes the personal workspace when the key has one", async () => {
    const client = {
      ...base(),
      getMe: vi.fn(async () => ({
        workspaceId: "ws_1",
        personalWorkspaceId: "ws_personal",
        personalFactsLive: 7,
      })),
    };
    const { call } = capture(registerStatus, "memory_status", client);

    const res = await call({});

    expect(JSON.stringify(res.structuredContent ?? res.content)).toContain("ws_personal");
  });
});

describe("memory_strategy — contract", () => {
  it("store is a TRUE alias of create — same client method, same payload", async () => {
    const createStrategy = vi.fn<(i: Record<string, unknown>) => Promise<unknown>>(async () => ({
      id: "st_1",
    }));
    const { call } = capture(registerStrategy, "memory_strategy", { createStrategy });

    await call({ op: "store", trigger: "cache miss", action: "warm the cache" });
    const viaStore = createStrategy.mock.calls[0]![0];

    createStrategy.mockClear();
    await call({ op: "create", trigger: "cache miss", action: "warm the cache" });
    const viaCreate = createStrategy.mock.calls[0]![0];

    // An alias that is ALMOST its target is worse than no alias: the caller
    // believes they invoked the documented operation.
    expect(viaStore).toEqual(viaCreate);
  });

  it("recall is NOT a pure alias of list, and the difference is deliberate", async () => {
    // `recall` means "the heuristics worth executing now", so it defaults to
    // the active slice; `list` stays unfiltered for back-compat. Pinned rather
    // than smoothed over, because someone tidying this up into a true alias
    // would silently start returning archived strategies to `recall` callers.
    const listStrategies = vi.fn<(p: Record<string, unknown>) => Promise<unknown>>(async () => ({
      items: [],
    }));
    const { call } = capture(registerStrategy, "memory_strategy", { listStrategies });

    await call({ op: "recall" });
    expect(listStrategies).toHaveBeenCalledWith({ status: "active" });

    listStrategies.mockClear();
    await call({ op: "list" });
    expect(listStrategies).toHaveBeenCalledWith({});
  });

  it("an explicit statusFilter beats recall's default", async () => {
    const listStrategies = vi.fn<(p: Record<string, unknown>) => Promise<unknown>>(async () => ({
      items: [],
    }));
    const { call } = capture(registerStrategy, "memory_strategy", { listStrategies });

    await call({ op: "recall", statusFilter: "archived" });

    expect(listStrategies).toHaveBeenCalledWith({ status: "archived" });
  });

  describe("rate moves worth in the caller's direction", () => {
    for (const outcome of ["success", "failure"] as const) {
      it(`forwards ${outcome} verbatim`, async () => {
        // Swapping these would train the system backwards — a strategy that
        // keeps failing would climb. Nothing downstream could detect it.
        const rateStrategy = vi.fn(async () => ({ id: "st_1", worth: 0.5 }));
        const { call } = capture(registerStrategy, "memory_strategy", { rateStrategy });

        await call({ op: "rate", id: "st_1", outcome });

        expect(rateStrategy).toHaveBeenCalledWith("st_1", outcome);
      });
    }

    it("refuses rate without an outcome instead of guessing one", async () => {
      const rateStrategy = vi.fn();
      const { call } = capture(registerStrategy, "memory_strategy", { rateStrategy });

      const res = await call({ op: "rate", id: "st_1" });

      expect(res.isError).toBe(true);
      expect(rateStrategy).not.toHaveBeenCalled();
    });
  });

  it("refuses get/patch/archive without an id", async () => {
    const client = { getStrategy: vi.fn(), patchStrategy: vi.fn(), archiveStrategy: vi.fn() };
    const { call } = capture(registerStrategy, "memory_strategy", client);

    for (const op of ["get", "patch", "archive"]) {
      const res = await call({ op });
      expect(res.isError, `${op} accepted a missing id`).toBe(true);
    }
    expect(client.getStrategy).not.toHaveBeenCalled();
    expect(client.patchStrategy).not.toHaveBeenCalled();
    expect(client.archiveStrategy).not.toHaveBeenCalled();
  });
});

describe("memory_stats — contract", () => {
  it("does not render a null snapshot-derived count as zero", async () => {
    // CLAUDE.md names this trap by name: `facts.archived`, `facts.withZeroHits`,
    // `decisions.active` and `relations.conflicts` are `number | null`, and
    // `null` means "no usable snapshot", not "none". A `?? 0` here reports an
    // empty workspace with exactly the same confidence as a real measurement.
    const getStats = vi.fn(async () => ({
      facts: { live: 12, pinned: 2, archived: null, withZeroHits: null },
      decisions: { active: null },
      relations: { conflicts: null },
      snapshot: { available: false },
    }));
    const { call } = capture(registerStats, "memory_stats", { getStats });

    const res = await call({});
    const out = JSON.stringify(res.structuredContent ?? res.content);

    // The measured value survives; the unmeasured ones must not have become 0.
    expect(out).toContain("12");
    expect(out).not.toMatch(/"archived":\s*0/);
    expect(out).not.toMatch(/"conflicts":\s*0/);
  });

  it("passes a real zero through as zero", async () => {
    // The other half: if `null` were rendered as "unknown", a genuine 0 must
    // still read as 0, or the fix trades one ambiguity for another.
    const getStats = vi.fn(async () => ({
      facts: { live: 5, pinned: 0, archived: 0 },
      snapshot: { available: true },
    }));
    const { call } = capture(registerStats, "memory_stats", { getStats });

    const res = await call({});
    expect(JSON.stringify(res.structuredContent ?? res.content)).toMatch(/"archived":\s*0/);
  });

  it("surfaces a client failure as a tool error", async () => {
    const { call } = capture(registerStats, "memory_stats", {
      getStats: vi.fn(async () => {
        throw new Error("403 admin scope required");
      }),
    });

    const res = await call({});
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("403 admin scope required");
  });
});

describe("memory_compare — contract", () => {
  const fact = (over: Record<string, unknown> = {}) => ({
    id: "fact_a",
    workspaceId: "ws_1",
    content: "the cache runs on redis",
    subject: "infra",
    attribution: {},
    tags: [],
    pinned: false,
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });

  it("all five suggested verbs reach the caller intact", async () => {
    // A verb the server can suggest but the tool mangles is a relation an
    // agent will never create — the graph quietly loses a whole edge type.
    for (const verb of [
      "related",
      "compatible",
      "conflicts_with",
      "supersedes",
      "not_conflict",
    ] as const) {
      const compareFacts = vi.fn<(i: Record<string, unknown>) => Promise<unknown>>(async () => ({
        factA: fact(),
        factB: fact({ id: "fact_b" }),
        differences: [],
        suggestedVerb: verb,
        sameSubject: true,
      }));
      const { call } = capture(registerCompare, "memory_compare", { compareFacts });

      const res = await call({ factIdA: "fact_a", factIdB: "fact_b" });

      expect(JSON.stringify(res.structuredContent ?? res.content), `${verb} was lost`).toContain(
        verb
      );
    }
  });

  it("forwards both ids, in the caller's order", async () => {
    // A/B order decides which fact `supersedes` which. Swapping them inverts
    // the conclusion while still looking like a valid answer.
    const compareFacts = vi.fn<(i: Record<string, unknown>) => Promise<unknown>>(async () => ({
      factA: fact(),
      factB: fact({ id: "fact_b" }),
      differences: [],
      suggestedVerb: "related",
      sameSubject: false,
    }));
    const { call } = capture(registerCompare, "memory_compare", { compareFacts });

    await call({ factIdA: "fact_a", factIdB: "fact_b" });

    expect(compareFacts).toHaveBeenCalledWith({ factIdA: "fact_a", factIdB: "fact_b" });
  });

  it("reports the differences list rather than summarising it away", async () => {
    const compareFacts = vi.fn<(i: Record<string, unknown>) => Promise<unknown>>(async () => ({
      factA: fact(),
      factB: fact({ id: "fact_b", content: "the cache runs on valkey" }),
      differences: ["content", "subject"],
      suggestedVerb: "conflicts_with",
      sameSubject: true,
    }));
    const { call } = capture(registerCompare, "memory_compare", { compareFacts });

    const res = await call({ factIdA: "fact_a", factIdB: "fact_b" });
    const out = JSON.stringify(res.structuredContent ?? res.content);

    expect(out).toContain("content");
    expect(out).toContain("subject");
  });

  it("surfaces a client failure as a tool error", async () => {
    const { call } = capture(registerCompare, "memory_compare", {
      compareFacts: vi.fn(async () => {
        throw new Error("404 fact not found");
      }),
    });

    const res = await call({ factIdA: "gone", factIdB: "fact_b" });

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("404 fact not found");
  });
});
