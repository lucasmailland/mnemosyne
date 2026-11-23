/**
 * APP-007 (audit 2026-11-22) against real Postgres: an approved approval is
 * spent atomically by the request it was granted for, once, by its requester,
 * before it expires; and a resolver can only move a pending, unexpired request.
 */
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDrizzleClient } from "../DrizzleStorageAdapter.js";
import { DrizzleApprovalStore } from "../DrizzleApprovalStore.js";
import { migrate } from "../migrate.js";

let container: StartedTestContainer;
let store: DrizzleApprovalStore;
let raw: ReturnType<typeof postgres>;
const WS = "33333333-3333-4333-8333-333333333333";

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: "u", POSTGRES_PASSWORD: "p", POSTGRES_DB: "d" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const url = `postgres://u:p@${container.getHost()}:${container.getMappedPort(5432)}/d`;
  await migrate({ databaseUrl: url, log: () => void 0 });
  raw = postgres(url, { max: 2, onnotice: () => void 0 });
  store = new DrizzleApprovalStore(createDrizzleClient(url).db);
}, 180_000);

afterAll(async () => {
  await raw?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

const request = (expiresInMs = 60_000) =>
  store.create({
    workspaceId: WS,
    requestedBy: "user-a",
    trigger: "delete_fact",
    resource: "facts",
    payload: { method: "DELETE", path: "/facts/f1" },
    expiresAt: new Date(Date.now() + expiresInMs), // determinism-ok: expiry is checked by Postgres now()
  });
const by = { requestedBy: "user-a", method: "DELETE", path: "/facts/f1" };

describe("DrizzleApprovalStore — APP-007", () => {
  it("is consumed once, by its requester, for its own request", async () => {
    const ar = await request();
    expect(await store.consume(WS, ar.id, by)).toBe(false); // still pending
    expect(await store.resolve(WS, ar.id, "approved", "user-b")).toBe(true);
    expect(await store.consume(WS, ar.id, { ...by, requestedBy: "user-b" })).toBe(false);
    expect(await store.consume(WS, ar.id, { ...by, path: "/facts/f2" })).toBe(false);
    expect(await store.consume(WS, ar.id, by)).toBe(true);
    expect(await store.consume(WS, ar.id, by)).toBe(false);
    expect((await store.get(WS, ar.id))?.status).toBe("consumed");
  });

  it("final review I6: approving starts a one-hour use window", async () => {
    const ar = await request(60_000);
    expect(await store.resolve(WS, ar.id, "approved", "user-b")).toBe(true);
    const left = (await store.get(WS, ar.id))!.expiresAt.getTime() - Date.now(); // determinism-ok: window measured against the DB clock
    expect(left).toBeGreaterThan(55 * 60_000);
    expect(left).toBeLessThanOrEqual(60 * 60_000 + 5_000);
  });

  it("two concurrent redemptions: exactly one wins", async () => {
    const ar = await request();
    await store.resolve(WS, ar.id, "approved", "user-b");
    const wins = await Promise.all(Array.from({ length: 5 }, () => store.consume(WS, ar.id, by)));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it("an expired approval can be neither resolved nor consumed", async () => {
    const ar = await request(-1_000);
    expect(await store.resolve(WS, ar.id, "approved", "user-b")).toBe(false);
    const ok = await request();
    await store.resolve(WS, ok.id, "approved", "user-b");
    await raw`UPDATE mnemosyne.mnemo_approval_request SET expires_at = now() - interval '1 second' WHERE id = ${ok.id}`;
    expect(await store.consume(WS, ok.id, by)).toBe(false);
  });

  it("a second resolver loses", async () => {
    const ar = await request();
    expect(await store.resolve(WS, ar.id, "approved", "user-b")).toBe(true);
    expect(await store.resolve(WS, ar.id, "denied", "user-c")).toBe(false);
    expect((await store.get(WS, ar.id))?.status).toBe("approved");
  });
});
