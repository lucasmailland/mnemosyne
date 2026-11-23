/**
 * WP-6 — graph and primitive integrity, proven against real Postgres as the
 * production role (`mnemo_app_role` member: NOSUPERUSER NOBYPASSRLS, FORCE RLS).
 *
 * Every adapter call below goes through the restricted role, so an RLS mistake
 * (a query issued before `mnemo_set_workspace`) fails here the way it fails in
 * production instead of being masked by a superuser connection.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";
import {
  StorageConflictError,
  StorageNotFoundError,
  StorageValidationError,
} from "@mnemo-ai/types";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_USER = "mnemo_app_gi_test";
const APP_PASS = "mnemo_app_gi_test_pass";

const WS = "61616161-6161-4161-8161-616161616161";
const WS_OTHER = "62626262-6262-4262-8262-626262626262";

let container: StartedTestContainer;
let superSql: ReturnType<typeof postgres>;
let adapter: DrizzleStorageAdapter;
let closeApp: () => Promise<void>;
let superUrl: string;

async function makeUser(email: string): Promise<string> {
  const rows = await superSql<Array<{ id: string }>>`
    INSERT INTO mnemosyne.mnemo_user (email, personal_tenant_id)
    VALUES (${email}, ${crypto.randomUUID()}) RETURNING id`;
  return rows[0]!.id;
}

/**
 * An as-of instant taken from the row itself, never from the Node clock: rows are
 * stamped by Postgres `now()` on create and by the Node clock on supersede, and
 * the Docker VM's clock drifts tens of milliseconds from the host's in either
 * direction, so a Node-clock instant made these assertions depend on that
 * drift. One millisecond later because a JS Date drops the microseconds of a
 * Postgres timestamp; truncated, the instant could land before its own row.
 */
