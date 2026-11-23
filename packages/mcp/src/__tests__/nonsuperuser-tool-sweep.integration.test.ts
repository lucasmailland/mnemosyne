/**
 * Plan 7.3 (audit 2026-11-22) — the happy path of every primitive family the
 * MCP full profile writes, with the server connected as the production app
 * role (`nonSuperuser`). Each family lives in its own tables, its own RLS
 * policies and its own grants; the superuser harness could never see a missing
 * one. A permission error here is a finding, not a test to loosen.
 *
 * Ported from the 2026-11-22 audit script `mcp-live.mjs` (not in the repo) and
 * `mcp-live2.mjs` (the "ok" calls). Not ported, and why:
 * - argument validation (1001 chars, empty, limit 26, bogus kind/verb,
 *   malformed id): the child's Zod schemas, covered by the contracts suite
 *   (contracts/*.test.ts) and schema-contracts.test.ts;
 * - episode collapse with a real LLM, recall of what it extracted: no LLM in
 *   this harness by design (no network);
 * - memory_relocate and the workspace tools: the isolation file covers the
 *   cross-workspace refusals;
 * - sensitivity on task/event/entity/reasoning (F1, F9): server unit tests from
 *   the audit fixes (17088ebe, b75f0a40).
 *
 * Requires Docker + the builds listed in `./harness/live-surface.ts`.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, startLiveSurface, type LiveSurface } from "./harness/live-surface.js";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let surface: LiveSurface;
let mcp: Client;
const ids: Record<string, string> = {};

beforeAll(async () => {
  surface = await startLiveSurface({ nonSuperuser: true });
  mcp = surface.mcp;
}, 180_000);

afterAll(async () => {
  await surface?.close();
}, 60_000);

/** Calls a tool, fails the test on a tool error, returns the first id it reports. */
async function ok(name: string, args: Record<string, unknown>): Promise<string | undefined> {
  const r = await callTool(mcp, name, args);
  expect(r.isError, `${name} ${JSON.stringify(args)}: ${r.text}`).toBe(false);
  const structuredId = r.structured?.id;
  return typeof structuredId === "string" ? structuredId : r.text.match(UUID)?.[0];
}

