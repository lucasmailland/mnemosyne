// StorageAdapter contract test suite — TASK-15001, TESTING_STRATEGY.md §4.
//
// Pass any StorageAdapter implementation to runStorageAdapterContractTests()
// and it will verify the core behavioral contract that ALL adapters must uphold.
// Run against InMemoryStorageAdapter for fast unit coverage and against
// DrizzleStorageAdapter for integration coverage.

import { describe, it, expect, beforeEach } from "vitest";
import type { StorageAdapter } from "../ports.js";
import { RECALLABLE_KINDS, PRIMITIVE_TEXT_PROJECTION } from "../indexing.js";

export function runStorageAdapterContractTests(
  makeAdapter: () => StorageAdapter | Promise<StorageAdapter>
): void {
  let adapter: StorageAdapter;

  beforeEach(async () => {
    adapter = await makeAdapter();
  });

  describe("StorageAdapter contract", () => {
    // ── Facts ──────────────────────────────────────────────────────────────────

    it("creates a fact and retrieves it by ID", async () => {
      const fact = await adapter.createFact({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        scope: "global",
        statement: "Paris is the capital of France",
        subject: "Paris",
        kind: "other",
        confidence: 0.95,
      });

      expect(fact.id).toBeTruthy();
      expect(fact.statement).toBe("Paris is the capital of France");
      expect(fact.confidence).toBe(0.95);

      const retrieved = await adapter.getFact(fact.id, "11111111-1111-1111-1111-111111111111");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(fact.id);
    });

    it("returns null when getting a fact that does not exist", async () => {
      const result = await adapter.getFact(
        "nonexistent-id",
        "11111111-1111-1111-1111-111111111111"
      );
      expect(result).toBeNull();
    });

    it("updates a fact and reflects the change on retrieval", async () => {
      const fact = await adapter.createFact({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        scope: "global",
        statement: "Original statement",
        subject: "test",
        kind: "other",
      });

      const updated = await adapter.updateFact(fact.id, "11111111-1111-1111-1111-111111111111", {
        confidence: 0.42,
      });
      expect(updated?.confidence).toBe(0.42);

      const retrieved = await adapter.getFact(fact.id, "11111111-1111-1111-1111-111111111111");
      expect(retrieved?.confidence).toBe(0.42);
    });

    it("returns null and leaves the fact unchanged for a foreign workspace update", async () => {
      const fact = await adapter.createFact({
        workspaceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        scope: "global",
        statement: "workspace B statement",
        subject: "test",
        kind: "other",
        confidence: 0.8,
      });

      const updated = await adapter.updateFact(fact.id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", {
        confidence: 0.1,
      });

      expect(updated).toBeNull();
      const retrieved = await adapter.getFact(fact.id, fact.workspaceId);
      expect(retrieved?.confidence).toBe(0.8);
    });

    it("queryFacts filters by workspaceId", async () => {
      await adapter.createFact({
        workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        scope: "global",
        statement: "fact in workspace A",
        subject: "A",
        kind: "other",
      });
      await adapter.createFact({
        workspaceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        scope: "global",
        statement: "fact in workspace B",
        subject: "B",
        kind: "other",
      });

      const { items } = await adapter.queryFacts({
        workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      });
      expect(items.every((f) => f.workspaceId === "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBe(
        true
      );
      expect(items.some((f) => f.workspaceId === "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")).toBe(
        false
      );
    });

    it("RLS: workspace A cannot read workspace B facts", async () => {
      const factB = await adapter.createFact({
        workspaceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        scope: "global",
        statement: "secret fact",
        subject: "secret",
        kind: "other",
      });

      // Cross-workspace getFact must return null
      const cross = await adapter.getFact(factB.id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
      expect(cross).toBeNull();

      // Cross-workspace queryFacts must not include factB
      const { items } = await adapter.queryFacts({
        workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      });
      expect(items.find((f) => f.id === factB.id)).toBeUndefined();
    });

    it("createFact: defaults sensitivity to 'internal' and respects explicit value", async () => {
      const defaulted = await adapter.createFact({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        scope: "global",
        statement: "sensitivity default check",
        subject: "test",
        kind: "other",
      });
      expect(defaulted.sensitivity).toBe("internal");

      const explicit = await adapter.createFact({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        scope: "global",
        statement: "sensitivity explicit check",
        subject: "test",
        kind: "other",
        sensitivity: "public",
      });
      expect(explicit.sensitivity).toBe("public");

      const fetched = await adapter.getFact(explicit.id, explicit.workspaceId);
      expect(fetched?.sensitivity).toBe("public");
    });

    it("worth is a decimal (no integer truncation)", async () => {
      const fact = await adapter.createFact({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        scope: "global",
        statement: "decimal confidence test",
        subject: "test",
        kind: "other",
        confidence: 0.333,
      });

      expect(fact.confidence).toBeCloseTo(0.333, 3);
    });

    // ── Outbox ─────────────────────────────────────────────────────────────────

    it("outbox entries are observable after fact creation", async () => {
      const adapterWithOutbox = adapter as StorageAdapter & {
        outbox?: unknown[];
      };
      if (!Array.isArray(adapterWithOutbox.outbox)) return; // integration adapters may not expose outbox

      const before = adapterWithOutbox.outbox.length;

      await adapter.createFact({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        scope: "global",
        statement: "outbox test",
        subject: "test",
        kind: "other",
      });

      expect(adapterWithOutbox.outbox.length).toBeGreaterThan(before);
    });

    // ── Recallable-kind indexing contract (make-primitives-recallable PR1) ────
    //
    // spec.md Requirement 1: "A kind declared recallable MUST have its
    // embedding and vector-index entry produced by the SAME transaction that
    // persists the row." A kind that is persisted but not indexed is a
    // CONTRACT VIOLATION, not a missing feature — this loop makes that
    // mechanical for every entry in RECALLABLE_KINDS, against both Drizzle
    // and InMemory. `claimOutbox` (not the InMemory-only `.outbox` array
    // used above) is the cross-adapter way to observe the entry: it's part
    // of the StorageAdapter port itself, so it works against a real
    // DrizzleStorageAdapter too.
    for (const kind of RECALLABLE_KINDS) {
      it(`enqueues a vector_upsert outbox entry carrying the registry's projected text on ${kind} creation`, async () => {
        const workspaceId = "44444444-4444-4444-4444-444444444444";
        const projection = PRIMITIVE_TEXT_PROJECTION[kind];

        // P65: this used to be `if (kind === "fact") … else createDecision(…)`,
        // which silently created a DECISION for every non-fact kind and then
        // looked for an outbox entry tagged with the kind it never created. It
        // passed only because fact and decision were the whole registry. One
        // creator per kind, so the loop tests what it claims to.
        let id: string;
        let rowValues: Record<string, string>;
        switch (kind) {
          case "fact": {
            rowValues = { statement: "recallable-kind contract statement" };
            const fact = await adapter.createFact({
              workspaceId,
              scope: "global",
              statement: rowValues["statement"]!,
              subject: "contract-test",
              kind: "other",
            });
            id = fact.id;
            break;
          }
          case "decision": {
            rowValues = {
              title: "Recallable-kind contract title",
              body: "Recallable-kind contract body",
            };
            const decision = await adapter.createDecision({
              workspaceId,
              kind: "decision",
              title: rowValues["title"]!,
              body: rowValues["body"]!,
            });
            id = decision.id;
            break;
          }
          case "strategy": {
            rowValues = {
              trigger: "when the contract suite runs",
              action: "index the strategy on write",
            };
            const strategy = await adapter.createStrategy({
              workspaceId,
              trigger: rowValues["trigger"]!,
              action: rowValues["action"]!,
            });
            id = strategy.id;
            break;
          }
          case "workflow": {
            rowValues = {
              name: "Recallable-kind contract workflow",
              description: "indexes on write like every other recallable kind",
            };
            const workflow = await adapter.createWorkflow({
              workspaceId,
              name: rowValues["name"]!,
              description: rowValues["description"]!,
              steps: [],
            });
            id = workflow.id;
            break;
          }
          case "skill": {
            rowValues = {
              name: "Recallable-kind contract skill",
              promptTemplate: "summarise the contract in one paragraph",
            };
            const skill = await adapter.createSkill({
              workspaceId,
              name: rowValues["name"]!,
              promptTemplate: rowValues["promptTemplate"]!,
            });
            id = skill.id;
            break;
          }
          case "episode": {
            rowValues = {
              title: "Recallable-kind contract episode",
              narrative: "the session in which the contract was exercised",
            };
            const episode = await adapter.createEpisode!({
              workspaceId,
              title: rowValues["title"]!,
              narrative: rowValues["narrative"]!,
              occurredAt: new Date(0),
            });
            id = episode.id;
            break;
          }
          case "task": {
            rowValues = {
              title: "Recallable-kind contract task",
              description: "index tasks on write like every other recallable kind",
            };
            const task = await adapter.createTask({
              workspaceId,
              title: rowValues["title"]!,
              description: rowValues["description"]!,
              assignedTo: "contract-runner",
            });
            id = task.id;
            break;
          }
          case "event": {
            rowValues = {
              name: "Recallable-kind contract event",
              description: "an immutable log line that is still searchable",
            };
            const event = await adapter.createEvent({
              workspaceId,
              type: "system",
              name: rowValues["name"]!,
              description: rowValues["description"]!,
              occurredAt: new Date(0),
              source: "contract-suite",
            });
            id = event.id;
            break;
          }
          case "reasoning": {
            rowValues = {
              question: "does the contract cover reasoning?",
              conclusion: "it does, once reasoning is a recallable kind",
            };
            const reasoning = await adapter.createReasoning({
              workspaceId,
              question: rowValues["question"]!,
              conclusion: rowValues["conclusion"]!,
              chain: [],
            });
            id = reasoning.id;
            break;
          }
          default: {
            // A new RECALLABLE_KIND with no creator here would otherwise be
            // "tested" by a branch that never runs. Fail loudly instead.
            throw new Error(
              `StorageAdapterContract: RECALLABLE_KINDS gained "${kind}" with no creator in this loop — add one.`
            );
          }
        }
        const expectedText = projection.fields
          .map((field) => rowValues[field])
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .join(projection.separator);

        // claimOutbox is DB-wide (no workspaceId param, mirrors the real
        // OutboxWorker) — a generous limit safely covers every row this
        // whole contract suite could have accumulated by this point.
        const claimed = await adapter.claimOutbox(1000);
        const entry = claimed.find(
          (e) =>
            e.eventType === "vector_upsert" &&
            (e.payload as { id?: string }).id === id &&
            (e.payload as { kind?: string }).kind === kind
        );
        expect(entry, `no vector_upsert outbox entry found for ${kind} id=${id}`).toBeDefined();
        expect((entry!.payload as { text?: string }).text).toBe(expectedText);
      });
    }

    // ── Decisions ─────────────────────────────────────────────────────────────

    it("creates and retrieves a decision", async () => {
      const d = await adapter.createDecision({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        kind: "decision",
        title: "Use Postgres",
        body: "We chose Postgres because of RLS support.",
      });

      expect(d.id).toBeTruthy();
      expect(d.revisionCount).toBe(1);
      const retrieved = await adapter.getDecision(d.id, "11111111-1111-1111-1111-111111111111");
      expect(retrieved?.title).toBe("Use Postgres");
    });

    // ── Episodes ──────────────────────────────────────────────────────────────

    it("creates and retrieves an episode", async () => {
      const ep = await adapter.createEpisode({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        title: "Planning session",
        narrative: "Discussed the roadmap for Q3.",
        occurredAt: new Date("2026-01-01"),
      });

      expect(ep.id).toBeTruthy();
      const retrieved = await adapter.getEpisode(ep.id, "11111111-1111-1111-1111-111111111111");
      expect(retrieved?.title).toBe("Planning session");
    });

    // ── Entities ──────────────────────────────────────────────────────────────

    it("creates and retrieves an entity", async () => {
      const entity = await adapter.createEntity({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        name: "Anthropic",
        kind: "organization",
      });

      expect(entity.id).toBeTruthy();
      const retrieved = await adapter.getEntity(entity.id, "11111111-1111-1111-1111-111111111111");
      expect(retrieved?.name).toBe("Anthropic");
    });

    it("getWorkspaceMode counts the workspace's live entities for graduation", async () => {
      if (!adapter.getWorkspaceMode || !adapter.setWorkspaceMode) return;
      const ws = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
      const other = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
      await adapter.setWorkspaceMode(ws, { mode: "learning" });
      const made = [];
      for (let i = 0; i < 3; i++)
        made.push(
          await adapter.createEntity({ workspaceId: ws, name: `live ${i}`, kind: "concept" })
        );
      await adapter.createEntity({ workspaceId: other, name: "elsewhere", kind: "concept" });
      await adapter.archiveEntity(made[0]!.id, ws);

      expect((await adapter.getWorkspaceMode(ws))?.entityCount).toBe(2);
    });

    // ── openOnly: the clock-free "current" filter ─────────────────────────────

    it("openOnly returns only rows whose validity interval is still open, for every listable kind", async () => {
      const ws = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
      type Kind = {
        name: string;
        create: () => Promise<{ id: string }>;
        archive: (id: string) => Promise<unknown>;
        list: () => Promise<{ items: Array<{ id: string }> }>;
      };
      const kinds: Kind[] = [
        {
          name: "entity",
          create: (() => {
            let n = 0;
            return () =>
              adapter.createEntity({ workspaceId: ws, name: `open-only ${++n}`, kind: "concept" });
          })(),
          archive: (id) => adapter.archiveEntity(id, ws),
          list: () => adapter.queryEntities({ workspaceId: ws, openOnly: true }),
        },
        {
          name: "decision",
          create: () =>
            adapter.createDecision({
              workspaceId: ws,
              kind: "decision",
              title: "open-only",
              body: "b",
            }),
          archive: (id) => adapter.archiveDecision(id, ws),
          list: () => adapter.queryDecisions({ workspaceId: ws, openOnly: true }),
        },
        {
          name: "strategy",
          create: () => adapter.createStrategy({ workspaceId: ws, trigger: "t", action: "a" }),
          archive: (id) => adapter.archiveStrategy(id, ws),
          list: () => adapter.queryStrategies({ workspaceId: ws, openOnly: true }),
        },
        {
          name: "workflow",
          create: () =>
            adapter.createWorkflow({
              workspaceId: ws,
              name: "open-only",
              steps: [{ order: 1, action: "a", expectedDurationMs: 1 }],
            }),
          archive: (id) => adapter.archiveWorkflow(id, ws),
          list: () => adapter.queryWorkflows({ workspaceId: ws, openOnly: true }),
        },
        {
          name: "skill",
          create: (() => {
            let n = 0;
            return () =>
              adapter.createSkill({
                workspaceId: ws,
                name: `open-only ${++n}`,
                promptTemplate: "p",
              });
          })(),
          archive: (id) => adapter.archiveSkill(id, ws),
          list: () => adapter.querySkills({ workspaceId: ws, openOnly: true }),
        },
        {
          name: "task",
          create: () =>
            adapter.createTask({ workspaceId: ws, title: "open-only", assignedTo: "agent" }),
          archive: (id) => adapter.archiveTask(id, ws),
          list: () => adapter.queryTasks({ workspaceId: ws, openOnly: true }),
        },
        {
          name: "reasoning",
          create: () =>
            adapter.createReasoning({
              workspaceId: ws,
              question: "open-only",
              chain: [{ step: 1, reasoning: "r" }],
              conclusion: "c",
            }),
          archive: (id) => adapter.archiveReasoning(id, ws),
          list: () => adapter.queryReasoning({ workspaceId: ws, openOnly: true }),
        },
      ];
      for (const kind of kinds) {
        const open = await kind.create();
        const closed = await kind.create();
        await kind.archive(closed.id);
        const ids = (await kind.list()).items.map((r) => r.id);
        expect({ kind: kind.name, ids }).toEqual({ kind: kind.name, ids: [open.id] });
      }
    });

    // ── Relations ─────────────────────────────────────────────────────────────

    it("creates a relation and retrieves it by sourceId", async () => {
      const fact1 = await adapter.createFact({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        scope: "global",
        statement: "A",
        subject: "A",
        kind: "other",
      });
      const fact2 = await adapter.createFact({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        scope: "global",
        statement: "B",
        subject: "B",
        kind: "other",
      });

      await adapter.createRelation({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        sourceId: fact1.id,
        sourceType: "fact",
        targetId: fact2.id,
        targetType: "fact",
        verb: "related",
        weight: 0.7,
      });

      const relations = await adapter.getRelations({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        sourceId: fact1.id,
      });
      expect(relations.length).toBeGreaterThanOrEqual(1);
      expect(relations[0]?.verb).toBe("related");
    });

    it("round-trips actorId/actorType on a relation when provided", async () => {
      // NOTE (p46 PR5): userId is deliberately NOT asserted here. Migration
      // 0025 added a real FK (mnemo_relation.user_id -> mnemo_user.id) that
      // InMemoryStorageAdapter doesn't enforce but DrizzleStorageAdapter
      // does — this shared, adapter-agnostic suite has no StorageAdapter
      // method to seed a real mnemo_user row, so a hardcoded literal userId
      // here (as this test originally had) passes against InMemory but
      // throws a real Postgres FK violation (23503) against Drizzle. The
      // userId round-trip, WITH a properly seeded user, is covered against
      // real Postgres for both write paths (v3 GraphRepository and
      // v2-legacy core/graph/relation.ts) in
      // relation-hyperedge-actor-id.integration.test.ts.
      const fact1 = await adapter.createFact({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        scope: "global",
        statement: "provenance A",
        subject: "provenance A",
        kind: "other",
      });
      const fact2 = await adapter.createFact({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        scope: "global",
        statement: "provenance B",
        subject: "provenance B",
        kind: "other",
      });

      await adapter.createRelation({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        sourceId: fact1.id,
        sourceType: "fact",
        targetId: fact2.id,
        targetType: "fact",
        verb: "related",
        actorId: "key:test-key-id",
        actorType: "agent",
      });

      const relations = await adapter.getRelations({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        sourceId: fact1.id,
        targetId: fact2.id,
      });
      const withProvenance = relations.find((r) => r.actorId === "key:test-key-id");
      expect(withProvenance).toBeDefined();
      expect(withProvenance?.actorType).toBe("agent");
    });

    it("leaves actorId/userId/actorType absent on a relation when omitted", async () => {
      const fact1 = await adapter.createFact({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        scope: "global",
        statement: "no-provenance A",
        subject: "no-provenance A",
        kind: "other",
      });
      const fact2 = await adapter.createFact({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        scope: "global",
        statement: "no-provenance B",
        subject: "no-provenance B",
        kind: "other",
      });

      await adapter.createRelation({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        sourceId: fact1.id,
        sourceType: "fact",
        targetId: fact2.id,
        targetType: "fact",
        verb: "related",
      });

      const relations = await adapter.getRelations({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        sourceId: fact1.id,
        targetId: fact2.id,
      });
      expect(relations.length).toBeGreaterThanOrEqual(1);
      expect(relations[0]?.actorId).toBeFalsy();
      expect(relations[0]?.userId).toBeFalsy();
      expect(relations[0]?.actorType).toBeFalsy();
    });

    it("getRelations(maxSensitivity) omits relations touching an endpoint above the ceiling", async () => {
      const ws = "11111111-1111-1111-1111-111111111111";
      const entity = (name: string, sensitivity?: "restricted") =>
        adapter.createEntity({
          workspaceId: ws,
          name: `${name} ${Math.random()}`,
          kind: "concept",
          ...(sensitivity ? { sensitivity } : {}),
        });
      const open = await entity("ceiling open");
      const visible = await entity("ceiling visible");
      const secret = await entity("ceiling secret", "restricted");
      const conf = await adapter.createDecision({
        workspaceId: ws,
        kind: "architecture",
        title: "ceiling confidential decision",
        body: "...",
        sensitivity: "confidential",
      });
      const relate = (
        sourceId: string,
        targetId: string,
        targetType: "entity" | "decision" = "entity"
      ) =>
        adapter.createRelation({
          workspaceId: ws,
          sourceId,
          sourceType: "entity",
          targetId,
          targetType,
          verb: "related",
        });
      const shown = await relate(open.id, visible.id);
      await relate(open.id, conf.id, "decision");
      await relate(secret.id, visible.id);
      // Newest last: the ceiling must apply before `limit`, or limit 1 would
      // return this hidden row instead of the visible one.
      await relate(open.id, secret.id);

      const ids = async (
        filter: Omit<Parameters<StorageAdapter["getRelations"]>[0], "workspaceId">
      ) => (await adapter.getRelations({ workspaceId: ws, ...filter })).map((r) => r.id).sort();

      const capped = { maxSensitivity: "internal" as const };
      expect(await ids({ ...capped, sourceIds: [open.id, secret.id] })).toEqual([shown.id]);
      expect(await ids({ ...capped, targetIds: [visible.id, secret.id, conf.id] })).toEqual([
        shown.id,
      ]);
      expect(await ids({ ...capped, sourceId: secret.id })).toEqual([]);
      expect(await ids({ ...capped, sourceIds: [open.id], limit: 1 })).toEqual([shown.id]);

      for (const filter of [{ maxSensitivity: "restricted" as const }, {}]) {
        expect(await ids({ ...filter, sourceIds: [open.id, secret.id] })).toHaveLength(4);
      }
    });

    it("applyRelationJudgment/closeRelation(maxSensitivity) leave a relation with a hidden endpoint untouched", async () => {
      const ws = "11111111-1111-1111-1111-111111111111";
      const open = await adapter.createEntity({
        workspaceId: ws,
        name: `judge open ${Math.random()}`,
        kind: "concept",
      });
      const secret = await adapter.createEntity({
        workspaceId: ws,
        name: `judge secret ${Math.random()}`,
        kind: "concept",
        sensitivity: "restricted",
      });
      const rel = await adapter.createRelation({
        workspaceId: ws,
        sourceId: open.id,
        sourceType: "entity",
        targetId: secret.id,
        targetType: "entity",
        verb: "related",
      });
      const capped = "internal" as const;

      expect(
        await adapter.applyRelationJudgment({
          workspaceId: ws,
          id: rel.id,
          relation: "part_of",
          markedByKind: "user",
          maxSensitivity: capped,
        })
      ).toBeNull();
      expect(await adapter.closeRelation(rel.id, ws, { maxSensitivity: capped })).toBe(false);
      const [stored] = await adapter.getRelations({ workspaceId: ws, sourceId: open.id });
      expect(stored).toMatchObject({ id: rel.id, verb: "related", validTo: null });

      // A ceiling that admits both endpoints changes it as before.
      expect(await adapter.closeRelation(rel.id, ws, { maxSensitivity: "restricted" })).toBe(true);
    });

    it("getHyperedge/queryHyperedges(maxSensitivity) hide a hyperedge with a member above the ceiling", async () => {
      const ws = "11111111-1111-1111-1111-111111111111";
      const entity = (sensitivity?: "restricted") =>
        adapter.createEntity({
          workspaceId: ws,
          name: `hyper member ${Math.random()}`,
          kind: "concept",
          ...(sensitivity ? { sensitivity } : {}),
        });
      const [a, b, c, secret] = [
        await entity(),
        await entity(),
        await entity(),
        await entity("restricted"),
      ];
      const label = `ceiling-hyper-${Math.random()}`;
      const shown = await adapter.createHyperedge({
        workspaceId: ws,
        memberIds: [a.id, b.id, c.id],
        label,
      });
      const hidden = await adapter.createHyperedge({
        workspaceId: ws,
        memberIds: [a.id, b.id, secret.id],
        label,
      });

      const capped = await adapter.queryHyperedges({
        workspaceId: ws,
        label,
        maxSensitivity: "internal",
      });
      expect(capped.items.map((h) => h.id)).toEqual([shown.id]);
      expect(capped.total).toBe(1);
      expect(await adapter.getHyperedge(hidden.id, ws, { maxSensitivity: "internal" })).toBeNull();
      expect(
        await adapter.getHyperedge(shown.id, ws, { maxSensitivity: "internal" })
      ).not.toBeNull();

      for (const filter of [{ maxSensitivity: "restricted" as const }, {}]) {
        expect((await adapter.queryHyperedges({ workspaceId: ws, label, ...filter })).total).toBe(
          2
        );
      }
      expect(await adapter.getHyperedge(hidden.id, ws)).not.toBeNull();
    });

    it("countEntityMentions counts visible active facts and visible episodes related to the entity", async () => {
      const ws = "11111111-1111-1111-1111-111111111111";
      const entity = () =>
        adapter.createEntity({
          workspaceId: ws,
          name: `mentioned ${Math.random()}`,
          kind: "concept",
        });
      const subject = await entity();
      const quiet = await entity();
      for (const statement of ["mention one", "mention two"]) {
        await adapter.createFact({
          workspaceId: ws,
          scope: "global",
          statement: `${statement} ${Math.random()}`,
          subject: "s",
          kind: "trait",
          entityId: subject.id,
        });
      }
      const episode = (sensitivity: "internal" | "restricted", isSynthetic = false) =>
        adapter.createEpisode({
          workspaceId: ws,
          title: `mention episode ${sensitivity}`,
          narrative: "...",
          occurredAt: new Date("2026-01-01T00:00:00Z"),
          sensitivity,
          isSynthetic,
        });
      const visibleEp = await episode("internal");
      const hiddenEp = await episode("restricted");
      const syntheticEp = await episode("internal", true);
      // Either direction counts, and the same episode twice counts once.
      for (const [sourceId, sourceType, targetId, targetType] of [
        [visibleEp.id, "episode", subject.id, "entity"],
        [subject.id, "entity", visibleEp.id, "episode"],
        [subject.id, "entity", hiddenEp.id, "episode"],
        [syntheticEp.id, "episode", subject.id, "entity"],
      ] as const) {
        await adapter.createRelation({
          workspaceId: ws,
          sourceId,
          sourceType,
          targetId,
          targetType,
          verb: "related",
        });
      }

      const ids = [subject.id, quiet.id, "ment_doesnotexist000000000000"];
      expect(
        await adapter.countEntityMentions({
          workspaceId: ws,
          entityIds: ids,
          maxSensitivity: "internal",
        })
      ).toEqual({ [subject.id]: 3, [quiet.id]: 0, [ids[2]!]: 0 });
      expect(
        await adapter.countEntityMentions({
          workspaceId: ws,
          entityIds: ids,
          maxSensitivity: "restricted",
        })
      ).toEqual({ [subject.id]: 4, [quiet.id]: 0, [ids[2]!]: 0 });
      expect(await adapter.countEntityMentions({ workspaceId: ws, entityIds: [] })).toEqual({});
    });

    it("updateFact never closes a fact before its own validFrom", async () => {
      const ws = "11111111-1111-1111-1111-111111111111";
      const fact = await adapter.createFact({
        workspaceId: ws,
        scope: "global",
        statement: `close-at ${Math.random()}`,
        subject: "s",
        kind: "trait",
      });
      const closed = await adapter.updateFact(fact.id, ws, {
        validTo: new Date(fact.validFrom.getTime() - 60_000),
      });
      expect(closed!.validTo!.getTime()).toBeGreaterThanOrEqual(fact.validFrom.getTime());
    });

    it("countOpenConflicts counts the listable pairs, under the ceiling", async () => {
      const ws = "33333333-3333-3333-3333-333333333333";
      const fact = (sensitivity: "public" | "internal" = "internal") =>
        adapter.createFact({
          workspaceId: ws,
          scope: "global",
          statement: `conflict ${Math.random()}`,
          subject: "s",
          kind: "trait",
          sensitivity,
        });
      const conflict = (a: string, b: string) =>
        adapter.createRelation({
          workspaceId: ws,
          sourceId: a,
          sourceType: "fact",
          targetId: b,
          targetType: "fact",
          verb: "conflicts_with",
        });
      const [p1, p2, i1, i2, closed, rel1, rel2] = await Promise.all([
        fact("public"),
        fact("public"),
        fact(),
        fact(),
        fact(),
        fact(),
        fact(),
      ]);
      await conflict(p1.id, p2.id); // public pair
      await conflict(i1.id, i2.id); // internal pair
      await conflict(p1.id, i1.id); // mixed pair
      await conflict(i2.id, closed.id); // one fact closed: not listable
      await adapter.updateFact(closed.id, ws, {
        validTo: new Date(closed.validFrom.getTime() + 1),
      });
      const resolved = await conflict(rel1.id, rel2.id); // resolved: not open
      await adapter.closeRelation(resolved.id, ws);
      await adapter.createRelation({
        workspaceId: ws,
        sourceId: p2.id,
        sourceType: "fact",
        targetId: i2.id,
        targetType: "fact",
        verb: "related",
      });

      expect(await adapter.countOpenConflicts({ workspaceId: ws })).toBe(3);
      expect(
        await adapter.countOpenConflicts({ workspaceId: ws, maxSensitivity: "restricted" })
      ).toBe(3);
      expect(await adapter.countOpenConflicts({ workspaceId: ws, maxSensitivity: "public" })).toBe(
        1
      );
      expect(
        await adapter.countOpenConflicts({ workspaceId: "44444444-4444-4444-4444-444444444444" })
      ).toBe(0);
    });

    it("findHiddenIds names only this workspace's rows above the ceiling, in any kind", async () => {
      const ws = "11111111-1111-1111-1111-111111111111";
      const other = "22222222-2222-2222-2222-222222222222";
      // Hidden rows are entities, decisions and episodes: above `internal`,
      // Postgres encrypts a fact under its actor's DEK, which this harness has no key for.
      const entity = (
        workspaceId: string,
        sensitivity: "internal" | "confidential" | "restricted"
      ) =>
        adapter.createEntity({
          workspaceId,
          name: `hidden-ids entity ${sensitivity} ${Math.random()}`,
          kind: "concept",
          sensitivity,
        });
      const shownFact = await adapter.createFact({
        workspaceId: ws,
        scope: "global",
        statement: `hidden-ids fact ${Math.random()}`,
        subject: "s",
        kind: "trait",
      });
      const shownEntity = await entity(ws, "internal");
      const hiddenEntity = await entity(ws, "confidential");
      const hiddenElsewhere = await entity(other, "restricted");
      const hiddenDecision = await adapter.createDecision({
        workspaceId: ws,
        title: `hidden-ids decision ${Math.random()}`,
        body: "...",
        kind: "decision",
        sensitivity: "restricted",
      });
      const hiddenEpisode = await adapter.createEpisode({
        workspaceId: ws,
        title: "hidden-ids episode",
        narrative: "...",
        occurredAt: new Date("2026-01-01T00:00:00Z"),
        sensitivity: "restricted",
      });
      const ids = [
        shownFact.id,
        shownEntity.id,
        hiddenEntity.id,
        hiddenEntity.id,
        hiddenDecision.id,
        hiddenEpisode.id,
        hiddenElsewhere.id,
        "no-such-row",
      ];
      expect(
        (await adapter.findHiddenIds({ workspaceId: ws, ids, maxSensitivity: "internal" })).sort()
      ).toEqual([hiddenEntity.id, hiddenDecision.id, hiddenEpisode.id].sort());
      expect(
        (
          await adapter.findHiddenIds({ workspaceId: ws, ids, maxSensitivity: "confidential" })
        ).sort()
      ).toEqual([hiddenDecision.id, hiddenEpisode.id].sort());
      expect(
        await adapter.findHiddenIds({ workspaceId: ws, ids, maxSensitivity: "restricted" })
      ).toEqual([]);
      expect(
        await adapter.findHiddenIds({ workspaceId: ws, ids: [], maxSensitivity: "public" })
      ).toEqual([]);
    });

    it("getAuditFeed under maxSensitivity leaves out a fact above it", async () => {
      const ws = "11111111-1111-1111-1111-111111111111";
      // public vs internal: above internal, Postgres needs a DEK this harness lacks.
      const fact = (sensitivity: "public" | "internal") =>
        adapter.createFact({
          workspaceId: ws,
          scope: "global",
          statement: `audit-ceiling ${sensitivity} ${Math.random()}`,
          subject: "s",
          kind: "trait",
          sensitivity,
        });
      const shown = await fact("public");
      const hidden = await fact("internal");
      await adapter.archiveFact(shown.id, ws);
      await adapter.archiveFact(hidden.id, ws);
      const ids = async (maxSensitivity?: "public") =>
        (
          await adapter.getAuditFeed({
            workspaceId: ws,
            limit: 100,
            ...(maxSensitivity ? { maxSensitivity } : {}),
          })
        ).map((e) => e.factId);
      const capped = await ids("public");
      expect(capped).toContain(shown.id);
      expect(capped).not.toContain(hidden.id);
      expect(await ids()).toContain(hidden.id);
    });

    it("getRecallStructures and getUnresolvedConflictIds leave out what touches a hidden row under maxSensitivity", async () => {
      const ws = "11111111-1111-1111-1111-111111111111";
      const fact = () =>
        adapter.createFact({
          workspaceId: ws,
          scope: "global",
          statement: `structures ${Math.random()}`,
          subject: "s",
          kind: "trait",
        });
      const hit = await fact();
      const peer = await fact();
      const third = await fact();
      // The hidden end is an episode: a fact above `internal` needs an actor DEK here.
      const secret = await adapter.createEpisode({
        workspaceId: ws,
        title: "structures secret",
        narrative: "...",
        occurredAt: new Date("2026-01-01T00:00:00Z"),
        sensitivity: "restricted",
      });
      const shownRel = await adapter.createRelation({
        workspaceId: ws,
        sourceId: hit.id,
        sourceType: "fact",
        targetId: peer.id,
        targetType: "fact",
        verb: "related",
      });
      await adapter.createRelation({
        workspaceId: ws,
        sourceId: hit.id,
        sourceType: "fact",
        targetId: secret.id,
        targetType: "episode",
        verb: "conflicts_with",
      });
      const shownEdge = await adapter.createHyperedge({
        workspaceId: ws,
        memberIds: [hit.id, peer.id, third.id],
      });
      await adapter.createHyperedge({ workspaceId: ws, memberIds: [hit.id, peer.id, secret.id] });

      const all = await adapter.getRecallStructures(ws, [hit.id], 10);
      expect(all.relations).toHaveLength(2);
      expect(all.hyperedges).toHaveLength(2);
      const capped = await adapter.getRecallStructures(ws, [hit.id], 10, "internal");
      expect(capped.relations.map((r) => r.id)).toEqual([shownRel.id]);
      expect(capped.hyperedges.map((h) => h.hyperedge.id)).toEqual([shownEdge.id]);

      expect(await adapter.getUnresolvedConflictIds!(ws, [hit.id])).toEqual([hit.id]);
      expect(await adapter.getUnresolvedConflictIds!(ws, [hit.id], "restricted")).toEqual([hit.id]);
      expect(await adapter.getUnresolvedConflictIds!(ws, [hit.id], "internal")).toEqual([]);
    });

    // ── Recall log ────────────────────────────────────────────────────────────

    it("records a recall event without throwing", async () => {
      const fact = await adapter.createFact({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        scope: "global",
        statement: "recalled fact",
        subject: "test",
        kind: "other",
      });

      await expect(
        adapter.recordRecall({
          workspaceId: "11111111-1111-1111-1111-111111111111",
          factId: fact.id,
          queryText: "recalled fact",
          hitRank: 1,
          tdCredit: 0.1,
        })
      ).resolves.not.toThrow();
    });

    // ── Reasoning bitemporality (P64) ────────────────────────────────────────
    //
    // MnemoReasoning became the 9th of 10 bitemporal primitives (event stays
    // excluded by design). createReasoning sets validFrom, leaves validTo
    // undefined; archiveReasoning is the single forget()-equivalent close
    // path (Q1 follow-on) and MUST close validTo alongside status.

    it("createReasoning sets validFrom to a Date and leaves validTo undefined", async () => {
      const r = await adapter.createReasoning({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        question: "bitemporal creation check",
        chain: [{ step: 1, reasoning: "because" }],
        conclusion: "therefore",
      });

      expect(r.validFrom).toBeInstanceOf(Date);
      expect(r.validTo).toBeUndefined();
    });

    it("archiveReasoning closes validTo (>= validFrom) and sets status to archived", async () => {
      const r = await adapter.createReasoning({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        question: "bitemporal archive check",
        chain: [{ step: 1, reasoning: "because" }],
        conclusion: "therefore",
      });

      await adapter.archiveReasoning(r.id, "11111111-1111-1111-1111-111111111111");

      const archived = await adapter.getReasoning(r.id, "11111111-1111-1111-1111-111111111111");
      expect(archived?.status).toBe("archived");
      expect(archived?.validTo).toBeInstanceOf(Date);
      expect((archived!.validTo as Date).getTime()).toBeGreaterThanOrEqual(
        archived!.validFrom.getTime()
      );
    });

    it("a foreign-workspace archiveReasoning call leaves status and validTo untouched", async () => {
      const r = await adapter.createReasoning({
        workspaceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        question: "cross-workspace archive check",
        chain: [{ step: 1, reasoning: "because" }],
        conclusion: "therefore",
      });

      await adapter.archiveReasoning(r.id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

      const untouched = await adapter.getReasoning(r.id, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
      expect(untouched?.status).toBe("active");
      expect(untouched?.validTo).toBeUndefined();
    });

    // ── Pagination ────────────────────────────────────────────────────────────

    it("paginates queryFacts results", async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.createFact({
          workspaceId: "01010101-0101-0101-0101-010101010101",
          scope: "global",
          statement: `fact ${i}`,
          subject: "pg-test",
          kind: "other",
        });
      }

      const page1 = await adapter.queryFacts({
        workspaceId: "01010101-0101-0101-0101-010101010101",
        offset: 0,
        limit: 2,
      });
      const page2 = await adapter.queryFacts({
        workspaceId: "01010101-0101-0101-0101-010101010101",
        offset: 2,
        limit: 2,
      });

      expect(page1.items.length).toBe(2);
      expect(page2.items.length).toBe(2);
      expect(page1.items[0]?.id).not.toBe(page2.items[0]?.id);
    });

    // ── Health check ──────────────────────────────────────────────────────────

    it("healthCheck returns ok or degraded status", async () => {
      const h = await adapter.healthCheck();
      expect(["ok", "degraded", "down"]).toContain(h.status);
      expect(typeof h.latencyMs).toBe("number");
    });
  });
}
