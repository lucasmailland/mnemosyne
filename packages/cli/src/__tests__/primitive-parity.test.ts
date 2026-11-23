/**
 * CLI-PARITY-1 — coverage for the primitive/relation/operational-tool
 * commands added to close the CLI-vs-MCP/API parity gap (decide, entity,
 * relate, strategy, workflow, skill, reasoning, hyperedge, episode, pin,
 * unpin, timeline, judge, purge, consolidate, remind, plus the extended
 * events/tasks subcommands).
 *
 * Same fetch-stub approach as cli.test.ts: stub global fetch, assert on
 * the request path/method/body, don't spawn a real process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isBanner } from "./helpers/banner-lines.js";
import { COMMANDS } from "../commands.js";
import { expectRequest } from "./helpers/expect-request.js";

describe("CLI primitive-parity commands", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];
  let consoleLogs: string[] = [];
  let consoleErrors: string[] = [];
  let exitCode: number | undefined;

  const mockConfig = { url: "http://localhost:3939", apiKey: "mk_test_abc_xyz" };

  function stubJson(body: unknown): void {
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: opts?.method === "POST" ? 201 : 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    });
  }

  beforeEach(() => {
    fetchCalls = [];
    consoleLogs = [];
    consoleErrors = [];
    exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) consoleLogs.push(line);
      consoleErrors.push(line);
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("all new commands are registered", () => {
    const names = Object.keys(COMMANDS);
    for (const cmd of [
      "decide",
      "entity",
      "relate",
      "strategy",
      "workflow",
      "skill",
      "reasoning",
      "hyperedge",
      "episode",
      "pin",
      "unpin",
      "timeline",
      "judge",
      "purge",
      "consolidate",
      "remind",
    ]) {
      expect(names).toContain(cmd);
    }
  });

  // ── decide ───────────────────────────────────────────────────────────────

  it("decide create posts to /decisions", async () => {
    stubJson({ id: "dec_1", kind: "architecture", title: "t", body: "b" });
    await COMMANDS.decide!(
      ["create", "--kind", "architecture", "--title", "t", "--body", "b"],
      mockConfig
    );
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/decisions" });
  });

  it("decide list gets /decisions", async () => {
    stubJson({ items: [] });
    await COMMANDS.decide!(["list"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/decisions" });
  });

  it("decide create without required flags exits 2", async () => {
    await expect(COMMANDS.decide!(["create"], mockConfig)).rejects.toThrow();
    expect(exitCode).toBe(2);
  });

  // PR3 (cli-uimode-full-coverage): decide is the spec's representative
  // category-C (raw-JSON) command — 3-mode assertions per the "Test Coverage
  // Per Mode Per Category" requirement. The JSON payload must keep printing
  // unconditionally; only the status line varies/suppresses by mode.
  it("delight prints the tagged write status line (⬇️) before the JSON payload", async () => {
    stubJson({ id: "dec_1", kind: "architecture", title: "t", body: "b" });
    await COMMANDS.decide!(["create", "--kind", "architecture", "--title", "t", "--body", "b"], {
      ...mockConfig,
      uiMode: "delight",
    });
    expect(consoleLogs[0]).toBe('🧠 ⬇️  [mnemosyne] Decision recorded: "t" (dec_1)');
    expect(consoleLogs[1]).toBe(
      JSON.stringify({ id: "dec_1", kind: "architecture", title: "t", body: "b" }, null, 2)
    );
  });

  it("verbose prints a plain ✓ confirmation before the JSON payload", async () => {
    stubJson({ id: "dec_1", kind: "architecture", title: "t", body: "b" });
    await COMMANDS.decide!(["create", "--kind", "architecture", "--title", "t", "--body", "b"], {
      ...mockConfig,
      uiMode: "verbose",
    });
    expect(consoleLogs[0]).toBe("✓ Decision recorded: t (dec_1)");
    expect(consoleLogs[1]).toBe(
      JSON.stringify({ id: "dec_1", kind: "architecture", title: "t", body: "b" }, null, 2)
    );
  });

  it("quiet suppresses the status line but keeps the JSON payload", async () => {
    stubJson({ id: "dec_1", kind: "architecture", title: "t", body: "b" });
    await COMMANDS.decide!(["create", "--kind", "architecture", "--title", "t", "--body", "b"], {
      ...mockConfig,
      uiMode: "quiet",
    });
    expect(consoleLogs).toEqual([
      JSON.stringify({ id: "dec_1", kind: "architecture", title: "t", body: "b" }, null, 2),
    ]);
  });

  // PR7 (cli-uimode-full-coverage): decide list is this batch's representative
  // D2 per-primitive read command — 3-mode assertions per the "Test Coverage
  // Per Mode Per Category" requirement. The JSON payload must keep printing
  // unconditionally; only the delight-mode read header (⬆️, `pending: true`)
  // appears/disappears by mode, matching the D1 `list`/`recall` precedent.
  it("decide list: delight prints the tagged read header (⬆️) before the payload", async () => {
    stubJson({ items: [{ id: "dec_1" }] });
    await COMMANDS.decide!(["list"], { ...mockConfig, uiMode: "delight" });
    expect(consoleLogs[0]).toBe("🧠 ⬆️  [mnemosyne] Listing decisions…\n");
  });

  it("decide list: verbose prints no header — the payload is the confirmation", async () => {
    stubJson({ items: [{ id: "dec_1" }] });
    await COMMANDS.decide!(["list"], { ...mockConfig, uiMode: "verbose" });
    expect(consoleLogs.some((l) => l.startsWith("🧠") || l.startsWith("✓"))).toBe(false);
  });

  it("decide list: quiet prints no header — the payload is unaffected", async () => {
    stubJson({ items: [{ id: "dec_1" }] });
    await COMMANDS.decide!(["list"], { ...mockConfig, uiMode: "quiet" });
    expect(consoleLogs.some((l) => l.startsWith("🧠") || l.startsWith("✓"))).toBe(false);
  });

  // ── entity ───────────────────────────────────────────────────────────────

  it("entity create posts to /entities", async () => {
    stubJson({ id: "ent_1", name: "Postgres", kind: "project" });
    await COMMANDS.entity!(["create", "--name", "Postgres", "--kind", "project"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/entities" });
  });

  it("entity facts gets /entities/:id/facts", async () => {
    stubJson({ entity: { id: "ent_1" }, facts: [] });
    await COMMANDS.entity!(["facts", "ent_1"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/entities/ent_1/facts" });
  });

  it("entity link-user posts { userId } to /entities/:id/link-user", async () => {
    stubJson({ id: "ent_1", kind: "person", linkedUserId: "user-1" });
    await COMMANDS.entity!(["link-user", "ent_1", "user-1"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/entities/ent_1/link-user" });
    expect(JSON.parse(String(fetchCalls[0]?.opts?.body))).toEqual({ userId: "user-1" });
  });

  it("entity link-user without <userId> prints usage and exits 2", async () => {
    await expect(COMMANDS.entity!(["link-user", "ent_1"], mockConfig)).rejects.toThrow(
      "process.exit(2)"
    );
    expect(exitCode).toBe(2);
    expect(fetchCalls).toHaveLength(0);
  });

  it("entity unlink-user sends DELETE to /entities/:id/link-user", async () => {
    stubJson({ id: "ent_2", kind: "person", linkedUserId: null });
    await COMMANDS.entity!(["unlink-user", "ent_1"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "DELETE", pathname: "/entities/ent_1/link-user" });
  });

  // PR3 (cli-uimode-full-coverage): unlink-user is the "remove"-style entity
  // mutation in this batch — destructive kind, 🗑️ in delight, per spec's
  // "destructive and admin ops use distinct emoji" scenario.
  it("entity unlink-user prints the destructive status line (🗑️) in delight", async () => {
    stubJson({ id: "ent_1", kind: "person", linkedUserId: null });
    await COMMANDS.entity!(["unlink-user", "ent_1"], { ...mockConfig, uiMode: "delight" });
    expect(consoleLogs[0]).toBe("🧠 🗑️  [mnemosyne] Entity unlinked from user (ent_1)");
  });

  // ── relate ───────────────────────────────────────────────────────────────

  it("relate creates a relation with a locked verb", async () => {
    stubJson({ id: "rel_1" });
    await COMMANDS.relate!(["fact", "f1", "part_of", "entity", "e1"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/relations" });
    const body = JSON.parse(String(fetchCalls[0]?.opts?.body));
    expect(body.relation).toBe("part_of");
  });

  it("relate rejects an unknown verb", async () => {
    await expect(
      COMMANDS.relate!(["fact", "f1", "not_a_real_verb", "entity", "e1"], mockConfig)
    ).rejects.toThrow();
    expect(exitCode).toBe(2);
  });

  it("relate list gets /relations", async () => {
    stubJson({ items: [] });
    await COMMANDS.relate!(["list"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/relations" });
  });

  it("relate history posts to /relations/traverse with only the lineage verbs", async () => {
    stubJson({ nodes: [], edges: [] });
    await COMMANDS.relate!(["history", "decision", "dec_1"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/relations/traverse" });
    const body = JSON.parse(String(fetchCalls[0]?.opts?.body));
    expect(body).toMatchObject({
      rootId: "dec_1",
      rootKind: "decision",
      maxDepth: 5,
      verbs: ["supersedes", "derived_from"],
    });
  });

  it("relate history without sourceKind/id exits 2 and makes no request", async () => {
    await expect(COMMANDS.relate!(["history"], mockConfig)).rejects.toThrow();
    expect(exitCode).toBe(2);
    expect(fetchCalls.length).toBe(0);
  });

  // ── strategy ─────────────────────────────────────────────────────────────

  it("strategy create posts to /strategies", async () => {
    stubJson({ id: "strat_1" });
    await COMMANDS.strategy!(["create", "--trigger", "X happens", "--action", "do Y"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/strategies" });
  });

  it("strategy rate posts to /strategies/:id/rate", async () => {
    stubJson({ id: "strat_1" });
    await COMMANDS.strategy!(["rate", "strat_1", "success"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/strategies/strat_1/rate" });
  });

  // PR4 (cli-uimode-full-coverage): strategy create is this batch's
  // representative category-C2 (procedural) command — 3-mode assertions per
  // the "Test Coverage Per Mode Per Category" requirement. The JSON payload
  // must keep printing unconditionally; only the status line varies/suppresses.
  it("delight prints the tagged write status line (⬇️) before the JSON payload", async () => {
    stubJson({ id: "strat_1", trigger: "X happens", action: "do Y" });
    await COMMANDS.strategy!(["create", "--trigger", "X happens", "--action", "do Y"], {
      ...mockConfig,
      uiMode: "delight",
    });
    expect(consoleLogs[0]).toBe('🧠 ⬇️  [mnemosyne] Strategy created: "X happens" (strat_1)');
    expect(consoleLogs[1]).toBe(
      JSON.stringify({ id: "strat_1", trigger: "X happens", action: "do Y" }, null, 2)
    );
  });

  it("verbose prints a plain ✓ confirmation before the JSON payload", async () => {
    stubJson({ id: "strat_1", trigger: "X happens", action: "do Y" });
    await COMMANDS.strategy!(["create", "--trigger", "X happens", "--action", "do Y"], {
      ...mockConfig,
      uiMode: "verbose",
    });
    expect(consoleLogs[0]).toBe("✓ Strategy created: X happens (strat_1)");
    expect(consoleLogs[1]).toBe(
      JSON.stringify({ id: "strat_1", trigger: "X happens", action: "do Y" }, null, 2)
    );
  });

  it("quiet suppresses the status line but keeps the JSON payload", async () => {
    stubJson({ id: "strat_1", trigger: "X happens", action: "do Y" });
    await COMMANDS.strategy!(["create", "--trigger", "X happens", "--action", "do Y"], {
      ...mockConfig,
      uiMode: "quiet",
    });
    expect(consoleLogs).toEqual([
      JSON.stringify({ id: "strat_1", trigger: "X happens", action: "do Y" }, null, 2),
    ]);
  });

  // ── workflow ─────────────────────────────────────────────────────────────

  it("workflow create posts to /workflows", async () => {
    stubJson({ id: "wf_1" });
    await COMMANDS.workflow!(
      ["create", "--name", "Release", "--steps", '["step 1","step 2"]'],
      mockConfig
    );
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/workflows" });
  });

  it("workflow create transforms a plain string --steps array into valid WorkflowStep objects", async () => {
    // Regression guard: the server's WorkflowStep schema requires
    // {order, action, expectedDurationMs} — sending the flat string array
    // verbatim (the CLI's original behavior) gets a 400 from a real server.
    stubJson({ id: "wf_1" });
    await COMMANDS.workflow!(
      ["create", "--name", "Release", "--steps", '["step 1","step 2"]'],
      mockConfig
    );
    const body = JSON.parse(String(fetchCalls[0]?.opts?.body));
    expect(body.steps).toEqual([
      { order: 0, action: "step 1", expectedDurationMs: 0 },
      { order: 1, action: "step 2", expectedDurationMs: 0 },
    ]);
  });

  it("workflow create accepts full WorkflowStep objects and preserves their fields", async () => {
    stubJson({ id: "wf_1" });
    await COMMANDS.workflow!(
      [
        "create",
        "--name",
        "Release",
        "--steps",
        '[{"order":5,"action":"tag","expectedDurationMs":120,"condition":"on main","tools":["git"]}]',
      ],
      mockConfig
    );
    const body = JSON.parse(String(fetchCalls[0]?.opts?.body));
    expect(body.steps).toEqual([
      { order: 5, action: "tag", expectedDurationMs: 120, condition: "on main", tools: ["git"] },
    ]);
  });

  it("workflow create rejects invalid --steps JSON", async () => {
    await expect(
      COMMANDS.workflow!(["create", "--name", "Release", "--steps", "not json"], mockConfig)
    ).rejects.toThrow();
    expect(exitCode).toBe(2);
  });

  it("workflow create rejects a step object missing 'action'", async () => {
    await expect(
      COMMANDS.workflow!(
        ["create", "--name", "Release", "--steps", '[{"expectedDurationMs":10}]'],
        mockConfig
      )
    ).rejects.toThrow();
    expect(exitCode).toBe(2);
  });

  // ── skill ────────────────────────────────────────────────────────────────

  it("skill create posts to /skills", async () => {
    stubJson({ id: "skl_1" });
    await COMMANDS.skill!(["create", "--name", "write-migration", "--prompt", "Do X"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/skills" });
  });

  // ── reasoning ────────────────────────────────────────────────────────────

  it("reasoning create posts to /reasoning", async () => {
    stubJson({ id: "rsn_1" });
    await COMMANDS.reasoning!(
      [
        "create",
        "--question",
        "how?",
        "--conclusion",
        "like this",
        "--chain",
        '[{"step":1,"reasoning":"..."}]',
      ],
      mockConfig
    );
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/reasoning" });
  });

  it("reasoning resolve posts to /reasoning/resolve", async () => {
    stubJson({ cacheHit: false });
    await COMMANDS.reasoning!(["resolve", "how", "to", "paginate"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/reasoning/resolve" });
  });

  // ── hyperedge ────────────────────────────────────────────────────────────

  it("hyperedge create posts to /hyperedges with >=3 members", async () => {
    stubJson({ id: "hyp_1" });
    await COMMANDS.hyperedge!(["create", "--members", "a,b,c"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/hyperedges" });
  });

  it("hyperedge create rejects fewer than 3 members", async () => {
    await expect(COMMANDS.hyperedge!(["create", "--members", "a,b"], mockConfig)).rejects.toThrow();
    expect(exitCode).toBe(2);
  });

  // ── episode ──────────────────────────────────────────────────────────────

  it("episode start posts to /session/start", async () => {
    stubJson({ id: "sess_1" });
    await COMMANDS.episode!(["start"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/session/start" });
  });

  it("episode collapse posts to /session/:id/collapse", async () => {
    stubJson({ accepted: true });
    await COMMANDS.episode!(["collapse", "sess_1", "--hint", "wrap it up"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/session/sess_1/collapse" });
  });

  it("reports a skipped episode without claiming it collapsed", async () => {
    stubJson({ sessionId: "sess_1", status: "skipped", skipReason: "too_few_turns" });
    await COMMANDS.episode!(["collapse", "sess_1"], mockConfig);
    expect(consoleLogs.join(" ")).toContain("Episode skipped: too_few_turns");
    expect(consoleLogs.join(" ")).not.toContain("Episode collapsed");
  });

  it("reports a failed episode without claiming it collapsed", async () => {
    stubJson({ sessionId: "sess_1", status: "failed" });
    await COMMANDS.episode!(["collapse", "sess_1"], mockConfig);
    expect(consoleLogs.join(" ")).toContain("Episode collapse failed");
    expect(consoleLogs.join(" ")).not.toContain("Episode collapsed");
  });

  // ── pin / unpin ──────────────────────────────────────────────────────────

  it("pin posts to /facts/:id/pin with pinned:true", async () => {
    stubJson({ pinned: true });
    await COMMANDS.pin!(["f1"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/facts/f1/pin" });
    expect(JSON.parse(String(fetchCalls[0]?.opts?.body)).pinned).toBe(true);
  });

  it("unpin posts to /facts/:id/pin with pinned:false", async () => {
    stubJson({ pinned: false });
    await COMMANDS.unpin!(["f1"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/facts/f1/pin" });
    expect(JSON.parse(String(fetchCalls[0]?.opts?.body)).pinned).toBe(false);
  });

  // ── timeline ─────────────────────────────────────────────────────────────

  it("timeline gets /timeline", async () => {
    stubJson({ events: [], nextCursor: null });
    await COMMANDS.timeline!([], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/timeline" });
  });

  // ── judge ────────────────────────────────────────────────────────────────

  it("judge (no args) gets /conflicts", async () => {
    stubJson({ pairs: [] });
    await COMMANDS.judge!([], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/conflicts" });
  });

  it("judge resolve posts to /conflicts/:id/resolve", async () => {
    stubJson({ resolved: true });
    await COMMANDS.judge!(["resolve", "rel_1", "keep_both"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/conflicts/rel_1/resolve" });
  });

  it("judge resolve rejects an invalid action", async () => {
    await expect(
      COMMANDS.judge!(["resolve", "rel_1", "not_a_real_action"], mockConfig)
    ).rejects.toThrow();
    expect(exitCode).toBe(2);
  });

  it("judge resolve merge without --merged-statement exits 2 and makes no request (client-side pre-validation)", async () => {
    await expect(COMMANDS.judge!(["resolve", "rel_1", "merge"], mockConfig)).rejects.toThrow();
    expect(exitCode).toBe(2);
    expect(fetchCalls.length).toBe(0);
  });

  it("judge resolve merge with --merged-statement posts to /conflicts/:id/resolve", async () => {
    stubJson({ resolved: true, mergedFactId: "fact_new" });
    await COMMANDS.judge!(
      ["resolve", "rel_1", "merge", "--merged-statement", "the corrected unified statement"],
      mockConfig
    );
    expectRequest(fetchCalls[0]!, { pathname: "/conflicts/rel_1/resolve" });
    const body = JSON.parse(String(fetchCalls[0]?.opts?.body));
    expect(body).toMatchObject({
      action: "merge",
      mergedStatement: "the corrected unified statement",
    });
  });

  // ── purge ────────────────────────────────────────────────────────────────

  it("purge without --confirm exits 2 and makes no request", async () => {
    await expect(COMMANDS.purge!(["f1"], mockConfig)).rejects.toThrow();
    expect(exitCode).toBe(2);
    expect(fetchCalls.length).toBe(0);
  });

  it("purge <id> --confirm hard-deletes one fact", async () => {
    stubJson({ deleted: true });
    await COMMANDS.purge!(["f1", "--confirm"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/facts/f1/hard" });
  });

  it("purge --all-closed --confirm bulk-deletes closed facts", async () => {
    stubJson({ deleted: 3 });
    await COMMANDS.purge!(["--all-closed", "--confirm"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/facts/purge" });
    expect(consoleLogs.some((l) => l.includes("3"))).toBe(true);
  });

  // PR2 (cli-uimode-full-coverage): purge is a destructive-kind command —
  // delight status line uses the closed destructive emoji (🗑️).
  it("purge <id> --confirm delight status line uses the destructive emoji (🗑️)", async () => {
    stubJson({ deleted: true });
    await COMMANDS.purge!(["f1", "--confirm"], { ...mockConfig, uiMode: "delight" });
    expect(consoleLogs.some((l) => l.includes("🗑️"))).toBe(true);
  });

  // ── erase ────────────────────────────────────────────────────────────────

  it("erase without a repeated --confirm exits 2 and makes no request", async () => {
    await expect(COMMANDS.erase!(["--actor", "key:k1"], mockConfig)).rejects.toThrow();
    expect(exitCode).toBe(2);
    await expect(
      COMMANDS.erase!(["--actor", "key:k1", "--user", "u1", "--confirm", "u1"], mockConfig)
    ).rejects.toThrow();
    expect(fetchCalls.length).toBe(0);
  });

  it("erase --user <id> --confirm <id> posts the subject to /admin/erasure", async () => {
    stubJson({ subject: { kind: "user", id: "u1" }, keysDestroyed: 2 });
    await COMMANDS.erase!(["--user", "u1", "--confirm", "u1"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/admin/erasure" });
    expect(JSON.parse(String(fetchCalls[0]?.opts?.body))).toEqual({ userId: "u1", confirm: "u1" });
  });

  // ── consolidate ──────────────────────────────────────────────────────────

  it("consolidate posts to /consolidation/trigger", async () => {
    stubJson({ status: "queued" });
    await COMMANDS.consolidate!([], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/consolidation/trigger" });
  });

  // ── remind ───────────────────────────────────────────────────────────────

  it("remind create posts to /reminders", async () => {
    stubJson({ id: "rem_1" });
    await COMMANDS.remind!(
      ["create", "--content", "check the migration", "--trigger-at", "2026-08-01T00:00:00Z"],
      mockConfig
    );
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/reminders" });
  });

  it("remind create without condition or trigger-at exits 2", async () => {
    await expect(COMMANDS.remind!(["create", "--content", "x"], mockConfig)).rejects.toThrow();
    expect(exitCode).toBe(2);
  });

  it("remind list gets /reminders", async () => {
    stubJson({ reminders: [] });
    await COMMANDS.remind!(["list"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/reminders" });
  });

  it("remind dismiss deletes /reminders/:id", async () => {
    stubJson({});
    await COMMANDS.remind!(["dismiss", "rem_1"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "DELETE", pathname: "/reminders/rem_1" });
  });

  // ── extended events/tasks ────────────────────────────────────────────────

  it("events create posts to /events", async () => {
    stubJson({ id: "evt_1" });
    await COMMANDS.events!(
      [
        "create",
        "--type",
        "system",
        "--name",
        "deploy.success",
        "--description",
        "v3 deployed",
        "--source",
        "ci",
      ],
      mockConfig
    );
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/events" });
  });

  it("events with no subcommand still lists (backward compatible)", async () => {
    stubJson({ items: [] });
    await COMMANDS.events!([], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "GET", pathname: "/events" });
  });

  it("tasks create posts to /tasks", async () => {
    stubJson({ id: "task_1" });
    await COMMANDS.tasks!(["create", "--title", "Fix bug", "--assigned-to", "agent_1"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/tasks" });
  });

  it("tasks delegate posts to /tasks/:id/delegate", async () => {
    stubJson({ id: "task_1" });
    await COMMANDS.tasks!(["delegate", "task_1", "--to", "agent_2"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/tasks/task_1/delegate" });
  });

  it("tasks with no subcommand still lists (backward compatible)", async () => {
    stubJson({ items: [] });
    await COMMANDS.tasks!([], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "GET", pathname: "/tasks" });
  });

  // PR5 (cli-uimode-full-coverage): tasks create is this batch's
  // representative category-C3 (tasks/events/curation) command — 3-mode
  // assertions per the "Test Coverage Per Mode Per Category" requirement.
  // The JSON payload must keep printing unconditionally; only the status
  // line varies/suppresses by mode. No new StatusKind categorization is
  // introduced this batch (every PR5 site — tasks create/update/delegate,
  // events create, pin, unpin, judge resolve — is kind: "write", already
  // emoji-pinned (⬇️) by PR1-4's tests), so the "emoji-pinning spot check
  // for any newly-introduced categorization" clause is N/A — flagged
  // explicitly rather than silently skipped.
  it("delight prints the tagged write status line (⬇️) before the JSON payload", async () => {
    stubJson({ id: "task_1", title: "Fix bug", assignedTo: "agent_1" });
    await COMMANDS.tasks!(["create", "--title", "Fix bug", "--assigned-to", "agent_1"], {
      ...mockConfig,
      uiMode: "delight",
    });
    expect(consoleLogs[0]).toBe('🧠 ⬇️  [mnemosyne] Task created: "Fix bug" (task_1)');
    expect(consoleLogs[1]).toBe(
      JSON.stringify({ id: "task_1", title: "Fix bug", assignedTo: "agent_1" }, null, 2)
    );
  });

  it("verbose prints a plain ✓ confirmation before the JSON payload", async () => {
    stubJson({ id: "task_1", title: "Fix bug", assignedTo: "agent_1" });
    await COMMANDS.tasks!(["create", "--title", "Fix bug", "--assigned-to", "agent_1"], {
      ...mockConfig,
      uiMode: "verbose",
    });
    expect(consoleLogs[0]).toBe("✓ Task created: Fix bug (task_1)");
    expect(consoleLogs[1]).toBe(
      JSON.stringify({ id: "task_1", title: "Fix bug", assignedTo: "agent_1" }, null, 2)
    );
  });

  it("quiet suppresses the status line but keeps the JSON payload", async () => {
    stubJson({ id: "task_1", title: "Fix bug", assignedTo: "agent_1" });
    await COMMANDS.tasks!(["create", "--title", "Fix bug", "--assigned-to", "agent_1"], {
      ...mockConfig,
      uiMode: "quiet",
    });
    expect(consoleLogs).toEqual([
      JSON.stringify({ id: "task_1", title: "Fix bug", assignedTo: "agent_1" }, null, 2),
    ]);
  });
});
