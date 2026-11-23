/**
 * Contract tests for the `memory_strategy` MCP tool
 * (packages/mcp/src/tools/strategy.ts), auditing the claims in
 * docs/archive/openspec/tool-promise-remediation/tools/memory_strategy.md:
 *
 *   1. `store` MUST be a true alias of `create` — identical client call
 *      for identical input.
 *   2. `recall` MUST be a true alias of `list` EXCEPT for one documented
 *      default: when no explicit `statusFilter` is given, `recall` adds
 *      `status: "active"` to the query while `list` stays unfiltered.
 *      When `statusFilter` IS given explicitly, `recall` and `list` must
 *      issue the identical query.
 *   3. `rate` MUST require both `id` and `outcome`, and pass them through
 *      to `client.rateStrategy()` unchanged — the actual Beta-Bernoulli
 *      arithmetic lives server-side (proven separately, against real
 *      Postgres, in
 *      packages/server/src/__tests__/integration/strategies.integration.test.ts
 *      and packages/server/src/__tests__/strategy-rate.test.ts).
 *
 * These are unit tests over the tool's request-shaping logic with a
 * mocked MnemosyneClient — they prove the tool wires `op` to the correct
 * client method with the correct arguments, not server-side behavior.
 */
import { describe, it, expect, vi } from "vitest";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStrategy } from "../../tools/strategy.js";

type ClientMethods = Pick<
  MnemosyneClient,
  | "createStrategy"
  | "listStrategies"
  | "getStrategy"
  | "patchStrategy"
  | "archiveStrategy"
  | "rateStrategy"
>;

function makeClientStub(partial: Partial<ClientMethods>): MnemosyneClient {
  return partial as unknown as MnemosyneClient;
}

