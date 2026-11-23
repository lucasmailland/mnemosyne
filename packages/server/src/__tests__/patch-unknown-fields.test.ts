/**
 * Server follow-up of APP-022 (audit 2026-11-22): a PATCH body with a field
 * the route does not take was stripped by zod and answered as if it had been
 * applied — a `sensitivity` change, or an entity `linkedUserId` (which only
 * POST/DELETE /entities/:id/link-user may set), silently did nothing.
 * Unknown fields are now a 400 before anything is read or written.
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { mountTasks } from "../routes/tasks.js";
import { mountStrategies } from "../routes/strategies.js";
import { mountWorkflows } from "../routes/workflows.js";
import { mountEntities } from "../routes/entities.js";
import { buildMountHarness } from "./_mountHarness.js";

const KEY = "mns_live_patchunknownfields0000001";
const WS = "00000000-0000-0000-0000-000000000907";

async function makeApp() {
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [
      {
        id: "key-patch",
        keyHash,
        workspaceId: WS,
        scopes: ["memory:read", "memory:write", "memory:admin"],
        plan: "free",
      },
    ],
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const storage = new InMemoryStorageAdapter();
  return buildMountHarness({ apiKeys, storage } as unknown as ServerDeps, [
    mountTasks,
    mountStrategies,
    mountWorkflows,
    mountEntities,
  ]);
}

const cases: Array<[string, Record<string, unknown>]> = [
  ["/tasks/t-missing", { title: "x", sensitivity: "public" }],
  ["/strategies/s-missing", { context: "x", sensitivity: "public" }],
  ["/workflows/w-missing", { name: "x", sensitivity: "public" }],
  ["/entities/00000000-0000-4000-8000-000000000001", { name: "x", linkedUserId: "u-1" }],
];

describe("PATCH refuses fields the route does not take", () => {
  it.each(cases)("%s → 400 on an unknown field", async (path, body) => {
    const app = await makeApp();
    const res = await app.request(path, {
      method: "PATCH",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
  });

  it.each(cases)("%s → a known-only body still reaches the handler", async (path, body) => {
    const app = await makeApp();
    const known = Object.fromEntries(
      Object.entries(body).filter(([k]) => k !== "sensitivity" && k !== "linkedUserId")
    );
    const res = await app.request(path, {
      method: "PATCH",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify(known),
    });
    expect(res.status).toBe(404); // the id does not exist: validation passed
  });
});
