/**
 * tool-promise-remediation Phase 2.7 — every disclosed limitation stays
 * disclosed.
 *
 * Phase 2 put caveats into tool descriptions: the things a tool does NOT do,
 * written where the calling agent actually reads. A caveat is only worth
 * writing if it survives the next refactor, and nothing was pinning them —
 * until this file, any of these could have been dropped in a description
 * rewrite and no test would have noticed. That is the same shape as the drift
 * P64 exists to catch, one layer up: the description is a promise, and this is
 * the part of the promise that says "not this".
 *
 * ⚠️ Three of the seven disclosures Phase 2 originally specified were NOT added,
 * because they are no longer true. Verified against the code 2026-08-13:
 *
 *   - `reasoning` "semantic recall not wired" — FALSE since P65. Reasoning IS
 *     indexed and recallable (`RECALLABLE_KINDS.includes("reasoning") === true`).
 *     What IS true, and is new, is that it is not in the DEFAULT set — so that
 *     is what its description now says instead.
 *   - `self_edit`/`update` "missing audit trail" — FALSE. `applySelfEdit`
 *     calls `ctx.storage.appendAuditEntry` when provenance is present, and the
 *     HTTP route (`routes/self.ts:434`) threads `resolveProvenance(c)`, so the
 *     MCP path always has it.
 *   - `self_edit`/`update` "stale LSH after replace" — FALSE since P76.
 *     `supersedeActiveFact` deletes the fact's LSH bands in the same
 *     transaction as the replacement.
 *
 * Writing those three verbatim would have put FALSE caveats into the
 * descriptions — worse than no caveat, because an agent would route around a
 * limitation that no longer exists.
 *
 * A fourth was written against a sentinel that does not exist: task 2.4 asked
 * to disclose `workspace.id="unknown"`, and `context.ts` has no such string —
 * a swallowed identity failure surfaces as `workspace: null`. The gap is real,
 * the value in the task was not, so the real one is what the description says.
 *
 * Task 2.5 turned out to be more than a missing caveat and is covered by
 * `episode-end-status.test.ts` as well: `memory_episode_end` was reporting
 * "Episode ended and collapsed" even when the pipeline had skipped extraction
 * outright. The server has carried `status`/`skipReason` since P115 precisely
 * so that could not happen; the MCP layer was discarding both.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerAllTools } from "../../registry.js";

/** Capture every tool's description in one registration pass. */
function descriptions(): Map<string, string> {
  const server = new McpServer({ name: "disclosures-test", version: "0.0.0" });
  const out = new Map<string, string>();
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: unknown) => {
      out.set(name, (schema as { description?: string }).description ?? "");
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerAllTools(server, {} as MnemosyneClient);
  return out;
}

/**
 * Each entry: the tool, what the caveat is about, and substrings that must
 * survive. Matched case-insensitively on substrings, not on whole sentences —
 * the wording may be improved, the FACT may not disappear.
 */
