import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import postgres from "postgres";
import type { ManagedSessionWorkerPort } from "@mnemo-ai/types";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const WS = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
let container: StartedTestContainer, raw: postgres.Sql, adapter: DrizzleStorageAdapter;
let worker: ManagedSessionWorkerPort;
beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({
      POSTGRES_USER: "mnemo_test",
      POSTGRES_PASSWORD: "mnemo_test",
      POSTGRES_DB: "mnemo_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const url = `postgres://mnemo_test:mnemo_test@${container.getHost()}:${container.getMappedPort(5432)}/mnemo_test`;
  await migrate({ databaseUrl: url, log: () => undefined });
  raw = postgres(url, { max: 10, onnotice: () => undefined });
  const client = createDrizzleClient(url);
  adapter = new DrizzleStorageAdapter(client.db, client.pgClient);
  worker = adapter as unknown as ManagedSessionWorkerPort;
  await raw`INSERT INTO mnemosyne.mnemo_tenant(id,name) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Worker')`;
  await raw`INSERT INTO mnemosyne.mnemo_workspace(id,name,tenant_id) VALUES
    (${WS},'A','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),(${OTHER},'B','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')`;
}, 120000);
afterAll(async () => {
  await adapter?.close();
  await raw?.end();
  await container?.stop();
});
beforeEach(async () => {
  await raw`TRUNCATE mnemosyne.mnemo_session CASCADE`;
  await raw`UPDATE mnemosyne.mnemo_harness_workspace_control SET ingestion_enabled=true`;
});
async function session() {
  await raw`INSERT INTO mnemosyne.mnemo_session(id,workspace_id,status,source_host,source_session_id,source_client_instance_id,source_generation,
    sensitivity,origin_actor_id,origin_actor_type,origin_sensitivity_ceiling,collapse_lease_owner,collapse_lease_expires_at)
    VALUES('session',${WS},'collapse_pending','codex','host','client',0,'internal','key:test','agent','internal','owner',clock_timestamp()+interval '1 minute')`;
}
async function effect() {
  await session();
  await raw`INSERT INTO mnemosyne.mnemo_managed_collapse_operation(operation_id,workspace_id,session_id,source_generation,status,lease_owner) VALUES('op',${WS},'session',0,'committed','owner')`;
  const [row] =
    await raw`INSERT INTO mnemosyne.mnemo_managed_collapse_effect(workspace_id,collapse_operation_id,effect_kind,target_kind,target_id,payload)
    VALUES(${WS},'op','governance','session','session','{"safe":"value"}') RETURNING id`;
  return String(row!.id);
}
const claim = () =>
  worker.claimManagedCollapseEffects({
    workspaceId: WS,
    leaseOwner: "effect-owner",
    limit: 10,
    leaseMs: 60000,
  });
