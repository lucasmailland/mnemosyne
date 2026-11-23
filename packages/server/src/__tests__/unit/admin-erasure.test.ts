/**
 * POST /admin/erasure — GDPR crypto-erasure of one subject (routes/admin-erasure.ts).
 * Through createApp, so the key-scope guard (memory:hard_delete) is the real one.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";

import { createApp } from "../../app.js";
import type { ApiKeyLookup } from "../../auth.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";

const KEY = "mns_live_adminerasuretest000000001";
const WS = "00000000-0000-0000-0000-0000000000e9";
const USER = "user-larkspur-1";
const ACTOR = "key:key-larkspur-agent";

async function build(
  opts: {
    scopes?: string[];
    destroyUserDeks?: ReturnType<typeof vi.fn> | null;
    destroyActorDek?: ReturnType<typeof vi.fn> | null;
    appendAuditEntry?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [
      {
        id: "key-dpo",
        keyHash,
        workspaceId: WS,
        scopes: opts.scopes ?? ["memory:read", "memory:hard_delete"],
        plan: "free",
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const destroyUserDeks =
    opts.destroyUserDeks === null ? undefined : (opts.destroyUserDeks ?? vi.fn(async () => 2));
  const destroyActorDek =
    opts.destroyActorDek === null ? undefined : (opts.destroyActorDek ?? vi.fn(async () => true));
  const appendAuditEntry = opts.appendAuditEntry ?? vi.fn(async () => undefined);
  const deps = {
    apiKeys,
    storage: {
      appendAuditEntry,
      ...(destroyUserDeks ? { destroyUserDeks } : {}),
      ...(destroyActorDek ? { destroyActorDek } : {}),
    },
    llm: undefined,
    embedModel: "text-embedding-3-small",
  } as unknown as ServerDeps;
  const app = createApp({ deps, version: "0.0.0-test" });
  const erase = (body: unknown) =>
    app.request("/admin/erasure", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { erase, destroyUserDeks, destroyActorDek, appendAuditEntry };
}

const actions = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.map((c) => (c[0] as { action: string }).action);

describe("POST /admin/erasure", () => {
  it("erases every key of a user, audited before and after", async () => {
    const order: string[] = [];
    const appendAuditEntry = vi.fn(async (e: { action: string }) => void order.push(e.action));
    const destroyUserDeks = vi.fn(async () => {
      order.push("destroy");
      return 2;
    });
    const { erase } = await build({ appendAuditEntry, destroyUserDeks });
    const res = await erase({ userId: USER, confirm: USER });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subject: { kind: "user", id: USER }, keysDestroyed: 2 });
    expect(destroyUserDeks).toHaveBeenCalledWith(WS, USER);
    expect(order).toEqual(["erasure_initiated", "destroy", "erasure_complete"]);
    expect(appendAuditEntry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        actorId: "key:key-dpo",
        resourceKind: "user",
        resourceId: USER,
        isTerminal: true,
        detail: expect.objectContaining({ gdprErasure: true, keysDestroyed: 2 }),
      })
    );
  });

  it("erases one actor's key", async () => {
    const { erase, destroyActorDek, destroyUserDeks } = await build();
    const res = await erase({ actorId: ACTOR, confirm: ACTOR });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subject: { kind: "actor", id: ACTOR }, keysDestroyed: 1 });
    expect(destroyActorDek).toHaveBeenCalledWith(WS, ACTOR);
    expect(destroyUserDeks).not.toHaveBeenCalled();
  });

  it("refuses without a confirm that repeats the subject, touching nothing", async () => {
    const { erase, destroyUserDeks, appendAuditEntry } = await build();
    const res = await erase({ userId: USER, confirm: "yes" });
    expect(res.status).toBe(400);
    expect(destroyUserDeks).not.toHaveBeenCalled();
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("refuses both or neither subject", async () => {
    const { erase, destroyUserDeks, destroyActorDek } = await build();
    expect((await erase({ userId: USER, actorId: ACTOR, confirm: USER })).status).toBe(400);
    expect((await erase({ confirm: USER })).status).toBe(400);
    expect(destroyUserDeks).not.toHaveBeenCalled();
    expect(destroyActorDek).not.toHaveBeenCalled();
  });

  it("is a 403 without memory:hard_delete", async () => {
    const { erase, destroyUserDeks } = await build({ scopes: ["memory:read", "memory:admin"] });
    expect((await erase({ userId: USER, confirm: USER })).status).toBe(403);
    expect(destroyUserDeks).not.toHaveBeenCalled();
  });

  it("aborts before destroying anything when erasure_initiated cannot be recorded", async () => {
    const appendAuditEntry = vi.fn(async () => {
      throw new Error("audit down");
    });
    const { erase, destroyUserDeks } = await build({ appendAuditEntry });
    expect((await erase({ userId: USER, confirm: USER })).status).toBe(500);
    expect(destroyUserDeks).not.toHaveBeenCalled();
  });

  it("is a 404 with no completion entry when no live key exists", async () => {
    const { erase, appendAuditEntry } = await build({ destroyUserDeks: vi.fn(async () => 0) });
    expect((await erase({ userId: USER, confirm: USER })).status).toBe(404);
    expect(actions(appendAuditEntry)).toEqual(["erasure_initiated"]);
  });

  it("is a 501 when the adapter cannot destroy keys", async () => {
    const { erase, appendAuditEntry } = await build({ destroyActorDek: null });
    expect((await erase({ actorId: ACTOR, confirm: ACTOR })).status).toBe(501);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});