const justAfter = (stamp: Date): Date => new Date(stamp.getTime() + 1);

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASS, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  superUrl = `postgres://${PG_USER}:${PG_PASS}@${host}:${port}/${PG_DB}`;
  await migrate({ databaseUrl: superUrl, log: () => void 0 });

  superSql = postgres(superUrl, { onnotice: () => void 0, max: 3 });
  await superSql.unsafe(`
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
    GRANT USAGE ON SCHEMA public TO ${APP_USER};
  `);

  const appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG_DB}`;
  const { db, pgClient } = createDrizzleClient(appUrl);
  adapter = new DrizzleStorageAdapter(db, pgClient);
  closeApp = () => pgClient.end();
}, 180_000);

afterAll(async () => {
  await closeApp?.().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

// ─── PRIM-12 / CLIENTS-12 — hyperedges under RLS, deleted rows stay hidden ───

async function seedFacts(workspaceId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const f = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: `graph integrity fact ${crypto.randomUUID()}`,
      subject: "gi",
      kind: "other",
    });
    ids.push(f.id);
  }
  return ids;
}

describe("PRIM-12: hyperedges", () => {
  it("PATCH works under the restricted role and stays inside the caller's workspace", async () => {
    const members = await seedFacts(WS, 3);
    const h = await adapter.createHyperedge({
      workspaceId: WS,
      memberIds: members,
      label: "before",
    });
    const updated = await adapter.updateHyperedge(h.id, { workspaceId: WS, label: "after" });
    expect(updated.label).toBe("after");
    await expect(
      adapter.updateHyperedge(h.id, { workspaceId: WS_OTHER, label: "hijack" })
    ).rejects.toBeInstanceOf(StorageNotFoundError);
    expect((await adapter.getHyperedge(h.id, WS))?.label).toBe("after");
  });

  it("a deleted hyperedge disappears from get, list and the count; history is opt-in", async () => {
    const members = await seedFacts(WS, 3);
    const h = await adapter.createHyperedge({
      workspaceId: WS,
      memberIds: members,
      label: "doomed",
    });
    await adapter.archiveHyperedge(h.id, WS);

    expect(await adapter.getHyperedge(h.id, WS)).toBeNull();
    expect((await adapter.getHyperedge(h.id, WS, { includeClosed: true }))?.validTo).toBeInstanceOf(
      Date
    );

    const open = await adapter.queryHyperedges({ workspaceId: WS, label: "doomed" });
    expect(open.items).toHaveLength(0);
    expect(open.total).toBe(0);
    const all = await adapter.queryHyperedges({
      workspaceId: WS,
      label: "doomed",
      includeClosed: true,
    });
    expect(all.total).toBe(1);
  });

  it("a closed hyperedge cannot be patched", async () => {
    const h = await adapter.createHyperedge({ workspaceId: WS, memberIds: await seedFacts(WS, 3) });
    await adapter.archiveHyperedge(h.id, WS);
    await expect(
      adapter.updateHyperedge(h.id, { workspaceId: WS, label: "x" })
    ).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it("repeated members are rejected; verifyMembers rejects ids that do not exist", async () => {
    const [a, b] = await seedFacts(WS, 2);
    await expect(
      adapter.createHyperedge({ workspaceId: WS, memberIds: [a!, b!, a!] })
    ).rejects.toBeInstanceOf(StorageValidationError);
    await expect(
      adapter.createHyperedge({
        workspaceId: WS,
        memberIds: [a!, b!, crypto.randomUUID()],
        verifyMembers: true,
      })
    ).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it("a member above the caller's ceiling reads exactly like a missing one (no oracle, no ids)", async () => {
    const [a, b] = await seedFacts(WS, 2);
    const secret = await adapter.createDecision({
      workspaceId: WS,
      title: `restricted ${crypto.randomUUID()}`,
      body: "secret",
      kind: "decision",
      sensitivity: "restricted",
    });
    const attempt = (third: string, maxSensitivity?: "internal" | "restricted") =>
      adapter.createHyperedge({
        workspaceId: WS,
        memberIds: [a!, b!, third],
        verifyMembers: true,
        ...(maxSensitivity ? { maxSensitivity } : {}),
      });
    const missing = await attempt(crypto.randomUUID(), "internal").catch((e) => e as Error);
    const hidden = await attempt(secret.id, "internal").catch((e) => e as Error);
    expect(missing).toBeInstanceOf(StorageNotFoundError);
    expect(hidden).toBeInstanceOf(StorageNotFoundError);
    expect((hidden as Error).message).toBe((missing as Error).message);
    expect((hidden as Error).message).not.toContain(secret.id);
    // A caller whose ceiling covers it can use it.
    expect((await attempt(secret.id, "restricted")).memberIds).toContain(secret.id);
  });

  it("verifyMembers accepts existing members of mixed kinds and refuses another workspace's", async () => {
    const [fact] = await seedFacts(WS, 1);
    const ent = await adapter.createEntity({
      workspaceId: WS,
      name: `HE ${crypto.randomUUID()}`,
      kind: "concept",
    });
    const dec = await adapter.createDecision({
      workspaceId: WS,
      title: "d",
      body: "b",
      kind: "decision",
    });
    const ok = await adapter.createHyperedge({
      workspaceId: WS,
      memberIds: [fact!, ent.id, dec.id],
      verifyMembers: true,
    });
    expect(ok.memberIds).toHaveLength(3);
    const [foreign] = await seedFacts(WS_OTHER, 1);
    await expect(
      adapter.createHyperedge({
        workspaceId: WS,
        memberIds: [fact!, ent.id, foreign!],
        verifyMembers: true,
      })
    ).rejects.toBeInstanceOf(StorageNotFoundError);
  });
});

// ─── PRIM-12 / PRIM-13 — relations ──────────────────────────────────────────

describe("PRIM-12 / PRIM-13: relations", () => {
  // Integration decision (WP-6 / WP-11 reviews): current graph reads are
  // open-only by default; history is an explicit opt-out or a point in time.
  it("the default hides a closed relation; openOnly:false and validAt still read history", async () => {
    const [a, b] = await seedFacts(WS, 2);
    const rel = await adapter.createRelation({
      workspaceId: WS,
      sourceId: a!,
      sourceType: "fact",
      targetId: b!,
      targetType: "fact",
      verb: "related",
    });
    const whileOpen = justAfter(rel.validFrom);
    await new Promise((r) => setTimeout(r, 25)); // the close lands well after whileOpen
    expect(await adapter.closeRelation(rel.id, WS)).toBe(true);
    expect(await adapter.getRelations({ workspaceId: WS, sourceId: a! })).toHaveLength(0);
    const open = await adapter.getRelations({ workspaceId: WS, sourceId: a!, openOnly: true });
    expect(open).toHaveLength(0);
    const history = await adapter.getRelations({ workspaceId: WS, sourceId: a!, openOnly: false });
    expect(history.map((r) => r.id)).toEqual([rel.id]);
    const then = await adapter.getRelations({ workspaceId: WS, sourceId: a!, validAt: whileOpen });
    expect(then.map((r) => r.id)).toEqual([rel.id]);
  });

  it("a self-link is rejected with a typed error", async () => {
    const [a] = await seedFacts(WS, 1);
    await expect(
      adapter.createRelation({
        workspaceId: WS,
        sourceId: a!,
        sourceType: "fact",
        targetId: a!,
        targetType: "fact",
        verb: "related",
      })
    ).rejects.toBeInstanceOf(StorageValidationError);
    // The same id under two different kinds is two different nodes, not a self-loop.
    await adapter.createRelation({
      workspaceId: WS,
      sourceId: a!,
      sourceType: "fact",
      targetId: a!,
      targetType: "entity",
      verb: "related",
    });
  });

  it("the table itself refuses a self-loop (a writer that skips the repository)", async () => {
    await expect(
      superSql`INSERT INTO mnemosyne.mnemo_relation (id, workspace_id, source_kind, source_id, target_kind, target_id, relation)
               VALUES (${crypto.randomUUID()}, ${WS}, 'fact', 'same', 'fact', 'same', 'related')`
    ).rejects.toThrow(/mnemo_relation_no_self_loop/);
  });

  it("every non-hyperedge primitive kind can be a relation endpoint", async () => {
    const rel = await adapter.createRelation({
      workspaceId: WS,
      sourceId: crypto.randomUUID(),
      sourceType: "strategy",
      targetId: crypto.randomUUID(),
      targetType: "workflow",
      verb: "supersedes",
    });
    expect(rel.sourceType).toBe("strategy");
    expect(rel.targetType).toBe("workflow");
  });

  it("judgments by two actors on the same pair and verb both survive (no blanket uniqueness)", async () => {
    const [a, b] = await seedFacts(WS, 2);
    const mk = (markedByKind: "user" | "agent") =>
      adapter.createRelation({
        workspaceId: WS,
        sourceId: a!,
        sourceType: "fact",
        targetId: b!,
        targetType: "fact",
        verb: "conflicts_with",
        markedByKind,
      });
    await mk("user");
    await mk("agent");
    const rows = await adapter.getRelations({
      workspaceId: WS,
      sourceId: a!,
      verb: "conflicts_with",
    });
    expect(rows).toHaveLength(2);
  });
});

// ─── Validity stamps come from the database clock ───────────────────────────

describe("validity stamps: a close never lands before its row's valid_from", () => {
  // Rows are created with DEFAULT now() on the database clock. Closes used to
  // be stamped with the Node clock, so a server clock behind the database's
  // closed a fresh row before it began: a 500 from the tstzrange indexes on
  // facts and decisions, a negative interval elsewhere. Five seconds behind
  // makes the old behavior certain.
  it("every archive/supersede path stamps with the database clock", async () => {
    const closers: Array<{ table: string; close: () => Promise<string> }> = [
      {
        table: "mnemo_fact",
        close: async () => {
          const [id] = await seedFacts(WS, 1);
          await adapter.archiveFact(id!, WS);
          return id!;
        },
      },
      {
        table: "mnemo_decision",
        close: async () => {
          const d = await adapter.createDecision({
            workspaceId: WS,
            kind: "decision",
            title: "clock",
            body: "b",
          });
          await adapter.archiveDecision(d.id, WS);
          return d.id;
        },
      },
      {
        table: "mnemo_entity",
        close: async () => {
          const e = await adapter.createEntity({
            workspaceId: WS,
            name: `Clock ${crypto.randomUUID()}`,
            kind: "concept",
          });
          await adapter.supersedeEntity({
            workspaceId: WS,
            id: e.id,
            successor: { linkedUserId: null },
          });
          return e.id;
        },
      },
      {
        table: "mnemo_episode",
        close: async () => {
          const e = await adapter.createEpisode({
            workspaceId: WS,
            title: "clock",
            narrative: "n",
            occurredAt: new Date("2026-01-01T00:00:00Z"),
          });
          await adapter.archiveEpisode(e.id, WS);
          return e.id;
        },
      },
      {
        table: "mnemo_strategy",
        close: async () => {
          const st = await adapter.createStrategy({ workspaceId: WS, trigger: "t", action: "a" });
          await adapter.archiveStrategy(st.id, WS);
          return st.id;
        },
      },
      {
        table: "mnemo_workflow",
        close: async () => {
          const w = await adapter.createWorkflow({
            workspaceId: WS,
            name: `clock ${crypto.randomUUID()}`,
            steps: [{ order: 1, action: "a", expectedDurationMs: 1 }],
          });
          await adapter.archiveWorkflow(w.id, WS);
          return w.id;
        },
      },
      {
        table: "mnemo_skill",
        close: async () => {
          const sk = await adapter.createSkill({
            workspaceId: WS,
            name: `clock ${crypto.randomUUID()}`,
            promptTemplate: "p",
          });
          await adapter.archiveSkill(sk.id, WS);
          return sk.id;
        },
      },
      {
        table: "mnemo_task",
        close: async () => {
          const t = await adapter.createTask({
            workspaceId: WS,
            title: "clock",
            assignedTo: "agent",
          });
          await adapter.archiveTask(t.id, WS);
          return t.id;
        },
      },
      {
        table: "mnemo_reasoning",
        close: async () => {
          const r = await adapter.createReasoning({
            workspaceId: WS,
            question: "clock",
            chain: [{ step: 1, reasoning: "r" }],
            conclusion: "c",
          });
          await adapter.archiveReasoning(r.id, WS);
          return r.id;
        },
      },
      {
        table: "mnemo_hyperedge",
        close: async () => {
          const h = await adapter.createHyperedge({
            workspaceId: WS,
            memberIds: await seedFacts(WS, 3),
          });
          await adapter.archiveHyperedge(h.id, WS);
          return h.id;
        },
      },
    ];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 5_000); // determinism-ok: the Node clock 5 s behind the database's is the fixture
    try {
      for (const { table, close } of closers) {
        const id = await close();
        const rows = await superSql.unsafe(
          `SELECT valid_from <= valid_to AS ordered FROM mnemosyne.${table} WHERE id = $1`,
          [id]
        );
        expect({ table, ordered: rows[0]?.ordered }).toEqual({ table, ordered: true });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("validity stamps: the other close paths, with the Node clock 5 s behind", () => {
  const ordered = async (table: string, id: string, from = "valid_from", to = "valid_to") => {
    const rows = await superSql.unsafe(
      `SELECT ${from} <= ${to} AS ordered FROM mnemosyne.${table} WHERE id = $1`,
      [id]
    );
    return { table, id, ordered: rows[0]?.ordered };
  };
  const behind = async (
    run: () => Promise<Array<{ table: string; id: string; ordered: unknown }>>
  ) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 5_000); // determinism-ok: the Node clock 5 s behind the database's is the fixture
    try {
      for (const r of await run()) expect(r).toEqual({ ...r, ordered: true });
    } finally {
      vi.useRealTimers();
    }
  };

  it("supersedeDecision, strategy supersedesId, resolveConflict, a consolidation merge and a webhook update", async () => {
    await behind(async () => {
      const decision = (title: string) =>
        adapter.createDecision({ workspaceId: WS, kind: "decision", title, body: "b" });
      const oldDecision = await decision(`clock old ${crypto.randomUUID()}`);
      const newDecision = await decision(`clock new ${crypto.randomUUID()}`);
      await adapter.supersedeDecision({
        workspaceId: WS,
        id: oldDecision.id,
        supersededById: newDecision.id,
      });

      const oldStrategy = await adapter.createStrategy({
        workspaceId: WS,
        trigger: "clock old",
        action: "a",
      });
      await adapter.createStrategy({
        workspaceId: WS,
        trigger: "clock new",
        action: "a",
        supersedesId: oldStrategy.id,
      });

      const [a, b] = await seedFacts(WS, 2);
      const conflict = await adapter.createRelation({
        workspaceId: WS,
        sourceId: a!,
        sourceType: "fact",
        targetId: b!,
        targetType: "fact",
        verb: "conflicts_with",
      });
      await adapter.resolveConflict({
        workspaceId: WS,
        relationId: conflict.id,
        sourceId: a!,
        sourceKind: "fact",
        targetId: b!,
        targetKind: "fact",
        action: "supersede_a",
      });

      const [survivor, absorbed] = await seedFacts(WS, 2);
      await adapter.applyConsolidationMerge({
        operationId: `clock-${crypto.randomUUID()}`,
        workspaceId: WS,
        survivorId: survivor!,
        absorbedFactIds: [absorbed!],
        leaseExpiresAt: new Date(Date.now() + 3_600_000), // determinism-ok: the faked Node clock (5 s behind) is the fixture
      });

      const hook = await adapter.createWebhookEndpoint({
        id: crypto.randomUUID(),
        workspaceId: WS,
        url: "https://example.com/hook",
        events: ["fact.created"],
        secretHash: "h",
      });
      await adapter.updateWebhookEndpoint(hook.id, WS, { isActive: false });

      return [
        await ordered("mnemo_decision", oldDecision.id),
        await ordered("mnemo_strategy", oldStrategy.id),
        await ordered("mnemo_fact", a!),
        await ordered("mnemo_fact", absorbed!),
        await ordered("mnemo_webhook_endpoint", hook.id, "created_at", "updated_at"),
      ];
    });
  });

  it("a caller-given validTo (updateFact, updateStrategy, updateDecision) never lands before valid_from", async () => {
    await behind(async () => {
      const [fact] = await seedFacts(WS, 1);
      await adapter.updateFact(fact!, WS, { validTo: new Date() }); // determinism-ok: the faked Node clock (5 s behind) is the fixture
      const strategy = await adapter.createStrategy({
        workspaceId: WS,
        trigger: "clock patch",
        action: "a",
      });
      await adapter.updateStrategy(strategy.id, { workspaceId: WS, validTo: new Date() }); // determinism-ok: the faked Node clock (5 s behind) is the fixture
      const decision = await adapter.createDecision({
        workspaceId: WS,
        kind: "decision",
        title: `clock patch ${crypto.randomUUID()}`,
        body: "b",
      });
      await adapter.updateDecision(decision.id, { workspaceId: WS, validTo: new Date() }); // determinism-ok: the faked Node clock (5 s behind) is the fixture
      return [
        await ordered("mnemo_fact", fact!),
        await ordered("mnemo_strategy", strategy.id),
        await ordered("mnemo_decision", decision.id),
        await ordered("mnemo_decision", decision.id, "valid_to", "updated_at"),
      ];
    });
  });
});

// ─── PRIM-11 — strategy supersession closes the predecessor ─────────────────

const strat = (workspaceId: string, trigger: string, extra: Record<string, unknown> = {}) =>
  adapter.createStrategy({ workspaceId, trigger, action: `do ${trigger}`, ...extra });

describe("PRIM-11: strategy supersedesId", () => {
  it("closes the predecessor, keeps the successor active and records one lineage edge", async () => {
    const old = await strat(WS, "when A (old)");
    const next = await strat(WS, "when A (new)", { supersedesId: old.id });
    expect(next.status).toBe("active");

    const closed = await adapter.getStrategy(old.id, WS);
    expect(closed?.status).toBe("superseded");
    expect(closed?.validTo).toBeInstanceOf(Date);

    const rels = await adapter.getRelations({ workspaceId: WS, sourceId: next.id });
    expect(rels.map((r) => [r.verb, r.targetId, r.sourceType, r.targetType])).toEqual([
      ["supersedes", old.id, "strategy", "strategy"],
    ]);
    const active = await adapter.queryStrategies({ workspaceId: WS, status: "active" });
    expect(active.items.map((x) => x.id)).toContain(next.id);
    expect(active.items.map((x) => x.id)).not.toContain(old.id);
  });

  it("a missing or foreign predecessor is a not-found and creates nothing", async () => {
    const foreign = await strat(WS_OTHER, "foreign strategy");
    const before = (await adapter.queryStrategies({ workspaceId: WS, limit: 500 })).total;
    await expect(strat(WS, "orphan", { supersedesId: crypto.randomUUID() })).rejects.toBeInstanceOf(
      StorageNotFoundError
    );
    await expect(strat(WS, "orphan 2", { supersedesId: foreign.id })).rejects.toBeInstanceOf(
      StorageNotFoundError
    );
    expect((await adapter.queryStrategies({ workspaceId: WS, limit: 500 })).total).toBe(before);
    expect((await adapter.getStrategy(foreign.id, WS_OTHER))?.status).toBe("active");
  });

  it("an already superseded predecessor conflicts; concurrent replacements: one wins", async () => {
    const old = await strat(WS, "race base");
    await strat(WS, "race first", { supersedesId: old.id });
    await expect(strat(WS, "race second", { supersedesId: old.id })).rejects.toBeInstanceOf(
      StorageConflictError
    );

    const base = await strat(WS, "race base 2");
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) => strat(WS, `race c${i}`, { supersedesId: base.id }))
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const edges = await adapter.getRelations({ workspaceId: WS, targetId: base.id });
    expect(edges).toHaveLength(1);
  });
});

// ─── PRIM-18 — decision lifecycle ───────────────────────────────────────────

const dec = (workspaceId: string, title: string, extra: Record<string, unknown> = {}) =>
  adapter.createDecision({
    workspaceId,
    title,
    body: `body of ${title}`,
    kind: "decision",
    ...extra,
  });

describe("PRIM-18: decision supersession", () => {
  it("closes the predecessor (validTo set), points at the successor and records lineage", async () => {
    const old = await dec(WS, "old choice");
    const next = await dec(WS, "new choice");
    const done = await adapter.supersedeDecision({
      workspaceId: WS,
      id: old.id,
      supersededById: next.id,
    });
    expect(done.status).toBe("superseded");
    expect(done.supersededById).toBe(next.id);
    expect(done.validTo).toBeInstanceOf(Date);
    const rels = await adapter.getRelations({
      workspaceId: WS,
      sourceId: next.id,
      verb: "supersedes",
    });
    expect(rels.map((r) => [r.targetId, r.sourceType, r.targetType])).toEqual([
      [old.id, "decision", "decision"],
    ]);
  });

  it("is idempotent for the same successor and conflicts for a different one", async () => {
    const old = await dec(WS, "idem old");
    const a = await dec(WS, "idem a");
    const b = await dec(WS, "idem b");
    await adapter.supersedeDecision({ workspaceId: WS, id: old.id, supersededById: a.id });
    const again = await adapter.supersedeDecision({
      workspaceId: WS,
      id: old.id,
      supersededById: a.id,
    });
    expect(again.supersededById).toBe(a.id);
    expect(
      await adapter.getRelations({ workspaceId: WS, sourceId: a.id, verb: "supersedes" })
    ).toHaveLength(1);
    await expect(
      adapter.supersedeDecision({ workspaceId: WS, id: old.id, supersededById: b.id })
    ).rejects.toBeInstanceOf(StorageConflictError);
  });

  it("rejects a self-supersede and a missing or foreign successor, changing nothing", async () => {
    const d = await dec(WS, "self");
    await expect(
      adapter.supersedeDecision({ workspaceId: WS, id: d.id, supersededById: d.id })
    ).rejects.toBeInstanceOf(StorageValidationError);
    await expect(
      adapter.supersedeDecision({ workspaceId: WS, id: d.id, supersededById: crypto.randomUUID() })
    ).rejects.toBeInstanceOf(StorageNotFoundError);
    const foreign = await dec(WS_OTHER, "foreign decision");
    await expect(
      adapter.supersedeDecision({ workspaceId: WS, id: d.id, supersededById: foreign.id })
    ).rejects.toBeInstanceOf(StorageNotFoundError);
    await expect(
      adapter.supersedeDecision({ workspaceId: WS, id: crypto.randomUUID(), supersededById: d.id })
    ).rejects.toBeInstanceOf(StorageNotFoundError);
    const still = await adapter.getDecision(d.id, WS);
    expect(still?.status).toBe("active");
    expect(still?.validTo).toBeUndefined();
  });

  it("a closed successor is refused, which also rules out cycles", async () => {
    const a = await dec(WS, "cycle a");
    const b = await dec(WS, "cycle b");
    await adapter.supersedeDecision({ workspaceId: WS, id: a.id, supersededById: b.id });
    // b is active, a is superseded: pointing b back at a would close the loop.
    await expect(
      adapter.supersedeDecision({ workspaceId: WS, id: b.id, supersededById: a.id })
    ).rejects.toBeInstanceOf(StorageConflictError);
  });

  it("a topic-key revision persists scopeRef and conversationId when given (AGENTSIM-7 support)", async () => {
    const created = await dec(WS, "scoped", { topicKey: "scoped-topic" });
    expect(created.scopeRef).toBeUndefined();
    const merged = await adapter.mergeDecisionByTopicKey({
      workspaceId: WS,
      topicKey: "scoped-topic",
      title: "scoped",
      body: "revised body",
      kind: "decision",
      scopeRef: "project-x",
      conversationId: "session-42",
    });
    expect(merged?.scopeRef).toBe("project-x");
    expect(merged?.conversationId).toBe("session-42");
    // Omitted fields are left alone on the next revision.
    const again = await adapter.mergeDecisionByTopicKey({
      workspaceId: WS,
      topicKey: "scoped-topic",
      title: "scoped",
      body: "revised twice",
      kind: "decision",
    });
    expect(again?.scopeRef).toBe("project-x");
  });

  it("a topic-key revision keeps the replaced text recoverable", async () => {
    const created = await dec(WS, "history v1", { topicKey: "history-topic" });
    const rev = (n: number) =>
      adapter.mergeDecisionByTopicKey({
        workspaceId: WS,
        topicKey: "history-topic",
        title: `history v${n}`,
        body: `body v${n}`,
        kind: "decision",
        metadata: { note: `n${n}` },
      });
    await rev(2);
    const last = await rev(3);
    expect(last?.id).toBe(created.id);
    expect(last?.body).toBe("body v3");
    const revisions = (
      last?.metadata as { revisions: Array<{ title: string; body: string; revision: number }> }
    ).revisions;
    expect(revisions.map((r) => [r.revision, r.title])).toEqual([
      [1, "history v1"],
      [2, "history v2"],
    ]);
    expect(revisions[0]!.body).toBe("body of history v1");
    expect(last?.metadata).toMatchObject({ note: "n3" });
  });

  it("updateDecision closing a decision always stamps validTo", async () => {
    const d = await dec(WS, "closed via update");
    const updated = await adapter.updateDecision(d.id, { workspaceId: WS, status: "withdrawn" });
    expect(updated.validTo).toBeInstanceOf(Date);
  });
});

// ─── PRIM-2 — entity uniqueness only covers live rows ───────────────────────

describe("PRIM-2: entity name uniqueness covers live rows only", () => {
  it("a forgotten (closed) entity's name can be created again", async () => {
    const first = await adapter.createEntity({
      workspaceId: WS,
      name: "Quartz Corp",
      kind: "organization",
    });
    await adapter.archiveEntity(first.id, WS);
    const second = await adapter.createEntity({
      workspaceId: WS,
      name: "Quartz Corp",
      kind: "organization",
    });
    expect(second.id).not.toBe(first.id);
  });

  it("a duplicate live create is a StorageConflictError, not a raw driver error", async () => {
    await adapter.createEntity({ workspaceId: WS, name: "Dup Inc", kind: "organization" });
    await expect(
      adapter.createEntity({ workspaceId: WS, name: "Dup Inc", kind: "organization" })
    ).rejects.toBeInstanceOf(StorageConflictError);
  });

  it("renaming into a live name is a StorageConflictError", async () => {
    await adapter.createEntity({ workspaceId: WS, name: "Taken Name", kind: "project" });
    const other = await adapter.createEntity({
      workspaceId: WS,
      name: "Other Name",
      kind: "project",
    });
    await expect(
      adapter.updateEntity(other.id, { workspaceId: WS, name: "Taken Name" })
    ).rejects.toBeInstanceOf(StorageConflictError);
  });

  it("the same name in another workspace or kind is not a duplicate", async () => {
    await adapter.createEntity({ workspaceId: WS, name: "Shared Name", kind: "place" });
    await adapter.createEntity({ workspaceId: WS_OTHER, name: "Shared Name", kind: "place" });
    await adapter.createEntity({ workspaceId: WS, name: "Shared Name", kind: "concept" });
  });

  it("supersedeEntity closes, links the successor and records lineage atomically", async () => {
    const userId = await makeUser("link-ok@example.com");
    const original = await adapter.createEntity({
      workspaceId: WS,
      name: "Ada Person",
      kind: "person",
    });
    const successor = await adapter.supersedeEntity({
      workspaceId: WS,
      id: original.id,
      successor: { linkedUserId: userId },
    });
    expect(successor.id).not.toBe(original.id);
    expect(successor.name).toBe("Ada Person");
    expect(successor.linkedUserId).toBe(userId);

    const closed = await adapter.getEntity(original.id, WS);
    expect(closed?.validTo).toBeInstanceOf(Date);

    const live = await adapter.queryEntities({
      workspaceId: WS,
      name: "Ada Person",
      validAt: justAfter(successor.validFrom),
    });
    expect(live.items.map((e) => e.id)).toEqual([successor.id]);

    const rels = await adapter.getRelations({ workspaceId: WS, sourceId: successor.id });
    expect(rels.map((r) => [r.verb, r.targetId])).toEqual([["supersedes", original.id]]);
  });

  it("unlinking (successor without a link) keeps the entity alive", async () => {
    const userId = await makeUser("unlink@example.com");
    const original = await adapter.createEntity({
      workspaceId: WS,
      name: "Linus Person",
      kind: "person",
    });
    const linked = await adapter.supersedeEntity({
      workspaceId: WS,
      id: original.id,
      successor: { linkedUserId: userId },
    });
    const unlinked = await adapter.supersedeEntity({
      workspaceId: WS,
      id: linked.id,
      successor: { linkedUserId: null },
    });
    expect(unlinked.linkedUserId ?? null).toBeNull();
    const live = await adapter.queryEntities({
      workspaceId: WS,
      name: "Linus Person",
      validAt: justAfter(unlinked.validFrom),
    });
    expect(live.items.map((e) => e.id)).toEqual([unlinked.id]);
  });

  it("superseding an already-closed entity conflicts and creates nothing", async () => {
    const original = await adapter.createEntity({
      workspaceId: WS,
      name: "Closed Twice",
      kind: "concept",
    });
    await adapter.supersedeEntity({
      workspaceId: WS,
      id: original.id,
      successor: { linkedUserId: null },
    });
    const before = await adapter.queryEntities({ workspaceId: WS, name: "Closed Twice" });
    await expect(
      adapter.supersedeEntity({
        workspaceId: WS,
        id: original.id,
        successor: { linkedUserId: null },
      })
    ).rejects.toBeInstanceOf(StorageConflictError);
    const after = await adapter.queryEntities({ workspaceId: WS, name: "Closed Twice" });
    expect(after.total).toBe(before.total);
  });

  it("superseding an entity of another workspace is a not-found", async () => {
    const foreign = await adapter.createEntity({
      workspaceId: WS_OTHER,
      name: "Foreign One",
      kind: "concept",
    });
    await expect(
      adapter.supersedeEntity({
        workspaceId: WS,
        id: foreign.id,
        successor: { linkedUserId: null },
      })
    ).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it("a failing successor insert rolls the close back (the entity is not lost)", async () => {
    const userId = await makeUser("rollback@example.com");
    const holder = await adapter.createEntity({ workspaceId: WS, name: "Holder", kind: "person" });
    await adapter.supersedeEntity({
      workspaceId: WS,
      id: holder.id,
      successor: { linkedUserId: userId },
    });
    // The user is already linked to a LIVE entity: linking a second one violates
    // uq_mnemo_entity_linked_user_live on the successor insert, after the close.
    const victim = await adapter.createEntity({ workspaceId: WS, name: "Victim", kind: "person" });
    await expect(
      adapter.supersedeEntity({
        workspaceId: WS,
        id: victim.id,
        successor: { linkedUserId: userId },
      })
    ).rejects.toBeInstanceOf(StorageConflictError);
    const still = await adapter.getEntity(victim.id, WS);
    expect(still?.validTo).toBeUndefined();
    const rels = await adapter.getRelations({ workspaceId: WS, targetId: victim.id });
    expect(rels).toHaveLength(0);
  });

  it("concurrent supersedes of one entity: exactly one wins, one live version remains", async () => {
    const original = await adapter.createEntity({
      workspaceId: WS,
      name: "Raced",
      kind: "concept",
    });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        adapter.supersedeEntity({
          workspaceId: WS,
          id: original.id,
          successor: { linkedUserId: null },
        })
      )
    );
    const won = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(won).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(StorageConflictError);
    }
    const live = await adapter.queryEntities({
      workspaceId: WS,
      name: "Raced",
      validAt: justAfter(won[0]!.validFrom),
    });
    expect(live.items).toHaveLength(1);
  });

  it("concurrent duplicate creates leave one live row", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        adapter.createEntity({ workspaceId: WS, name: "Parallel Dup", kind: "concept" })
      )
    );
    const won = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(won).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(StorageConflictError);
    }
    const live = await adapter.queryEntities({
      workspaceId: WS,
      name: "Parallel Dup",
      validAt: justAfter(won[0]!.validFrom),
    });
    expect(live.items).toHaveLength(1);
  });

  it("migration 0045: down is atomic and refuses before mutating; up re-runs and repairs open self-loops", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { splitSqlStatements } = await import("../sql-split.js");
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations", "baseline");
    const down = await readFile(join(dir, "0045_graph_integrity.down.sql"), "utf8");
    const up = await readFile(join(dir, "0045_graph_integrity.sql"), "utf8");
    // The up is a no-transaction file: each statement runs on its own (CONCURRENTLY).
    expect(up).toMatch(/migrate:no-transaction/);
    const runUp = async () => {
      for (const stmt of splitSqlStatements(up)) await superSql.unsafe(stmt);
    };
    const constraintCount = async (name: string) =>
      (await superSql`SELECT 1 FROM pg_constraint WHERE conname = ${name}`).length;

    // Existing closed duplicates are legal after 0045; the down must rename them, not fail.
    const a = await adapter.createEntity({ workspaceId: WS, name: "Down Dup", kind: "concept" });
    await adapter.archiveEntity(a.id, WS);
    await adapter.createEntity({ workspaceId: WS, name: "Down Dup", kind: "concept" });

    // While relations over the widened kinds exist the down refuses BEFORE changing anything,
    // even when the script is fed statement by statement (psql -f autocommit).
    // The down carries its own BEGIN/COMMIT, so it needs a single-connection client (like psql).
    const runDown = async () => {
      const one = postgres(superUrl, { onnotice: () => void 0, max: 1 });
      try {
        await one.unsafe(down);
      } finally {
        await one.end().catch(() => void 0);
      }
    };
    await expect(runDown()).rejects.toThrow(/remove them first/);
    expect(await constraintCount("mnemo_entity_workspace_id_name_kind_key")).toBe(0);
    expect(await constraintCount("mnemo_relation_no_self_loop")).toBe(1);

    // ...and goes through once they are gone.
    await superSql`DELETE FROM mnemosyne.mnemo_relation WHERE source_kind NOT IN ('fact','decision','entity','episode') OR target_kind NOT IN ('fact','decision','entity','episode')`;
    await runDown();
    const dups =
      await superSql`SELECT count(*)::int AS n FROM mnemosyne.mnemo_entity WHERE name LIKE 'Down Dup%'`;
    expect(dups[0]!.n).toBe(2); // the closed row was renamed, not dropped
    expect(await constraintCount("mnemo_entity_workspace_id_name_kind_key")).toBe(1);
    expect(await constraintCount("mnemo_relation_no_self_loop")).toBe(0);

    // An OPEN self-loop written under the old schema: the up closes it, validates, and
    // later retraction paths never hit the CHECK.
    const loopId = crypto.randomUUID();
    await superSql`INSERT INTO mnemosyne.mnemo_relation (id, workspace_id, source_kind, source_id, target_kind, target_id, relation)
                   VALUES (${loopId}, ${WS}, 'fact', 'old-loop', 'fact', 'old-loop', 'related')`;
    await runUp();
    await runUp(); // idempotent
    const loop = await superSql`SELECT valid_to FROM mnemosyne.mnemo_relation WHERE id = ${loopId}`;
    expect(loop[0]!.valid_to).not.toBeNull();
    expect(await adapter.closeRelation(loopId, WS)).toBe(false); // already closed: 404 path, not a 500
    const validated =
      await superSql`SELECT convalidated FROM pg_constraint WHERE conname IN ('mnemo_relation_no_self_loop','mnemo_relation_source_kind_check','mnemo_relation_target_kind_check')`;
    expect(validated.map((r) => r.convalidated)).toEqual([true, true, true]);
    const idx =
      await superSql`SELECT indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'uq_mnemo_entity_live_name_kind'`;
    expect(idx.map((r) => r.indisvalid)).toEqual([true]);
    expect(await constraintCount("mnemo_entity_workspace_id_name_kind_key")).toBe(0);
  });
});