function registerAndCapture(client: MnemosyneClient): {
  handler: (args: Record<string, unknown>) => Promise<unknown>;
} {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (
      toolName: string,
      schema: unknown,
      cb: (args: Record<string, unknown>) => Promise<unknown>
    ) => {
      if (toolName === "memory_strategy") handler = cb;
      return orig(toolName, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerStrategy(server, client);
  if (!handler) throw new Error("memory_strategy was not registered");
  return { handler };
}

describe("memory_strategy op:'store' vs op:'create' — true alias", () => {
  it("both ops call client.createStrategy with the identical body for identical input", async () => {
    const createStrategy = vi.fn().mockResolvedValue({ id: "strat-1" });
    const { handler } = registerAndCapture(makeClientStub({ createStrategy }));

    const input = {
      trigger: "Error occurs",
      action: "Retry with backoff",
      context: "During API calls",
      scopeRef: "project-x",
    };

    await handler({ op: "create", ...input });
    await handler({ op: "store", ...input });

    expect(createStrategy).toHaveBeenCalledTimes(2);
    const [createArgs] = createStrategy.mock.calls[0]!;
    const [storeArgs] = createStrategy.mock.calls[1]!;
    // Same body shape for both — proves `store` is not a subtly different
    // code path that could drift from `create` over time.
    expect(storeArgs).toEqual(createArgs);
    expect(storeArgs).toEqual({
      trigger: "Error occurs",
      action: "Retry with backoff",
      context: "During API calls",
      scopeRef: "project-x",
    });
  });

  it("both ops require trigger and action and reject when missing", async () => {
    const createStrategy = vi.fn();
    const { handler } = registerAndCapture(makeClientStub({ createStrategy }));

    const createResult = (await handler({ op: "create", trigger: "only trigger" })) as {
      isError: boolean;
    };
    const storeResult = (await handler({ op: "store", action: "only action" })) as {
      isError: boolean;
    };

    expect(createResult.isError).toBe(true);
    expect(storeResult.isError).toBe(true);
    expect(createStrategy).not.toHaveBeenCalled();
  });
});

describe("memory_strategy op:'recall' vs op:'list' — alias with a documented default-filter difference", () => {
  it("list with no statusFilter sends no status param (unfiltered)", async () => {
    const listStrategies = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const { handler } = registerAndCapture(makeClientStub({ listStrategies }));

    await handler({ op: "list" });

    expect(listStrategies).toHaveBeenCalledWith({});
  });

  it("recall with no statusFilter defaults to status:'active' — NOT an unfiltered alias of list", async () => {
    const listStrategies = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const { handler } = registerAndCapture(makeClientStub({ listStrategies }));

    await handler({ op: "recall" });

    // This is the crux of the audit: if this ever regresses to `{}` (the
    // same call `list` makes), `recall` would silently become a pure
    // alias of `list` with no filtering, contradicting its own
    // "relevant/active" description.
    expect(listStrategies).toHaveBeenCalledWith({ status: "active" });
  });

  it("recall with an explicit statusFilter uses that filter instead of the active default", async () => {
    const listStrategies = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const { handler } = registerAndCapture(makeClientStub({ listStrategies }));

    await handler({ op: "recall", statusFilter: "archived" });

    expect(listStrategies).toHaveBeenCalledWith({ status: "archived" });
  });

  it("list with an explicit statusFilter issues the identical query recall would for the same filter", async () => {
    const listStrategies = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const { handler } = registerAndCapture(makeClientStub({ listStrategies }));

    await handler({ op: "list", statusFilter: "archived" });
    await handler({ op: "recall", statusFilter: "archived" });

    expect(listStrategies).toHaveBeenNthCalledWith(1, { status: "archived" });
    expect(listStrategies).toHaveBeenNthCalledWith(2, { status: "archived" });
  });

  it("both ops forward scopeRef, validAt, and limit identically", async () => {
    const listStrategies = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const { handler } = registerAndCapture(makeClientStub({ listStrategies }));

    const shared = { scopeRef: "project-x", validAt: "2026-01-01T00:00:00.000Z", limit: 10 };
    await handler({ op: "list", statusFilter: "active", ...shared });
    await handler({ op: "recall", ...shared });

    expect(listStrategies).toHaveBeenNthCalledWith(1, { status: "active", ...shared });
    expect(listStrategies).toHaveBeenNthCalledWith(2, { status: "active", ...shared });
  });
});

describe("memory_strategy op:'rate' — passthrough to client.rateStrategy", () => {
  it("requires id and outcome", async () => {
    const rateStrategy = vi.fn();
    const { handler } = registerAndCapture(makeClientStub({ rateStrategy }));

    const missingOutcome = (await handler({ op: "rate", id: "strat-1" })) as { isError: boolean };
    const missingId = (await handler({ op: "rate", outcome: "success" })) as { isError: boolean };

    expect(missingOutcome.isError).toBe(true);
    expect(missingId.isError).toBe(true);
    expect(rateStrategy).not.toHaveBeenCalled();
  });

  it("passes id and outcome through unchanged for both success and failure", async () => {
    const rateStrategy = vi.fn().mockResolvedValue({ id: "strat-1", worth: 0.6 });
    const { handler } = registerAndCapture(makeClientStub({ rateStrategy }));

    await handler({ op: "rate", id: "strat-1", outcome: "success" });
    await handler({ op: "rate", id: "strat-1", outcome: "failure" });

    expect(rateStrategy).toHaveBeenNthCalledWith(1, "strat-1", "success");
    expect(rateStrategy).toHaveBeenNthCalledWith(2, "strat-1", "failure");
  });
});

describe("memory_strategy CRUD passthrough (get/patch/archive)", () => {
  it("get requires id and calls client.getStrategy", async () => {
    const getStrategy = vi.fn().mockResolvedValue({ id: "strat-1" });
    const { handler } = registerAndCapture(makeClientStub({ getStrategy }));

    const missing = (await handler({ op: "get" })) as { isError: boolean };
    expect(missing.isError).toBe(true);

    await handler({ op: "get", id: "strat-1" });
    expect(getStrategy).toHaveBeenCalledWith("strat-1");
  });

  it("patch requires id and forwards only the provided fields", async () => {
    const patchStrategy = vi.fn().mockResolvedValue({ id: "strat-1" });
    const { handler } = registerAndCapture(makeClientStub({ patchStrategy }));

    const missing = (await handler({ op: "patch", status: "archived" })) as { isError: boolean };
    expect(missing.isError).toBe(true);

    await handler({ op: "patch", id: "strat-1", status: "archived" });
    expect(patchStrategy).toHaveBeenCalledWith("strat-1", { status: "archived" });
  });

  it("archive requires id and calls client.archiveStrategy", async () => {
    const archiveStrategy = vi.fn().mockResolvedValue(undefined);
    const { handler } = registerAndCapture(makeClientStub({ archiveStrategy }));

    const missing = (await handler({ op: "archive" })) as { isError: boolean };
    expect(missing.isError).toBe(true);

    const result = (await handler({ op: "archive", id: "strat-1" })) as {
      structuredContent: { id: string; archived: boolean };
    };
    expect(archiveStrategy).toHaveBeenCalledWith("strat-1");
    expect(result.structuredContent).toEqual({ id: "strat-1", archived: true });
  });
});
