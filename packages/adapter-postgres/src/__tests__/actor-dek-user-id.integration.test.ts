/**
 * Real-Postgres proof for the DEK/AAD rework: per-person GDPR crypto-erasure.
 *
 * Covers what the unit-test double (InMemoryStorageAdapter) can't: the actual
 * mnemo_actor_dek row bookkeeping (FK to mnemo_user, the workspace-RLS-scoped
 * bulk UPDATE in destroyUserDeks, the erasure-candidate query in
 * purgeFactsBySensitivity) against a real Postgres instance.
 *
 * Does NOT test wrap/unwrap crypto correctness — that's dek-erasure.test.ts
 * and column-encryption.test.ts. The dekProvisioner/dekUnwrapper here are
 * trivial (base64, no AES) on purpose: this file only proves the DB rows
 * behave correctly, which is orthogonal to how a DEK is wrapped.
 *
 * Prerequisites: Docker daemon running.
 * Run with: pnpm --filter @mnemo-ai/adapter-postgres test:integration
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { randomBytes } from "node:crypto";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";
import type { DekProvisioner, DekUnwrapper } from "../repositories/types.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let databaseUrl: string;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  await migrate({ databaseUrl, log: (msg) => process.stdout.write(`[migrate] ${msg}\n`) });
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

// Trivial base64 "wrap" — this file tests DB bookkeeping, not crypto.
const dekProvisioner: DekProvisioner = (_workspaceId, _actorId) => {
  const dek = randomBytes(32);
  return { dek, wrapped: dek.toString("base64") };
};
const dekUnwrapper: DekUnwrapper = (_workspaceId, _actorId, wrapped) =>
  Buffer.from(wrapped, "base64");

function adapter() {
  const { db, pgClient } = createDrizzleClient(databaseUrl);
  return new DrizzleStorageAdapter(db, pgClient, dekUnwrapper, dekProvisioner);
}

/** Seed a real mnemo_tenant + mnemo_user row (mnemo_actor_dek.user_id FK requires it). */
async function seedUser(a: DrizzleStorageAdapter, email: string): Promise<string> {
  const pg = (
    a as unknown as {
      pgClient: {
        unsafe: (q: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
      };
    }
  ).pgClient;
  const [tenant] = await pg.unsafe(
    `INSERT INTO mnemosyne.mnemo_tenant (name, kind, plan) VALUES ($1, 'personal', 'free') RETURNING id`,
    [email]
  );
  const [user] = await pg.unsafe(
    `INSERT INTO mnemosyne.mnemo_user (email, personal_tenant_id) VALUES ($1, $2) RETURNING id`,
    [email, tenant!["id"]]
  );
  return user!["id"] as string;
}

let wsCounter = 0;
function freshWorkspaceId(): string {
  wsCounter++;
  return `00000000-0000-0000-0000-${String(wsCounter).padStart(12, "0")}`;
}

describe("mnemo_actor_dek.user_id — real Postgres", () => {
  it("createFact provisioning stamps user_id on the DEK row", async () => {
    const a = adapter();
    const ws = freshWorkspaceId();
    const userId = await seedUser(a, "stamp@example.com");

    await a.createFact({
      workspaceId: ws,
      actorId: "key:a1",
      userId,
      scope: "global",
      statement: "confidential fact",
      subject: "s",
      kind: "other",
      sensitivity: "confidential",
    } as never);

    const pg = (
      a as unknown as {
        pgClient: {
          unsafe: (q: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
        };
      }
    ).pgClient;
    const rows = await pg.unsafe(
      `SELECT actor_id, user_id, status FROM mnemosyne.mnemo_actor_dek WHERE workspace_id = $1`,
      [ws]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!["actor_id"]).toBe("key:a1");
    expect(rows[0]!["user_id"]).toBe(userId);
    expect(rows[0]!["status"]).toBe("active");
  });

  it("destroyUserDeks destroys BOTH of a person's DEKs when they've used two different keys", async () => {
    const a = adapter();
    const ws = freshWorkspaceId();
    const userId = await seedUser(a, "two-keys@example.com");

    await a.createFact({
      workspaceId: ws,
      actorId: "key:a1",
      userId,
      scope: "global",
      statement: "fact under key A",
      subject: "s",
      kind: "other",
      sensitivity: "confidential",
    } as never);
    await a.createFact({
      workspaceId: ws,
      actorId: "key:a2",
      userId,
      scope: "global",
      statement: "fact under key B",
      subject: "s",
      kind: "other",
      sensitivity: "restricted",
    } as never);

    // Two distinct actor-keyed DEKs, same person.
    const before = await a.getActorDek(ws, "key:a1");
    const before2 = await a.getActorDek(ws, "key:a2");
    expect(before).not.toBeNull();
    expect(before2).not.toBeNull();

    const destroyed = await a.destroyUserDeks(ws, userId);
    expect(destroyed).toBe(2);

    // Both are now unreadable — the actor-keyed lookup path returns null
    // (getActorDek only returns rows with status='active').
    expect(await a.getActorDek(ws, "key:a1")).toBeNull();
    expect(await a.getActorDek(ws, "key:a2")).toBeNull();
  });

  it("destroys a DEK created a moment ago even when the server clock runs behind the database's", async () => {
    // created_at is DEFAULT now() and a CHECK keeps destroyed_at >= created_at:
    // a destroyed_at from a lagging Node clock made the erasure itself fail.
    const a = adapter();
    const ws = freshWorkspaceId();
    const userId = await seedUser(a, "clock-behind@example.com");
    await a.createFact({
      workspaceId: ws,
      actorId: "key:clock",
      userId,
      scope: "global",
      statement: "fact under a fresh DEK",
      subject: "s",
      kind: "other",
      sensitivity: "confidential",
    } as never);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 5_000); // determinism-ok: the Node clock 5 s behind the database's is the fixture
    try {
      expect(await a.destroyUserDeks(ws, userId)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op (returns 0) for a userId with no DEKs", async () => {
    const a = adapter();
    const ws = freshWorkspaceId();
    const userId = await seedUser(a, "no-deks@example.com");
    expect(await a.destroyUserDeks(ws, userId)).toBe(0);
  });

  it("does not touch another workspace's DEK for the same person", async () => {
    const a = adapter();
    const wsA = freshWorkspaceId();
    const wsB = freshWorkspaceId();
    const userId = await seedUser(a, "cross-ws@example.com");

    await a.createFact({
      workspaceId: wsA,
      actorId: "key:a1",
      userId,
      scope: "global",
      statement: "fact in ws A",
      subject: "s",
      kind: "other",
      sensitivity: "confidential",
    } as never);
    await a.createFact({
      workspaceId: wsB,
      actorId: "key:a1",
      userId,
      scope: "global",
      statement: "fact in ws B",
      subject: "s",
      kind: "other",
      sensitivity: "confidential",
    } as never);

    const destroyed = await a.destroyUserDeks(wsA, userId);
    expect(destroyed).toBe(1);

    // wsB's DEK for the same person is untouched.
    expect(await a.getActorDek(wsB, "key:a1")).not.toBeNull();
  });

  it("purgeFacts.eraseCandidateUserIds spans a person's confidential facts across two actor_ids", async () => {
    const a = adapter();
    const ws = freshWorkspaceId();
    const userId = await seedUser(a, "purge-candidate@example.com");

    const f1 = await a.createFact({
      workspaceId: ws,
      actorId: "key:a1",
      userId,
      scope: "global",
      statement: "old confidential fact one",
      subject: "s",
      kind: "other",
      sensitivity: "confidential",
    } as never);
    const f2 = await a.createFact({
      workspaceId: ws,
      actorId: "key:a2",
      userId,
      scope: "global",
      statement: "old confidential fact two",
      subject: "s",
      kind: "other",
      sensitivity: "confidential",
    } as never);

    // Backdate both facts' created_at past the retention window (createFact
    // always stamps now()).
    const pg = (
      a as unknown as {
        pgClient: {
          unsafe: (q: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
        };
      }
    ).pgClient;
    await pg.unsafe(
      `UPDATE mnemosyne.mnemo_fact SET created_at = now() - interval '400 days' WHERE id = ANY($1::text[])`,
      [[(f1 as unknown as { id: string }).id, (f2 as unknown as { id: string }).id]]
    );

    const result = await a.purgeFacts({
      workspaceId: ws,
      sensitivity: "confidential",
      olderThanDays: 365,
      dryRun: false,
    });

    expect(result.softClosed).toBe(2);
    // Both facts belonged to the same person across two different actor_ids —
    // the gate must check ALL of their confidential/restricted facts, not just
    // the one actor_id that triggered a given soft-close, so this returns
    // exactly one candidate userId (not zero, not a per-actor split).
    expect(result.eraseCandidateUserIds).toEqual([userId]);
    // Both actor_ids are independently exhausted too — same invariant, actor grain.
    expect(new Set(result.eraseCandidateActorIds)).toEqual(new Set(["key:a1", "key:a2"]));
  });

  it("purgeFacts does NOT list a userId as an erase candidate while they still have a live confidential fact under a different key", async () => {
    const a = adapter();
    const ws = freshWorkspaceId();
    const userId = await seedUser(a, "still-live@example.com");

    const f1 = await a.createFact({
      workspaceId: ws,
      actorId: "key:a1",
      userId,
      scope: "global",
      statement: "old confidential fact",
      subject: "s",
      kind: "other",
      sensitivity: "confidential",
    } as never);
    // A second, STILL-LIVE confidential fact under a different key, same person.
    await a.createFact({
      workspaceId: ws,
      actorId: "key:a2",
      userId,
      scope: "global",
      statement: "fresh confidential fact, still within retention",
      subject: "s",
      kind: "other",
      sensitivity: "confidential",
    } as never);

    const pg = (
      a as unknown as {
        pgClient: {
          unsafe: (q: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
        };
      }
    ).pgClient;
    await pg.unsafe(
      `UPDATE mnemosyne.mnemo_fact SET created_at = now() - interval '400 days' WHERE id = $1`,
      [(f1 as unknown as { id: string }).id]
    );

    const result = await a.purgeFacts({
      workspaceId: ws,
      sensitivity: "confidential",
      olderThanDays: 365,
      dryRun: false,
    });

    expect(result.softClosed).toBe(1);
    // The person still has a live confidential fact under key:a2 — not safe
    // to destroy their DEKs yet, even though the key:a1 fact just closed.
    expect(result.eraseCandidateUserIds).toEqual([]);
  });
});
