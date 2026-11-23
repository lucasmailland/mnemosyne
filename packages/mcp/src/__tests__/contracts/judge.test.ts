/**
 * Contract test for `memory_judge` (packages/mcp/src/tools/judge.ts),
 * covering docs/archive/openspec/tool-promise-remediation/tools/memory_judge.md.
 *
 * Second-highest risk in the UNAUDITED set, and for a specific reason: since
 * P108 the deterministic resolver no longer archives anything on its own, so
 * `memory_judge` is now the ONLY path by which a contradiction gets decided.
 * Every conflict in the queue waits for this tool. A wiring slip between its
 * four resolution strategies would archive the wrong fact — and archiving the
 * survivor of a conflict is how a system quietly loses the true statement and
 * keeps the false one.
 *
 * What this file proves, at the MCP layer with a stubbed client (no DB):
 *   1. All four strategies (`supersede_a`, `supersede_b`, `keep_both`,
 *      `merge`) reach the client as DISTINCT values — none collapses onto
 *      another, and none is silently dropped.
 *   2. `merge` without a usable `mergedStatement` resolves NOTHING. The audit
 *      lists this as a required precondition; a merge that proceeds without
 *      the corrected text would archive both originals and leave nothing
 *      behind.
 *   3. `resolve` without `relationId` or without `resolution` fails before
 *      any client call — a partially-specified resolution must not reach the
 *      server and get interpreted.
 *   4. `mergedStatement` is omitted entirely (not sent as `undefined`) on the
 *      three non-merge strategies.
 *   5. The description discloses that `merge` is NON-ATOMIC. This is the
 *      caveat the tool's own doc-comment records: merge runs multiple writes
 *      in separate `withMnemoTx` transactions rather than the
 *      single-transaction `replaceFact` path, so a mid-merge crash can leave
 *      a partial state. An agent choosing between strategies deserves to know
 *      that one of them can half-apply.
 *
 * What this file does NOT assert: which rows actually end up archived. That
 * is a DB-level claim (audit scenarios 1–4) and belongs against real Postgres,
 * per this repo's rule that DB/RLS claims are not verified by mocks. The MCP
 * layer's job — proven here — is that the caller's chosen verdict arrives
 * intact and that an under-specified one never arrives at all.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerJudge } from "../../tools/judge.js";
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
  const server = new McpServer({ name: "judge-test", version: "0.0.0" });
  let handler: ((a: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  let description = "";
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: (a: Record<string, unknown>) => Promise<unknown>) => {
      if (name === "memory_judge") {
        handler = cb as typeof handler;
        description = (schema as { description?: string }).description ?? "";
      }
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerJudge(server, client);
  if (!handler) throw new Error("memory_judge was not registered");
  return { call: handler, description: registeredDescription("memory_judge") };
}

const stub = (p: Record<string, unknown>): MnemosyneClient => p as unknown as MnemosyneClient;

describe("memory_judge — contract", () => {
  it("action:'list' forwards limit, and omits it when not supplied", async () => {
    const judge = vi.fn(async () => ({ conflicts: [] }));
    const { call } = capture(stub({ judge }));

    await call({ action: "list", limit: 3 });
    expect(judge).toHaveBeenCalledWith({ limit: 3 });

    judge.mockClear();
    await call({ action: "list" });
    // `undefined`, not `{ limit: undefined }` — the server applies its own
    // default (5), and sending an explicit undefined can override it.
    expect(judge).toHaveBeenCalledWith(undefined);
  });

  describe("each resolution strategy reaches the client distinctly", () => {
    for (const resolution of ["supersede_a", "supersede_b", "keep_both"] as const) {
      it(`forwards ${resolution} verbatim, with no mergedStatement`, async () => {
        const resolveConflict = vi.fn<
          (id: string, body: Record<string, unknown>) => Promise<{ resolved: boolean }>
        >(async () => ({ resolved: true }));
        const { call } = capture(stub({ resolveConflict }));

        await call({ action: "resolve", relationId: "rel_1", resolution });

        expect(resolveConflict).toHaveBeenCalledWith("rel_1", { action: resolution });
        // Key: the payload has no `mergedStatement` KEY at all. A present-but-
        // undefined field can serialize to null and be read as "merge with
        // empty text".
        const payload = resolveConflict.mock.calls[0]![1];
        expect("mergedStatement" in payload).toBe(false);
      });
    }

    it("forwards merge together with its corrected statement", async () => {
      const resolveConflict = vi.fn(async () => ({ resolved: true }));
      const { call } = capture(stub({ resolveConflict }));

      await call({
        action: "resolve",
        relationId: "rel_1",
        resolution: "merge",
        mergedStatement: "El cache corre sobre Valkey desde septiembre.",
      });

      expect(resolveConflict).toHaveBeenCalledWith("rel_1", {
        action: "merge",
        mergedStatement: "El cache corre sobre Valkey desde septiembre.",
      });
    });
  });

  describe("an under-specified resolution never reaches the server", () => {
    it("refuses resolve without relationId", async () => {
      const resolveConflict = vi.fn();
      const { call } = capture(stub({ resolveConflict }));

      const res = await call({ action: "resolve", resolution: "keep_both" });

      expect(res.isError).toBe(true);
      expect(resolveConflict).not.toHaveBeenCalled();
    });

    it("refuses resolve without a resolution", async () => {
      const resolveConflict = vi.fn();
      const { call } = capture(stub({ resolveConflict }));

      const res = await call({ action: "resolve", relationId: "rel_1" });

      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("resolution");
      expect(resolveConflict).not.toHaveBeenCalled();
    });

    for (const [label, mergedStatement] of [
      ["omitted", undefined],
      ["empty", ""],
      ["whitespace only", "   "],
    ] as const) {
      it(`refuses merge when mergedStatement is ${label}`, async () => {
        const resolveConflict = vi.fn();
        const { call } = capture(stub({ resolveConflict }));

        const res = await call({
          action: "resolve",
          relationId: "rel_1",
          resolution: "merge",
          ...(mergedStatement === undefined ? {} : { mergedStatement }),
        });

        // A merge archives BOTH originals. Proceeding without the corrected
        // text would destroy two statements and produce nothing.
        expect(res.isError).toBe(true);
        expect(resolveConflict).not.toHaveBeenCalled();
      });
    }
  });

  it("surfaces a client failure as a tool error", async () => {
    const { call } = capture(
      stub({
        resolveConflict: vi.fn(async () => {
          throw new Error("404 relation not found");
        }),
      })
    );

    const res = await call({ action: "resolve", relationId: "gone", resolution: "keep_both" });

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("404 relation not found");
  });

  it("discloses that merge is non-atomic", async () => {
    // Regression guard. The doc-comment records that merge runs several
    // writes across separate transactions instead of the single-transaction
    // replaceFact path — so it can half-apply. An agent picking a strategy
    // needs that in the description, not only in a source comment.
    const { description } = capture(stub({}));
    expect(description).toMatch(/no.?atomic|non-atomic/i);
    expect(description).toContain("replaceFact");
  });
});
