/**
 * Contract test for `memory_status` (packages/mcp/src/tools/status.ts).
 *
 * `client.health()` -> `GET /health`, which server-side is `mountVitals`
 * (packages/server/src/routes/health.ts) — NOT the unauthenticated
 * `/health/ready` / `/health/deep` routes that actually probe
 * postgres/vector/cache. `GET /health` returns
 * `deps.core.vitals({workspaceId})` (packages/core/src/factory.ts):
 * `{workspaceId, factsLive, factsClosed, pinnedCount, lastRecallAt,
 * lastWriteAt, embeddings, factsByScopeRef}` — a fact-count snapshot. There
 * is no `status` field and no `components` map anywhere in that object; the
 * client-ts `HealthSnapshot` type does not describe this route's real wire
 * shape. See the real-Postgres integration test
 * (`packages/server/src/__tests__/integration/status-vitals-nonsuperuser.integration.test.ts`)
 * for the live proof against a real DB response body.
 *
 * FIXED (2026-07-31): `client.healthReady()` -> `GET /health/ready` IS now
 * wired in as a 4th, best-effort parallel call, surfacing the real
 * postgres/vector/cache status under `structuredContent.dependencyHealth`
 * (instance-wide, not scoped to the caller's workspace — see section 5
 * below).
 *
 * This file proves the MCP tool's *own* transport logic in isolation
 * (mocked `MnemosyneClient`):
 *
 *   1. Whatever shape `client.health()` resolves with is passed straight
 *      through into `content[0].text` and `structuredContent` — the tool
 *      itself does not hardcode or normalize to "healthy". If the real
 *      server ever DID start returning `status`/`components` fields, this
 *      tool would surface them correctly.
 *   2. A rejected `client.health()` (the closest a mock gets to a genuine
 *      DB outage, since the real endpoint has no structured degraded
 *      state to report) surfaces as `isError: true` with the failure
 *      message — not a silently "healthy" response.
 *   3. `client.getStats()` / `client.getMe()` failures are swallowed
 *      independently (`.catch(() => null)` in status.ts) — the tool still
 *      succeeds, just omitting the scopeRef breakdown / personal section.
 *      This is a real asymmetry worth documenting: a `health()` failure
 *      is loud (isError), but a `getStats()`/`getMe()` failure is silent.
 *   4. The personal-workspace section is gated exactly on
 *      `me.personalWorkspaceId` being present, matching P10's "only when
 *      the key has a userId" promise. The upstream RLS recursion bug that
 *      used to make `getUserPersonalWorkspaceId` always return `null` in
 *      real deployments is fixed (migration
 *      `0012_workspace_member_rls_recursion.sql`) — see the server
 *      integration suite referenced above for the real-Postgres proof.
 *   5. The scopeRef breakdown passes through `stats.facts.byScopeRef`
 *      verbatim.
 *   6. `client.healthReady()` is merged the same way `getStats`/`getMe` are
 *      (best-effort, swallowed to omission on failure) into
 *      `dependencyHealth` — proven for ready/degraded/not_ready shapes and
 *      for the failure/missing-method cases.
 */
import { describe, it, expect, vi } from "vitest";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStatus } from "../../tools/status.js";
import { registeredDescription } from "./registered-description.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ClientStubShape = Partial<
  Pick<MnemosyneClient, "health" | "getStats" | "getMe" | "healthReady">
>;