const DISCLOSURES: Array<{ tool: string; about: string; must: string[] }> = [
  {
    tool: "memory_consolidate",
    about: "manual deep mode and dryRun are rejected with 422",
    must: ["422"],
  },
  {
    // Task 2.4 asked for `workspace.id="unknown"`. That string does not exist
    // in context.ts and never did: the swallowed failure surfaces as
    // `workspace: null`. Disclosing the wrong sentinel would send an agent
    // looking for a value it will never see, so the real one is disclosed.
    tool: "memory_context",
    about: "requested identity failure is reported as an error",
    must: ["return an error", "memory_status"],
  },
  {
    tool: "memory_episode_end",
    about: "extraction needs an LLM; without one the collapse yields no facts",
    must: ["LLM", "llm_unavailable", "status"],
  },
  {
    tool: "memory_event",
    about: "archiving an event is a no-op — the log is immutable by design",
    must: ["archive", "{archived:false, immutable:true}", "only be raised"],
  },
  {
    tool: "memory_reasoning",
    about: "indexed but NOT returned by default (P65)",
    must: ["kinds:['reasoning']", "P65"],
  },
  {
    tool: "memory_purge",
    about:
      "permanent deletion; NOT GDPR-compliant erasure — no deletion-log, no DEK crypto-erasure",
    must: ["GDPR", "memory_forget", "permanent", "memory:hard_delete"],
  },
  {
    tool: "memory_judge",
    about: "merge is non-atomic and can half-apply",
    must: ["replaceFact"],
  },
  // The facts below lived only in registrar text the registry never served
  // (removed in b6f58bc2); each was checked against the code before it was
  // put back into the served description.
  {
    tool: "memory_remember",
    about: "the response reports what was stored, not what was sent",
    must: ["`statement` is what was stored", "paraphrase", "PII", "`warnings`", "memory_judge"],
  },
  {
    tool: "memory_status",
    about: "dependencyHealth is instance-wide readiness and can be absent",
    must: ["dependencyHealth", "whole instance", "embed", "omitted"],
  },
  {
    tool: "memory_timeline",
    about: "the event kinds it really emits (an unpin reads as updated)",
    must: ["created", "unpin reads as updated", "decision_created", "newest first"],
  },
  {
    tool: "memory_anticipate",
    about: "the four blend weights from core/cognitive/anticipation.ts",
    must: ["0.35", "0.15", "periodic 0.25", "conditional 0.25", "recentlyRecalledId", "blended"],
  },
  {
    tool: "memory_pin",
    about: "pin blocks consolidation merges but does not boost ranking",
    must: ["never merges", "does not raise"],
  },
  {
    tool: "memory_relocate",
    about: "write access on the target and the sensitivity block",
    must: ["403", "409", "confidential"],
  },
  {
    tool: "memory_relate",
    about: "a fact-to-entity part_of/member_of also links the fact (ENTITY-1)",
    must: ["part_of", "member_of", "links the fact"],
  },
  {
    tool: "memory_workspace",
    about: "no action switches the active workspace; admin actions need a role",
    must: ["active workspace", "owner or admin", "403"],
  },
  {
    tool: "memory_update",
    about: "a correction replaces the fact, so its id changes",
    must: ["replacementId", "applied"],
  },
  {
    tool: "memory_entity",
    about: "linking another user needs memory:admin and an owner/admin role",
    must: ["link_user", "memory:admin"],
  },
  {
    tool: "memory_compare",
    about: "the diff scope and the suggested verbs",
    must: ["content, pinned, valid time", "conflicts_with", "scoped"],
  },
  {
    tool: "memory_strategy",
    about: "op is the operation; store, recall and rate",
    must: ["store creates", "recall lists the active", "rate"],
  },
];

describe("Phase 2.7 — disclosed limitations stay disclosed", () => {
  const all = descriptions();

  for (const { tool, about, must } of DISCLOSURES) {
    it(`${tool} still discloses: ${about}`, () => {
      const desc = all.get(tool);
      expect(desc, `${tool} is not registered`).toBeDefined();
      for (const needle of must) {
        expect(
          desc!.toLowerCase(),
          `${tool}: the "${about}" caveat lost its "${needle}" — restore it or delete this entry with a reason`
        ).toContain(needle.toLowerCase());
      }
    });
  }

  it("checks a caveat for every tool this phase covers", () => {
    // A shrinking list would silently reduce coverage. Growing it is fine.
    expect(DISCLOSURES.length).toBeGreaterThanOrEqual(19);
    expect(new Set(DISCLOSURES.map((d) => d.tool)).size).toBe(DISCLOSURES.length);
  });

  it("the extractor really reads descriptions (teeth)", () => {
    // If `descriptions()` returned empty strings, every assertion above would
    // fail loudly rather than pass — but an empty MAP would make the loop
    // vacuous. Pin that it captured the whole registry.
    expect(all.size).toBeGreaterThanOrEqual(30);
    expect(all.get("memory_recall")?.length ?? 0).toBeGreaterThan(50);
  });
});
