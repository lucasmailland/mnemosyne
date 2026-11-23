/**
 * The rest of the id pointers a response could name past the caller's ceiling
 * (final review I1): a fact's `episodeId` (lists, GET /facts/:id with and
 * without provenance, POST /facts/compare), a task's parentTaskId / subtaskIds /
 * blockedBy / relatedFacts / relatedEntities, a strategy's supersedesId, a
 * workflow's previousVersionId, an episode's parentEpisodeId, an event's
 * relatedEntities and an inference's inputFactIds / derivedId. A hidden target
 * reads exactly like a missing one; a caller whose ceiling admits every tier
 * sees every pointer as stored.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type {
  MnemoEpisode,
  MnemoFact,
  MnemoStrategy,
  MnemoTask,
  MnemoWorkflow,
} from "@mnemo-ai/types";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { mountFacts } from "../routes/facts.js";
import { mountFactsCompare } from "../routes/factsCompare.js";
import { mountTasks } from "../routes/tasks.js";
import { mountStrategies } from "../routes/strategies.js";
import { mountWorkflows } from "../routes/workflows.js";
import { mountEpisodes } from "../routes/episodes.js";
import { mountEvents } from "../routes/events.js";
import { mountComposition } from "../routes/composition.js";
import { mountReview } from "../routes/review.js";
import { mountAudit } from "../routes/audit.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_pointerceiling000000002";
const WS = "00000000-0000-0000-0000-000000000906";

type State = {
  facts: Map<string, MnemoFact>;
  tasks: Map<string, MnemoTask>;
  strategies: Map<string, MnemoStrategy>;
  workflows: Map<string, MnemoWorkflow>;
  episodes: Map<string, MnemoEpisode>;
};

async function makeApp() {
  const storage = new InMemoryStorageAdapter();
  const state = (storage as unknown as { state: State }).state;
  const episode = async (id: string, sensitivity: "internal" | "restricted") => {
    const created = await storage.createEpisode({
      workspaceId: WS,
      title: id,
      narrative: "...",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      sensitivity,
    });
    const row = { ...created, id };
    state.episodes.delete(created.id);
    state.episodes.set(id, row);
    return row;
  };
  const secretEpisode = await episode("mepi_secret_parent", "restricted");
  const shownEpisode = await episode("mepi_shown_parent", "internal");
  const child = await episode("mepi_child", "internal");
  state.episodes.get(child.id)!.parentEpisodeId = secretEpisode.id;

  const fact = (statement: string, sensitivity: "internal" | "restricted") =>
    storage.createFact({
      workspaceId: WS,
      scope: "global",
      statement,
      subject: "s",
      kind: "trait",
      sensitivity,
    });
  const secretFact = await fact("A restricted fact", "restricted");
  const shownFact = await fact("A visible fact", "internal");
  const inSecretEpisode = await fact("Written during a restricted session", "internal");
  state.facts.get(inSecretEpisode.id)!.episodeId = secretEpisode.id;
  const inShownEpisode = await fact("Written during a visible session", "internal");
  state.facts.get(inShownEpisode.id)!.episodeId = shownEpisode.id;

  const secretEntity = await storage.createEntity({
    workspaceId: WS,
    name: "Secret",
    kind: "concept",
    sensitivity: "restricted",
  });

  const task = (title: string, sensitivity: "internal" | "restricted") =>
    storage.createTask({ workspaceId: WS, title, assignedTo: "a", sensitivity });
  const secretTask = await task("Secret parent", "restricted");
  const shownTask = await task("Visible sibling", "internal");
  const childTask = await task("Child", "internal");
  Object.assign(state.tasks.get(childTask.id)!, {
    parentTaskId: secretTask.id,
    subtaskIds: [shownTask.id, secretTask.id],
    blockedBy: [secretTask.id],
    relatedFacts: [shownFact.id, secretFact.id],
    relatedEntities: [secretEntity.id],
  });

  const strategy = (trigger: string, sensitivity: "internal" | "restricted") =>
    storage.createStrategy({ workspaceId: WS, trigger, action: "do", sensitivity });
  const secretStrategy = await strategy("Secret predecessor", "restricted");
  const successor = await strategy("Successor", "internal");
  state.strategies.get(successor.id)!.supersedesId = secretStrategy.id;

  const workflow = (name: string, sensitivity: "internal" | "restricted") =>
    storage.createWorkflow({
      workspaceId: WS,
      name,
      steps: [{ order: 1, action: "a", expectedDurationMs: 1 }],
      sensitivity,
    });
  const secretWorkflow = await workflow("Secret v1", "restricted");
  const nextVersion = await workflow("v2", "internal");
  state.workflows.get(nextVersion.id)!.previousVersionId = secretWorkflow.id;

  const event = await storage.createEvent({
    workspaceId: WS,
    type: "system",
    name: "Launch",
    description: "...",
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    source: "test",
    relatedEntities: [secretEntity.id],
  });

  await storage.appendInference({
    workspaceId: WS,
    ruleId: "rule-1",
    inputFactIds: [shownFact.id, secretFact.id],
    derivedKind: "fact",
    derivedId: secretFact.id,
    confidence: 0.9,
  });

  const forgottenSecret = await fact("A forgotten restricted fact", "restricted");
  await storage.archiveFact(forgottenSecret.id, WS);
  const forgottenShown = await fact("A forgotten visible fact", "internal");
  await storage.archiveFact(forgottenShown.id, WS);

  await storage.enqueueActiveLearningReview({
    workspaceId: WS,
    factId: secretFact.id,
    reason: "low_confidence",
  });
  await storage.enqueueActiveLearningReview({
    workspaceId: WS,
    factId: shownFact.id,
    reason: "low_confidence",
  });

  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [
      {
        id: "key002",
        keyHash,
        workspaceId: WS,
        scopes: ["memory:read", "memory:write", "memory:admin"],
        plan: "free",
      },
    ],
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const app = buildMountHarness({ apiKeys, storage } as unknown as ServerDeps, [
    mountFacts,
    mountFactsCompare,
    mountTasks,
    mountStrategies,
    mountWorkflows,
    mountEpisodes,
    mountEvents,
    mountComposition,
    mountReview,
    mountAudit,
  ]);
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${PLAINTEXT_KEY}`,
        "content-type": "application/json",
      },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as never;
  };
  return {
    call,
    secret: [
      secretEpisode.id,
      secretFact.id,
      secretEntity.id,
      secretTask.id,
      secretStrategy.id,
      secretWorkflow.id,
    ],
    secretEpisode,
    shownEpisode,
    forgottenSecret,
    forgottenShown,
    secretFact,
    shownFact,
    inSecretEpisode,
    inShownEpisode,
    secretTask,
    shownTask,
    childTask,
    secretStrategy,
    successor,
    secretWorkflow,
    nextVersion,
    child,
    event,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const leaks = (body: unknown, secret: string[]) =>
  secret.filter((id) => JSON.stringify(body).includes(id));

describe("more id pointers — default ceiling (internal)", () => {
  it("a fact's episodeId reads null when the episode is hidden, in every fact response", async () => {
    const { call, inSecretEpisode, inShownEpisode, shownEpisode, secretFact, secretEpisode } =
      await makeApp();
    const list = (await call("/facts?limit=50")) as {
      items: Array<{ id: string; episodeId: string | null }>;
    };
    expect(list.items.find((f) => f.id === inSecretEpisode.id)!.episodeId).toBeNull();
    expect(list.items.find((f) => f.id === inShownEpisode.id)!.episodeId).toBe(shownEpisode.id);

    const one = (await call(`/facts/${inSecretEpisode.id}`)) as { episodeId: string | null };
    expect(one.episodeId).toBeNull();
    const withProvenance = (await call(`/facts/${inSecretEpisode.id}?provenance=true`)) as {
      episodeId: string | null;
      sessionId: string | null;
    };
    expect(withProvenance.episodeId).toBeNull();
    expect(withProvenance.sessionId).toBeNull();
    expect(((await call(`/facts/${inShownEpisode.id}`)) as { episodeId: string }).episodeId).toBe(
      shownEpisode.id
    );

    const pinned = await call(`/facts/${inSecretEpisode.id}/pin`, {
      method: "POST",
      body: JSON.stringify({ pinned: true }),
    });
    const patched = await call(`/facts/${inSecretEpisode.id}`, {
      method: "PATCH",
      body: JSON.stringify({ subject: "s2" }),
    });
    const compared = await call("/facts/compare", {
      method: "POST",
      body: JSON.stringify({ factIdA: inSecretEpisode.id, factIdB: inShownEpisode.id }),
    });
    for (const body of [pinned, patched, compared]) {
      expect(leaks(body, [secretEpisode.id, secretFact.id])).toEqual([]);
    }
  });

  it("a task names no hidden parent, subtask, blocker, fact or entity", async () => {
    const { call, childTask, shownTask, shownFact, secret } = await makeApp();
    const one = (await call(`/tasks/${childTask.id}`)) as Record<string, unknown>;
    expect(one.parentTaskId).toBeUndefined();
    expect(one.subtaskIds).toEqual([shownTask.id]);
    expect(one.blockedBy).toEqual([]);
    expect(one.relatedFacts).toEqual([shownFact.id]);
    expect(one.relatedEntities).toEqual([]);
    expect(leaks(await call("/tasks?limit=50"), secret)).toEqual([]);
    const patched = await call(`/tasks/${childTask.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Child, renamed" }),
    });
    expect(leaks(patched, secret)).toEqual([]);
  });

  it("a strategy and a workflow name no hidden predecessor", async () => {
    const { call, successor, nextVersion, secret } = await makeApp();
    const strategy = (await call(`/strategies/${successor.id}`)) as Record<string, unknown>;
    expect("supersedesId" in strategy).toBe(false);
    expect(leaks(await call("/strategies?limit=50"), secret)).toEqual([]);
    const rated = await call(`/strategies/${successor.id}/rate`, {
      method: "POST",
      body: JSON.stringify({ outcome: "success" }),
    });
    expect(leaks(rated, secret)).toEqual([]);

    const workflow = (await call(`/workflows/${nextVersion.id}`)) as Record<string, unknown>;
    expect("previousVersionId" in workflow).toBe(false);
    expect(leaks(await call("/workflows?limit=50"), secret)).toEqual([]);
  });

  it("an episode names no hidden parent; an event no hidden entity", async () => {
    const { call, child, event, secret } = await makeApp();
    const list = (await call("/episodes?includeSynthetic=true")) as {
      items: Array<Record<string, unknown>>;
    };
    expect("parentEpisodeId" in list.items.find((e) => e.id === child.id)!).toBe(false);
    expect(leaks(list, secret)).toEqual([]);

    const one = (await call(`/events/${event.id}`)) as { relatedEntities: string[] };
    expect(one.relatedEntities).toEqual([]);
    expect(leaks(await call("/events?limit=50"), secret)).toEqual([]);
  });

  it("the inference log names no hidden input or derived row", async () => {
    const { call, shownFact, secret } = await makeApp();
    const log = (await call("/composition/inferences")) as {
      items: Array<Record<string, unknown>>;
    };
    expect(log.items[0]!.inputFactIds).toEqual([shownFact.id]);
    expect("derivedId" in log.items[0]!).toBe(false);
    expect(leaks(log, secret)).toEqual([]);
  });
});

describe("review queue — default ceiling (internal)", () => {
  it("GET /review leaves out a row about a hidden fact", async () => {
    const { call, shownFact, secret } = await makeApp();
    const body = (await call("/review")) as { items: Array<{ factId: string }> };
    expect(body.items.map((r) => r.factId)).toEqual([shownFact.id]);
    expect(leaks(body, secret)).toEqual([]);
  });
});

describe("undo log — default ceiling (internal)", () => {
  it("GET /audit leaves out a forgotten fact above the ceiling", async () => {
    const { call, forgottenShown, forgottenSecret } = await makeApp();
    const body = await call("/audit");
    const ids = (body as { items: Array<{ factId: string }> }).items.map((e) => e.factId);
    expect(ids).toContain(forgottenShown.id);
    expect(JSON.stringify(body)).not.toContain(forgottenSecret.id);
    expect(JSON.stringify(body)).not.toContain("A forgotten restricted fact");
  });
});

describe("more id pointers — ceiling restricted", () => {
  it("every pointer is served as stored", async () => {
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted");
    const {
      call,
      inSecretEpisode,
      secretEpisode,
      childTask,
      secretTask,
      successor,
      secretStrategy,
      nextVersion,
      secretWorkflow,
      child,
      event,
      secretFact,
    } = await makeApp();
    expect(((await call(`/facts/${inSecretEpisode.id}`)) as { episodeId: string }).episodeId).toBe(
      secretEpisode.id
    );
    expect(((await call(`/tasks/${childTask.id}`)) as { parentTaskId: string }).parentTaskId).toBe(
      secretTask.id
    );
    expect(
      ((await call(`/strategies/${successor.id}`)) as { supersedesId: string }).supersedesId
    ).toBe(secretStrategy.id);
    expect(
      ((await call(`/workflows/${nextVersion.id}`)) as { previousVersionId: string })
        .previousVersionId
    ).toBe(secretWorkflow.id);
    const episodes = (await call("/episodes?includeSynthetic=true")) as {
      items: Array<{ id: string; parentEpisodeId?: string }>;
    };
    expect(episodes.items.find((e) => e.id === child.id)!.parentEpisodeId).toBe(secretEpisode.id);
    expect(
      ((await call(`/events/${event.id}`)) as { relatedEntities: string[] }).relatedEntities
    ).toHaveLength(1);
    const log = (await call("/composition/inferences")) as {
      items: Array<{ derivedId: string }>;
    };
    expect(log.items[0]!.derivedId).toBe(secretFact.id);
    expect(((await call("/review")) as { items: unknown[] }).items).toHaveLength(2);
    expect(((await call("/audit")) as { items: unknown[] }).items).toHaveLength(2);
  });
});
