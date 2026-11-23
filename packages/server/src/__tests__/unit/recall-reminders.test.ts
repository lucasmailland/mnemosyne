// packages/server/src/__tests__/unit/recall-reminders.test.ts
/**
 * REMIND-1: memory_remind_when's description promises "el runtime evalúa
 * ambos [triggerAt y condition] en cada ciclo de recall." This proves
 * POST /recall genuinely calls evaluatePendingReminders and surfaces the
 * fired reminders — mocked storage, no real Postgres (that's the integration
 * test in reminders-fire.integration.test.ts).
 */
import { describe, it, expect, afterEach } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { RecallQuery, RecallResponse, MnemoReminder } from "@mnemo-ai/types";
import { mountRecall } from "../../routes/recall.js";
import { buildMountHarness } from "../_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_recallreminderstest00001";
const WS_ID = "00000000-0000-0000-0000-000000000018";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: "key001", keyHash, workspaceId: WS_ID, scopes: [], plan: "free" },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}
const authed = () => ({
  authorization: `Bearer ${PLAINTEXT_KEY}`,
  "content-type": "application/json",
});
const emptyResp = (): RecallResponse => ({
  hits: [],
  total: 0,
  query: { text: "q", limit: 10, offset: 0 },
  latencyMs: 0,
  fromHotTier: false,
});

function makeReminder(overrides: Partial<MnemoReminder> = {}): MnemoReminder {
  return {
    id: "rem-1",
    workspaceId: WS_ID,
    content: "Follow up on the Acme contract",
    condition: "when user mentions Acme",
    triggerAt: null,
    status: "pending",
    conditionEmbedding: null,
    triggeredAt: null,
    dismissedAt: null,
    createdByAgentId: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function makeStorageStub(reminders: MnemoReminder[]) {
  const dismissed: Array<{ id: string; status: string }> = [];
  return {
    listPendingReminders: async () => reminders,
    dismissReminder: async (
      id: string,
      _workspaceId: string,
      newStatus: "triggered" | "dismissed"
    ) => {
      dismissed.push({ id, status: newStatus });
    },
    appendAuditEntry: async () => undefined,
    getRelations: async () => [],
    _dismissed: dismissed,
  } as unknown as NonNullable<ServerDeps["storage"]> & {
    _dismissed: Array<{ id: string; status: string }>;
  };
}

function makeDeps(opts: { reminders?: MnemoReminder[]; storageThrows?: boolean } = {}): ServerDeps {
  const v3 = {
    recall: async (_q: RecallQuery) => emptyResp(),
  } as unknown as NonNullable<ServerDeps["cognitive"]>;

  const storage = opts.storageThrows
    ? ({
        listPendingReminders: async () => {
          throw new Error("boom");
        },
        appendAuditEntry: async () => undefined,
      } as unknown as NonNullable<ServerDeps["storage"]>)
    : makeStorageStub(opts.reminders ?? []);

  return {
    core: { recall: async () => [] } as unknown as ServerDeps["core"],
    apiKeys: undefined as unknown as ApiKeyLookup,
    embedModel: "text-embedding-3-small",
    cognitive: v3,
    storage,
  } as unknown as ServerDeps;
}

const originalEnv = process.env.MNEMO_RECALL_EVALUATE_REMINDERS;
afterEach(() => {
  if (originalEnv === undefined) delete process.env.MNEMO_RECALL_EVALUATE_REMINDERS;
  else process.env.MNEMO_RECALL_EVALUATE_REMINDERS = originalEnv;
});

describe("POST /recall — REMIND-1 reminder evaluation", () => {
  it("fires a matching semantic reminder and returns it in the recall response", async () => {
    const deps = makeDeps({ reminders: [makeReminder()] });
    (deps as { apiKeys: ApiKeyLookup }).apiKeys = await makeKeyLookup();
    const app = buildMountHarness(deps, [mountRecall]);
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "give me the Acme roadmap" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reminders?: Array<{ id: string; triggeredBy: string }> };
    expect(body.reminders).toHaveLength(1);
    expect(body.reminders?.[0]?.id).toBe("rem-1");
    expect(body.reminders?.[0]?.triggeredBy).toBe("semantic");
  });

  it("does NOT fire when the query does not satisfy the condition", async () => {
    const deps = makeDeps({ reminders: [makeReminder()] });
    (deps as { apiKeys: ApiKeyLookup }).apiKeys = await makeKeyLookup();
    const app = buildMountHarness(deps, [mountRecall]);
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "what's the weather tomorrow" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reminders?: unknown };
    expect(body.reminders).toBeUndefined();
  });

  it("does NOT fire a compound reminder on time alone when the query is unrelated", async () => {
    const past = new Date(Date.now() - 60_000); // determinism-ok: relative seed timestamp, not an assertion value
    const deps = makeDeps({ reminders: [makeReminder({ triggerAt: past })] });
    (deps as { apiKeys: ApiKeyLookup }).apiKeys = await makeKeyLookup();
    const app = buildMountHarness(deps, [mountRecall]);
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "what's the weather tomorrow" }),
    });
    const body = (await res.json()) as { reminders?: unknown };
    expect(body.reminders).toBeUndefined();
  });

  it("fires a time-only reminder (condition null) whose triggerAt has passed, regardless of query", async () => {
    const past = new Date(Date.now() - 60_000); // determinism-ok: relative seed timestamp, not an assertion value
    const deps = makeDeps({
      reminders: [makeReminder({ triggerAt: past, condition: null as unknown as string })],
    });
    (deps as { apiKeys: ApiKeyLookup }).apiKeys = await makeKeyLookup();
    const app = buildMountHarness(deps, [mountRecall]);
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "anything at all" }),
    });
    const body = (await res.json()) as { reminders?: Array<{ triggeredBy: string }> };
    expect(body.reminders).toHaveLength(1);
    expect(body.reminders?.[0]?.triggeredBy).toBe("time");
  });

  it("a reminder-evaluation failure never breaks recall", async () => {
    const deps = makeDeps({ storageThrows: true });
    (deps as { apiKeys: ApiKeyLookup }).apiKeys = await makeKeyLookup();
    const app = buildMountHarness(deps, [mountRecall]);
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[] };
    expect(body.hits).toBeDefined();
  });

  it("MNEMO_RECALL_EVALUATE_REMINDERS=0 skips evaluation entirely", async () => {
    process.env.MNEMO_RECALL_EVALUATE_REMINDERS = "0";
    const deps = makeDeps({ reminders: [makeReminder()] });
    (deps as { apiKeys: ApiKeyLookup }).apiKeys = await makeKeyLookup();
    const app = buildMountHarness(deps, [mountRecall]);
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "give me the Acme roadmap" }),
    });
    const body = (await res.json()) as { reminders?: unknown };
    expect(body.reminders).toBeUndefined();
  });
});