describe("every primitive family through the non-superuser role", () => {
  it("facts: pin, unpin, compare, relate, judge, self_edit", async () => {
    ids.f1 = (await ok("memory_remember", {
      statement: "Promo codes expire 15 minutes after they are issued.",
      subject: "promo codes",
      subtype: "policy",
    }))!;
    ids.f2 = (await ok("memory_remember", {
      statement: "Promo codes stay valid for 24 hours after they are issued.",
      subject: "promo codes",
      subtype: "policy",
    }))!;
    await ok("memory_pin", { factId: ids.f1 });
    await ok("memory_pin", { factId: ids.f1, unpin: true });
    await ok("memory_compare", { factIdA: ids.f1, factIdB: ids.f2 });
    await ok("memory_relate", {
      action: "create",
      sourceKind: "fact",
      from: ids.f1,
      targetKind: "fact",
      to: ids.f2,
      verb: "conflicts_with",
      reason: "contradictory expiry",
    });
    await ok("memory_relate", { action: "list", from: ids.f1 });
    await ok("memory_judge", { action: "list" });
    await ok("memory_self_edit", { action: "strengthen", target: ids.f1, reason: "confirmed" });
    await ok("memory_self_edit", { action: "weaken", target: ids.f2, reason: "contradicted" });
  });

  it("entities, strategies, workflows, skills", async () => {
    ids.entity = (await ok("memory_entity", {
      action: "create",
      name: "Larkspur Robotics",
      kind: "organization",
      aliases: ["Larkspur"],
    }))!;
    await ok("memory_entity", { action: "get", id: ids.entity });
    await ok("memory_entity", {
      action: "update",
      id: ids.entity,
      description: "Robotics customer",
    });
    await ok("memory_entity", { action: "list", q: "Larkspur" });

    ids.strategy = (await ok("memory_strategy", {
      op: "create",
      trigger: "A migration fails checksum validation",
      action: "Stop and diff the file against git history",
    }))!;
    await ok("memory_strategy", { op: "rate", id: ids.strategy, outcome: "success" });
    await ok("memory_strategy", { op: "recall", context: "migration checksum mismatch" });

    ids.workflow = (await ok("memory_workflow", {
      action: "create",
      name: "Release a patch version",
      steps: [
        { order: 1, action: "Run the full sweep" },
        { order: 2, action: "Publish the packages" },
      ],
    }))!;
    await ok("memory_workflow", { action: "update", id: ids.workflow, status: "active" });

    ids.skill = (await ok("memory_skill", {
      action: "create",
      name: "summarise-incident",
      promptTemplate: "Summarise the incident {{id}} in five bullets.",
      tags: ["ops"],
    }))!;
    await ok("memory_skill", { action: "update", id: ids.skill, tags: ["ops", "incident"] });
  });

  it("tasks, events, reasoning, hyperedges, reminders", async () => {
    ids.task = (await ok("memory_task", {
      action: "create",
      title: "Rotate the staging API key",
      priority: "high",
      assignedTo: "agent:ops",
    }))!;
    await ok("memory_task", { action: "patch", id: ids.task, status: "in_progress" });
    await ok("memory_task", { action: "complete", id: ids.task, outcome: "rotated" });

    ids.event = (await ok("memory_event", {
      action: "create",
      type: "system",
      name: "Deploy finished",
      description: "Rolled out to staging",
      occurredAt: new Date().toISOString(), // determinism-ok: an event happening now; value not asserted
      source: "ci",
    }))!;
    await ok("memory_event", {
      action: "annotate",
      id: ids.event,
      author: "audit",
      content: "clean",
    });

    ids.reasoning = (await ok("memory_reasoning", {
      action: "record",
      question: "Why did recall return the same facts for every query?",
      chain: [{ step: 1, reasoning: "Untested facts decayed below the worth gate" }],
      conclusion: "Untested must mean never judged",
    }))!;
    await ok("memory_reasoning", {
      action: "feedback",
      reasoningId: ids.reasoning,
      outcome: "success",
    });

    await ok("memory_hyperedge", {
      action: "create",
      memberIds: [ids.f1, ids.f2, ids.entity],
      label: "customer-rules",
    });

    ids.reminder = (await ok("memory_remind_when", {
      action: "create",
      content: "Check the certificate expiry",
      triggerAt: new Date(Date.now() + 3_600_000).toISOString(), // determinism-ok: a reminder must be in the future
    }))!;
    await ok("memory_remind_when", { action: "list", status: "all" });
    await ok("memory_remind_when", { action: "dismiss", id: ids.reminder });

    const recalled = await callTool(mcp, "memory_recall", {
      query: "rotate staging api key deploy",
      kinds: ["task", "event", "reasoning"],
    });
    expect(recalled.isError, recalled.text).toBe(false);
  });

  it("sessions: start, turns, scratch, feedback, discard", async () => {
    ids.session = (await ok("memory_episode_start", { agentId: "audit-agent", label: "sweep" }))!;
    await ok("memory_session", {
      action: "turn",
      sessionId: ids.session,
      role: "user",
      content: "We decided the checkout timeout is 90 seconds.",
    });
    await ok("memory_session", { action: "get", sessionId: ids.session });
    await ok("memory_session", { action: "list" });
    await ok("memory_session", {
      action: "scratch",
      sessionId: ids.session,
      content: "scratch note",
    });
    await ok("memory_session", { action: "feedback", sessionId: ids.session, rating: "up" });
    await ok("memory_session", { action: "discard", sessionId: ids.session });
  });

  it("read and maintenance tools: timeline, stats, introspect, anticipate, compose, consolidate", async () => {
    await ok("memory_timeline", { limit: 20 });
    await ok("memory_stats", {});
    await ok("memory_introspect", { aspect: "all" });
    await ok("memory_anticipate", { context: "preparing an email to Larkspur", limit: 5 });
    await ok("memory_compose", { action: "list" });
    await ok("memory_suggest_topic_key", { subject: "staging database", body: "port of staging" });
    await ok("memory_consolidate", { mode: "fast", dryRun: false });
    await ok("memory_status", {});
    await ok("memory_doctor", {});
  });

  it("forget of every other kind, then purge", async () => {
    await ok("memory_forget", { primitiveId: ids.entity, kind: "entity" });
    await ok("memory_forget", { primitiveId: ids.strategy, kind: "strategy" });
    await ok("memory_forget", { primitiveId: ids.task, kind: "task" });
    await ok("memory_forget", { factId: ids.f2, reason: "superseded" });
    await ok("memory_purge", { action: "fact", factId: ids.f2, confirm: true });
  });
});