function makeClientStub(partial: ClientStubShape): MnemosyneClient {
  return partial as unknown as MnemosyneClient;
}

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function registerAndCapture(client: MnemosyneClient): {
  handler: () => Promise<ToolResult>;
  description: string;
} {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let handler: (() => Promise<ToolResult>) | undefined;
  let description = "";
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (
      toolName: string,
      schema: unknown,
      cb: (args: Record<string, unknown>) => Promise<unknown>
    ) => {
      if (toolName === "memory_status") {
        handler = cb as unknown as () => Promise<ToolResult>;
        description = (schema as { description?: string }).description ?? "";
      }
      return orig(toolName, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerStatus(server, client);
  if (!handler) throw new Error("memory_status was not registered");
  return { handler, description: registeredDescription("memory_status") };
}

function healthyHealth(): Record<string, unknown> {
  return {
    workspaceId: "ws_stub",
    factsLive: 10,
    factsClosed: 2,
    pinnedCount: 1,
    lastRecallAt: null,
    lastWriteAt: null,
    embeddings: { indexed: 10, pending: 0 },
  };
}

// ─── 1. Pass-through of whatever health() resolves with ─────────────────────

describe("memory_status — health() pass-through (Scenario: unhealthy dependency)", () => {
  it("passes a degraded-shaped health response straight through — the tool does not normalize to healthy", async () => {
    const degraded = {
      status: "degraded",
      components: { db: "ok", embedder: "down", queue: "ok" },
    };
    const client = makeClientStub({
      health: async () => degraded as unknown as Awaited<ReturnType<MnemosyneClient["health"]>>,
      getStats: async () => {
        throw new Error("no stats");
      },
      getMe: async () => {
        throw new Error("no me");
      },
    });
    const { handler } = registerAndCapture(client);
    const out = await handler();
    expect(out.isError).toBeFalsy();
    const parsedFromText = JSON.parse(out.content[0]!.text.split("\n\n")[0]!) as Record<
      string,
      unknown
    >;
    expect(parsedFromText.status).toBe("degraded");
    expect(parsedFromText.components).toEqual({ db: "ok", embedder: "down", queue: "ok" });
    expect(out.structuredContent?.status).toBe("degraded");
    expect(out.structuredContent?.components).toEqual({ db: "ok", embedder: "down", queue: "ok" });
  });

  it("passes an 'ok' health response through unchanged (baseline)", async () => {
    const ok = { status: "ok", components: { db: "ok", embedder: "ok", queue: "ok" } };
    const client = makeClientStub({
      health: async () => ok as unknown as Awaited<ReturnType<MnemosyneClient["health"]>>,
      getStats: async () => {
        throw new Error("no stats");
      },
      getMe: async () => {
        throw new Error("no me");
      },
    });
    const { handler } = registerAndCapture(client);
    const out = await handler();
    expect(out.structuredContent?.status).toBe("ok");
  });

  it("a real health() outage (rejected promise) surfaces as isError:true, not a silent healthy response", async () => {
    const client = makeClientStub({
      health: async () => {
        throw new Error("ECONNREFUSED: db unreachable");
      },
      getStats: async () => {
        throw new Error("no stats");
      },
      getMe: async () => {
        throw new Error("no me");
      },
    });
    const { handler } = registerAndCapture(client);
    const out = await handler();
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("ECONNREFUSED");
    expect(out.structuredContent).toBeUndefined();
  });

  it("FINDING: getStats()/getMe() failures are swallowed silently (tool still succeeds) — asymmetric with health() failures which are loud", async () => {
    const client = makeClientStub({
      health: async () =>
        healthyHealth() as unknown as Awaited<ReturnType<MnemosyneClient["health"]>>,
      getStats: async () => {
        throw new Error("stats service down");
      },
      getMe: async () => {
        throw new Error("me service down");
      },
    });
    const { handler } = registerAndCapture(client);
    const out = await handler();
    // Overall call succeeds even though 2 of 3 upstream calls failed.
    expect(out.isError).toBeFalsy();
    // No scopeRef breakdown, no personal section — but no error surfaced either.
    expect(out.content[0]!.text).not.toContain("Facts by project");
    expect(out.content[0]!.text).not.toContain("Personal workspace");
    expect(out.structuredContent?.factsByScopeRef).toEqual([]);
    expect(out.structuredContent?.personal).toBeUndefined();
  });
});

// ─── 2. Personal workspace gating (Scenario: key type) ───────────────────────

describe("memory_status — personal workspace section respects key type (P10)", () => {
  it("workspace-scoped key (getMe() has no personalWorkspaceId) -> no personal section", async () => {
    const client = makeClientStub({
      health: async () =>
        healthyHealth() as unknown as Awaited<ReturnType<MnemosyneClient["health"]>>,
      getStats: async () =>
        ({ facts: { byScopeRef: [] } }) as unknown as Awaited<
          ReturnType<MnemosyneClient["getStats"]>
        >,
      getMe: async () =>
        ({
          workspaceId: "ws_stub",
          userId: null,
          personalWorkspaceId: null,
          personalFactsLive: null,
        }) as unknown as Awaited<ReturnType<MnemosyneClient["getMe"]>>,
    });
    const { handler } = registerAndCapture(client);
    const out = await handler();
    expect(out.content[0]!.text).not.toContain("Personal workspace");
    expect(out.structuredContent?.personal).toBeUndefined();
  });

  it("user-bound key (getMe() has a personalWorkspaceId) -> personal section appears with real data", async () => {
    const client = makeClientStub({
      health: async () =>
        healthyHealth() as unknown as Awaited<ReturnType<MnemosyneClient["health"]>>,
      getStats: async () =>
        ({ facts: { byScopeRef: [] } }) as unknown as Awaited<
          ReturnType<MnemosyneClient["getStats"]>
        >,
      getMe: async () =>
        ({
          workspaceId: "ws_stub",
          userId: "user_123",
          personalWorkspaceId: "ws_personal_456",
          personalFactsLive: 7,
        }) as unknown as Awaited<ReturnType<MnemosyneClient["getMe"]>>,
    });
    const { handler } = registerAndCapture(client);
    const out = await handler();
    expect(out.content[0]!.text).toContain("Personal workspace: ws_personal_456 (7 facts)");
    expect(out.structuredContent?.personal).toEqual({
      workspaceId: "ws_personal_456",
      factsLive: 7,
    });
  });

  it("user-bound key with zero personal facts still shows the section (0 facts, not omitted)", async () => {
    const client = makeClientStub({
      health: async () =>
        healthyHealth() as unknown as Awaited<ReturnType<MnemosyneClient["health"]>>,
      getStats: async () =>
        ({ facts: { byScopeRef: [] } }) as unknown as Awaited<
          ReturnType<MnemosyneClient["getStats"]>
        >,
      getMe: async () =>
        ({
          workspaceId: "ws_stub",
          userId: "user_123",
          personalWorkspaceId: "ws_personal_456",
          personalFactsLive: 0,
        }) as unknown as Awaited<ReturnType<MnemosyneClient["getMe"]>>,
    });
    const { handler } = registerAndCapture(client);
    const out = await handler();
    expect(out.content[0]!.text).toContain("Personal workspace: ws_personal_456 (0 facts)");
    expect(out.structuredContent?.personal).toEqual({
      workspaceId: "ws_personal_456",
      factsLive: 0,
    });
  });
});

// ─── 3. scopeRef breakdown pass-through ──────────────────────────────────────

describe("memory_status — facts-by-scopeRef breakdown", () => {
  it("renders the breakdown text and structuredContent from stats.facts.byScopeRef", async () => {
    const client = makeClientStub({
      health: async () =>
        healthyHealth() as unknown as Awaited<ReturnType<MnemosyneClient["health"]>>,
      getStats: async () =>
        ({
          facts: {
            byScopeRef: [
              { scopeRef: "mnemosyne", count: 12 },
              { scopeRef: "project:abc", count: 3 },
            ],
          },
        }) as unknown as Awaited<ReturnType<MnemosyneClient["getStats"]>>,
      getMe: async () =>
        ({
          workspaceId: "ws_stub",
          userId: null,
          personalWorkspaceId: null,
          personalFactsLive: null,
        }) as unknown as Awaited<ReturnType<MnemosyneClient["getMe"]>>,
    });
    const { handler } = registerAndCapture(client);
    const out = await handler();
    expect(out.content[0]!.text).toContain("Facts by project (scopeRef):");
    expect(out.content[0]!.text).toContain("mnemosyne: 12");
    expect(out.content[0]!.text).toContain("project:abc: 3");
    expect(out.structuredContent?.factsByScopeRef).toEqual([
      { scopeRef: "mnemosyne", count: 12 },
      { scopeRef: "project:abc", count: 3 },
    ]);
  });

  it("omits the breakdown section entirely when byScopeRef is empty", async () => {
    const client = makeClientStub({
      health: async () =>
        healthyHealth() as unknown as Awaited<ReturnType<MnemosyneClient["health"]>>,
      getStats: async () =>
        ({ facts: { byScopeRef: [] } }) as unknown as Awaited<
          ReturnType<MnemosyneClient["getStats"]>
        >,
      getMe: async () =>
        ({
          workspaceId: "ws_stub",
          userId: null,
          personalWorkspaceId: null,
          personalFactsLive: null,
        }) as unknown as Awaited<ReturnType<MnemosyneClient["getMe"]>>,
    });
    const { handler } = registerAndCapture(client);
    const out = await handler();
    expect(out.content[0]!.text).not.toContain("Facts by project");
    expect(out.structuredContent?.factsByScopeRef).toEqual([]);
  });
});

// ─── 4. Description accurately scopes dependencyHealth ──────────────────────

describe("memory_status — MCP description describes dependencyHealth accurately", () => {
  it("the tool's description mentions dependencyHealth and that it is instance-wide, not workspace-scoped", async () => {
    const client = makeClientStub({
      health: async () =>
        healthyHealth() as unknown as Awaited<ReturnType<MnemosyneClient["health"]>>,
    });
    const { description } = registerAndCapture(client);
    // Since the 2026-07-31 fix, GET /health/ready (client.healthReady()) IS
    // wired in and surfaces real postgres/vector/cache status — but it's an
    // unauthenticated, instance-wide probe, not scoped to the caller's
    // workspace. The description must disclose that scoping distinction so
    // callers don't read it as this-workspace-specific infra health.
    expect(description).toContain("dependencyHealth");
    expect(description).toContain("whole instance's readiness, not this workspace's");
    expect(registeredDescription("memory_status", "es-419")).toContain(
      "toda la instancia, no de este espacio de trabajo"
    );
  });
});

// ─── 5. dependencyHealth — GET /health/ready merge (2026-07-31 fix) ─────────

describe("memory_status — dependencyHealth is wired from client.healthReady()", () => {
  it("merges a healthy readiness snapshot into content text and structuredContent.dependencyHealth", async () => {
    const readySnapshot = {
      status: "ready" as const,
      degraded: false,
      checks: { postgres: "ok", vector: "ok", cache: "ok" },
    };
    const client = makeClientStub({
      health: async () =>
        healthyHealth() as unknown as Awaited<ReturnType<MnemosyneClient["health"]>>,
      getStats: async () =>
        ({ facts: { byScopeRef: [] } }) as unknown as Awaited<
          ReturnType<MnemosyneClient["getStats"]>
        >,
      getMe: async () =>
        ({
          workspaceId: "ws_stub",
          userId: null,
          personalWorkspaceId: null,
          personalFactsLive: null,
        }) as unknown as Awaited<ReturnType<MnemosyneClient["getMe"]>>,
      healthReady: async () =>
        readySnapshot as unknown as Awaited<ReturnType<MnemosyneClient["healthReady"]>>,
    });
    const { handler } = registerAndCapture(client);
    const out = await handler();
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent?.dependencyHealth).toEqual(readySnapshot);
    expect(out.content[0]!.text).toContain(
      "Dependency health (instance-wide, not workspace-scoped): ready"
    );
    expect(out.content[0]!.text).toContain("postgres: ok");
    expect(out.content[0]!.text).toContain("vector: ok");
    expect(out.content[0]!.text).toContain("cache: ok");
  });

  it("merges a degraded readiness snapshot, flagging degraded in the text", async () => {
    const degradedSnapshot = {
      status: "ready" as const,
      degraded: true,
      checks: { postgres: "ok", vector: "degraded", cache: "ok" },
    };
    const client = makeClientStub({
      health: async () =>
        healthyHealth() as unknown as Awaited<ReturnType<MnemosyneClient["health"]>>,
      getStats: async () =>
        ({ facts: { byScopeRef: [] } }) as unknown as Awaited<
          ReturnType<MnemosyneClient["getStats"]>
        >,
      getMe: async () =>
        ({
          workspaceId: "ws_stub",
          userId: null,
          personalWorkspaceId: null,
          personalFactsLive: null,
        }) as unknown as Awaited<ReturnType<MnemosyneClient["getMe"]>>,
      healthReady: async () =>
        degradedSnapshot as unknown as Awaited<ReturnType<MnemosyneClient["healthReady"]>>,
    });
    const { handler } = registerAndCapture(client);
    const out = await handler();
    expect(out.structuredContent?.dependencyHealth).toEqual(degradedSnapshot);
    expect(out.content[0]!.text).toContain(
      "Dependency health (instance-wide, not workspace-scoped): ready (degraded)"
    );
    expect(out.content[0]!.text).toContain("vector: degraded");
  });

  it("a not_ready readiness snapshot (postgres down) surfaces status + reason, not just checks", async () => {
    const notReadySnapshot = { status: "not_ready" as const, reason: "postgres_unavailable" };
    const client = makeClientStub({
      health: async () =>
        healthyHealth() as unknown as Awaited<ReturnType<MnemosyneClient["health"]>>,
      getStats: async () =>
        ({ facts: { byScopeRef: [] } }) as unknown as Awaited<
          ReturnType<MnemosyneClient["getStats"]>
        >,
      getMe: async () =>
        ({
          workspaceId: "ws_stub",
          userId: null,
          personalWorkspaceId: null,
          personalFactsLive: null,
        }) as unknown as Awaited<ReturnType<MnemosyneClient["getMe"]>>,
      healthReady: async () =>
        notReadySnapshot as unknown as Awaited<ReturnType<MnemosyneClient["healthReady"]>>,
    });
    const { handler } = registerAndCapture(client);
    const out = await handler();
    expect(out.structuredContent?.dependencyHealth).toEqual(notReadySnapshot);
    expect(out.content[0]!.text).toContain(
      "Dependency health (instance-wide, not workspace-scoped): not_ready"
    );
    expect(out.content[0]!.text).toContain("reason: postgres_unavailable");
  });

  it("a failed/unreachable healthReady() is swallowed silently (same asymmetry as getStats/getMe) — memory_status still succeeds without dependencyHealth", async () => {
    const client = makeClientStub({
      health: async () =>
        healthyHealth() as unknown as Awaited<ReturnType<MnemosyneClient["health"]>>,
      getStats: async () =>
        ({ facts: { byScopeRef: [] } }) as unknown as Awaited<
          ReturnType<MnemosyneClient["getStats"]>
        >,
      getMe: async () =>
        ({
          workspaceId: "ws_stub",
          userId: null,
          personalWorkspaceId: null,
          personalFactsLive: null,
        }) as unknown as Awaited<ReturnType<MnemosyneClient["getMe"]>>,
      healthReady: async () => {
        throw new Error("health/ready unreachable");
      },
    });
    const { handler } = registerAndCapture(client);
    const out = await handler();
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent?.dependencyHealth).toBeUndefined();
    expect(out.content[0]!.text).not.toContain("Dependency health");
  });

  it("a client stub without healthReady at all (older/mocked callers) does not throw — dependencyHealth is simply omitted", async () => {
    const client = makeClientStub({
      health: async () =>
        healthyHealth() as unknown as Awaited<ReturnType<MnemosyneClient["health"]>>,
      getStats: async () =>
        ({ facts: { byScopeRef: [] } }) as unknown as Awaited<
          ReturnType<MnemosyneClient["getStats"]>
        >,
      getMe: async () =>
        ({
          workspaceId: "ws_stub",
          userId: null,
          personalWorkspaceId: null,
          personalFactsLive: null,
        }) as unknown as Awaited<ReturnType<MnemosyneClient["getMe"]>>,
      // healthReady intentionally omitted
    });
    const { handler } = registerAndCapture(client);
    const out = await handler();
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent?.dependencyHealth).toBeUndefined();
  });
});
