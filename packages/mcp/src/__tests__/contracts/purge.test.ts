/**
 * Contract test for `memory_purge` (packages/mcp/src/tools/purge.ts),
 * covering docs/archive/openspec/tool-promise-remediation/tools/memory_purge.md.
 *
 * The audit calls this "the highest-risk item in the entire UNAUDITED set",
 * and the reason is worth restating: it is the one non-reversible,
 * destructive tool in the registry. An unverified contract on a hard-delete
 * capability is a materially bigger problem than an unverified contract on a
 * read tool.
 *
 * What this file proves, at the MCP layer with a stubbed client (no DB):
 *   1. `action:"fact"` without a usable `factId` deletes NOTHING — it must
 *      fail before any client call, not fall through to the bulk path.
 *   2. `action:"fact"` and `action:"closed"` reach DIFFERENT client methods.
 *      A wiring slip between them would turn "delete this one row" into
 *      "delete every forgotten row in the workspace", silently and
 *      irreversibly.
 *   3. The description discloses that this is NOT GDPR-compliant erasure.
 *      That caveat is load-bearing: the tool's own doc-comment records the
 *      deliberate design difference (no deletion-log, no DEK crypto-erasure,
 *      no audit trail) and points at `memory_forget` for Article 17. A future
 *      edit quietly dropping the warning would leave an agent believing this
 *      satisfies an erasure request.
 *
 * What this file deliberately does NOT assert, and why:
 *
 *   - **The scope gate.** `memory:hard_delete` is enforced SERVER-side
 *     (`routes/facts.ts` checks it before `purgeForgottenFacts` runs). The
 *     tool performs no client-side scope check, and it should not: a check
 *     in the caller is theatre — anyone able to call the tool can call the
 *     HTTP route directly. Asserting a client-side gate here would pin
 *     behaviour we do not want.
 *   - **That the row is really gone.** "Permanentemente… NO reversible" is a
 *     DB-level claim and is proven against real Postgres in
 *     `adapter-postgres/src/__tests__/integration/fact-page-and-purge.integration.test.ts`,
 *     which also covers the P114 findings: the bulk purge now writes one
 *     `mnemo_deletion_log` row per deleted fact and drops each fact's
 *     `mnemo_fact_hash` fingerprint. Per this repo's rule, DB claims are not
 *     verified by mocks.
 *
 * Audit question 3 ("does `pinned` protect a forgotten fact from the bulk
 * path?") is answered there too, and the answer is NO: `purgeForgottenFacts`
 * filters on `status = 'forgotten'` and the consolidation-pending marker
 * only. `pinned` is anti-decay, not anti-delete — consistent with
 * `memory_pin`'s own semantics, and documented here so the next reader does
 * not assume otherwise.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerPurge } from "../../tools/purge.js";
import { registeredDescription } from "./registered-description.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function capture(client: MnemosyneClient): {
  call: (args: Record<string, unknown>) => Promise<ToolResult>;
  description: string;
} {
  const server = new McpServer({ name: "purge-test", version: "0.0.0" });
  let handler: ((a: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  let description = "";
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: (a: Record<string, unknown>) => Promise<unknown>) => {
      if (name === "memory_purge") {
        handler = cb as typeof handler;
        description = (schema as { description?: string }).description ?? "";
      }
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerPurge(server, client);
  if (!handler) throw new Error("memory_purge was not registered");
  return { call: handler, description: registeredDescription("memory_purge") };
}

function stub(partial: Record<string, unknown>): MnemosyneClient {
  return partial as unknown as MnemosyneClient;
}

describe("memory_purge — contract", () => {
  describe("action:'fact' cannot delete without a target", () => {
    for (const [label, factId] of [
      ["omitted", undefined],
      ["empty string", ""],
      ["whitespace only", "   "],
    ] as const) {
      it(`refuses and calls nothing when factId is ${label}`, async () => {
        const purgeFact = vi.fn();
        const purgeClosedFacts = vi.fn();
        const { call } = capture(stub({ purgeFact, purgeClosedFacts }));

        const res = await call({ action: "fact", ...(factId === undefined ? {} : { factId }) });

        expect(res.isError).toBe(true);
        expect(res.content[0]?.text).toContain("factId is required");
        // The assertion that matters: nothing was deleted. A guard that
        // returns an error AFTER calling the client would read as safe and
        // not be.
        expect(purgeFact).not.toHaveBeenCalled();
        // And it must not fall through to the bulk path either — that would
        // turn a malformed single-fact delete into a workspace-wide sweep.
        expect(purgeClosedFacts).not.toHaveBeenCalled();
      });
    }
  });

  it("action:'fact' purges exactly the given id, trimmed", async () => {
    const purgeFact = vi.fn(async () => ({ deleted: true }));
    const purgeClosedFacts = vi.fn();
    const { call } = capture(stub({ purgeFact, purgeClosedFacts }));

    const res = await call({ action: "fact", factId: "  fact_1  " });

    expect(purgeFact).toHaveBeenCalledWith("fact_1");
    expect(purgeFact).toHaveBeenCalledTimes(1);
    expect(purgeClosedFacts).not.toHaveBeenCalled();
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({ deleted: true });
  });

  it("action:'closed' purges in bulk and never touches the single-fact path", async () => {
    const purgeFact = vi.fn();
    const purgeClosedFacts = vi.fn(async () => ({ deleted: 3 }));
    const { call } = capture(stub({ purgeFact, purgeClosedFacts }));

    const res = await call({ action: "closed", confirm: true });

    expect(purgeClosedFacts).toHaveBeenCalledTimes(1);
    expect(purgeFact).not.toHaveBeenCalled();
    expect(res.structuredContent).toEqual({ deleted: 3 });
  });

  it("ignores a stray factId on the bulk path rather than half-honouring it", async () => {
    // Passing both is caller confusion. Silently purging the single fact
    // instead of the bulk set — or doing both — would be worse than picking
    // the declared action and sticking to it.
    const purgeFact = vi.fn();
    const purgeClosedFacts = vi.fn(async () => ({ deleted: 0 }));
    const { call } = capture(stub({ purgeFact, purgeClosedFacts }));

    await call({ action: "closed", factId: "fact_1", confirm: true });

    expect(purgeClosedFacts).toHaveBeenCalledTimes(1);
    expect(purgeFact).not.toHaveBeenCalled();
  });

  it("surfaces a client failure as a tool error, not a thrown promise", async () => {
    const { call } = capture(
      stub({
        purgeFact: vi.fn(async () => {
          throw new Error("403 insufficient scope");
        }),
      })
    );

    const res = await call({ action: "fact", factId: "fact_1" });

    // The server's `memory:hard_delete` gate surfaces here. It must reach the
    // agent as a readable tool error, not an unhandled rejection.
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("403 insufficient scope");
  });

  it("discloses that this is NOT GDPR-compliant erasure", async () => {
    // Regression guard for the caveat, per the audit's Deliverable 4. The
    // tool's doc-comment records the deliberate design difference; if the
    // warning ever leaves the description, an agent handling an Article 17
    // request would reach for the wrong tool.
    const { description } = capture(stub({}));
    expect(description).toContain("purge is not GDPR erasure");
    expect(description).toContain("memory_forget");
    expect(registeredDescription("memory_purge", "es-419")).toMatch(
      /no es (un )?borrado|no cumple/i
    );
  });
});