describe("managed session worker persistence", () => {
  it("disables ingestion once and fences a later check", async () => {
    expect(await worker.isHarnessIngestionEnabled({ workspaceId: WS })).toBe(true);
    const first = await worker.disableHarnessIngestion({ workspaceId: WS });
    expect(first.ingestionEnabled).toBe(false);
    expect(await worker.disableHarnessIngestion({ workspaceId: WS })).toEqual(first);
    expect(await worker.isHarnessIngestionEnabled({ workspaceId: WS })).toBe(false);
  });
  it("waits for the ingestion fence before confirming disable", async () => {
    let disabling!: Promise<unknown>;
    await raw.begin(async (tx) => {
      await tx`SELECT workspace_id FROM mnemosyne.mnemo_harness_workspace_control WHERE workspace_id=${WS} FOR UPDATE`;
      disabling = worker.disableHarnessIngestion({ workspaceId: WS });
      await expect
        .poll(async () =>
          Number(
            (
              await raw`SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%mnemo_harness_workspace_control%'`
            )[0]!.n
          )
        )
        .toBeGreaterThan(0);
    });
    expect(await disabling).toMatchObject({ ingestionEnabled: false });
  });
  it("heartbeats only the live owner and stable operation", async () => {
    await session();
    const args = {
      workspaceId: WS,
      sessionId: "session",
      operationId: `managed:${WS}:session:0`,
      leaseOwner: "owner",
      leaseMs: 90000,
    };
    expect(await worker.heartbeatManagedCollapseLease({ ...args, leaseOwner: "wrong" })).toBe(
      false
    );
    expect(await worker.heartbeatManagedCollapseLease({ ...args, operationId: "forged" })).toBe(
      false
    );
    expect(await worker.heartbeatManagedCollapseLease(args)).toBe(true);
    const [row] =
      await raw`SELECT collapse_lease_expires_at>clock_timestamp()+interval '80 seconds' AS extended FROM mnemosyne.mnemo_session WHERE id='session'`;
    expect(row!.extended).toBe(true);
  });
  it("checks heartbeat expiry after waiting for session lock", async () => {
    await session();
    let pending!: Promise<boolean>;
    await raw.begin(async (tx) => {
      await tx`SELECT id FROM mnemosyne.mnemo_session WHERE id='session' FOR UPDATE`;
      pending = worker.heartbeatManagedCollapseLease({
        workspaceId: WS,
        sessionId: "session",
        operationId: `managed:${WS}:session:0`,
        leaseOwner: "owner",
        leaseMs: 10000,
      });
      await expect
        .poll(async () =>
          Number(
            (
              await raw`SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%mnemo_session%'`
            )[0]!.n
          )
        )
        .toBeGreaterThan(0);
      await tx`UPDATE mnemosyne.mnemo_session SET collapse_lease_expires_at=clock_timestamp() WHERE id='session'`;
    });
    expect(await pending).toBe(false);
  });
  it("claims once, strips internal lease metadata, and drains after ingestion disable", async () => {
    const id = await effect();
    await worker.disableHarnessIngestion({ workspaceId: WS });
    const claims = await claim();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ id, operationId: "op", payload: { safe: "value" } });
    expect(claims[0]!.payload).not.toHaveProperty("__managedLeaseOwner");
    expect(await claim()).toEqual([]);
    expect(
      await worker.completeManagedCollapseEffect({
        workspaceId: OTHER,
        id,
        leaseOwner: "effect-owner",
      })
    ).toBe(false);
    expect(
      await worker.completeManagedCollapseEffect({ workspaceId: WS, id, leaseOwner: "wrong" })
    ).toBe(false);
    expect(
      await worker.completeManagedCollapseEffect({
        workspaceId: WS,
        id,
        leaseOwner: "effect-owner",
      })
    ).toBe(true);
    const [row] =
      await raw`SELECT status,payload,next_attempt_at FROM mnemosyne.mnemo_managed_collapse_effect WHERE id=${id}`;
    expect(row).toMatchObject({
      status: "completed",
      payload: { safe: "value" },
      next_attempt_at: null,
    });
  });
  it("recovers expired effects and schedules capped retry without stale-owner mutation", async () => {
    const id = await effect();
    await claim();
    await raw`UPDATE mnemosyne.mnemo_managed_collapse_effect SET next_attempt_at=clock_timestamp()-interval '1 second',attempts=2147483647 WHERE id=${id}`;
    expect(
      await worker.completeManagedCollapseEffect({
        workspaceId: WS,
        id,
        leaseOwner: "effect-owner",
      })
    ).toBe(false);
    const recovered = await worker.claimManagedCollapseEffects({
      workspaceId: WS,
      leaseOwner: "recovery",
      leaseMs: 60000,
      limit: 1,
    });
    expect(recovered).toHaveLength(1);
    expect(
      await worker.retryManagedCollapseEffect({
        workspaceId: WS,
        id,
        leaseOwner: "effect-owner",
        error: "old",
        baseRetryMs: 100,
        maxRetryMs: 1000,
      })
    ).toBe(false);
    expect(
      await worker.retryManagedCollapseEffect({
        workspaceId: WS,
        id,
        leaseOwner: "recovery",
        error: "temporary",
        baseRetryMs: 100,
        maxRetryMs: 1000,
      })
    ).toBe(true);
    const [row] =
      await raw`SELECT attempts,status,payload,next_attempt_at>clock_timestamp()+interval '500 milliseconds' AS capped FROM mnemosyne.mnemo_managed_collapse_effect WHERE id=${id}`;
    expect(row).toMatchObject({
      attempts: 2147483647,
      status: "pending",
      payload: { safe: "value" },
      capped: true,
    });
  });
  it("rolls back callback writes and outbox, then applies once with completion", async () => {
    const id = await effect();
    await claim();
    const input = { workspaceId: WS, id, leaseOwner: "effect-owner" };
    const apply = async (
      ports: Parameters<ManagedSessionWorkerPort["runManagedCollapseEffect"]>[1] extends (
        p: infer P
      ) => unknown
        ? P
        : never
    ) => {
      await ports.storage.createFact({
        workspaceId: WS,
        scope: "global",
        statement: "Atomic effect",
        subject: "test",
        kind: "other",
      });
      await ports.outbox.append({
        workspaceId: WS,
        eventType: "cache_bust",
        payload: { pattern: "atomic" },
      });
    };
    const before = Number((await raw`SELECT count(*) AS n FROM mnemosyne.mnemo_fact`)[0]!.n);
    await expect(
      worker.runManagedCollapseEffect(input, async (ports) => {
        await apply(ports);
        throw new Error("failpoint");
      })
    ).rejects.toThrow("failpoint");
    expect(Number((await raw`SELECT count(*) AS n FROM mnemosyne.mnemo_fact`)[0]!.n)).toBe(before);
    expect(
      await raw`SELECT id FROM mnemosyne.mnemo_outbox WHERE payload->>'pattern'='atomic'`
    ).toHaveLength(0);
    expect(await worker.runManagedCollapseEffect(input, apply)).toBe(true);
    expect(
      await worker.runManagedCollapseEffect(input, async () => {
        throw new Error("replay ran");
      })
    ).toBe(false);
    expect(Number((await raw`SELECT count(*) AS n FROM mnemosyne.mnemo_fact`)[0]!.n)).toBe(
      before + 1
    );
  });
});
