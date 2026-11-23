/** Offline store boundary regression: real Drizzle codecs, simulated DB rows/I/O. */
import { Hono } from "hono";
import { mountDashboardAuth } from "../../routes/dashboard-auth.js";
import type { ServerDeps } from "../../deps.js";
import { Buffer } from "node:buffer";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterEach, expect, it, vi } from "vitest";
import { DashboardPasswordAuth, PostgresCredentialStore } from "../../dashboard-password.js";

const clients: postgres.Sql[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(clients.splice(0).map((sql) => sql.end()));
});

function fixture(locked: boolean) {
  const client = postgres({ host: "unused.invalid", max: 1 });
  clients.push(client);
  drizzle(client); // Same mutation as createDrizzlePool; opens no connection.
  let now = Date.parse("2026-10-22T12:00:00Z");
  const codecs = client.options as unknown as {
    serializers: Record<number, (value: unknown) => string>;
    parsers: Record<number, (value: string) => unknown>;
  };
  const row = {
    userId: "drizzle-test-user",
    email: "drizzle@example.test",
    passwordHash: "test-hash",
    passwordUpdatedAt: "2026-10-01 12:00:00+00",
    failedAttempts: locked ? 5 : 4,
    lockedUntil: locked ? codecs.parsers[1184]!(new Date(now + 60_000).toISOString()) : null,
  };
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("SELECT * FROM mnemosyne.mnemo_dashboard_credential_lookup"))
      return [{ ...row }];
    if (text.includes("SELECT c.user_id")) return [{ ...row }];
    if (text.includes("disabled_at IS NOT NULL")) return [{ disabled: false }];
    if (text.includes("SET failed_attempts = ?")) {
      const serialized = values[1] == null ? null : codecs.serializers[1184]!(values[1]);
      // postgres-js' wire writer requires strings after the timestamp serializer.
      if (serialized !== null) Buffer.byteLength(serialized);
      row.failedAttempts = values[0] as number;
      row.lockedUntil = serialized;
    }
    if (text.includes("SET failed_attempts = 0")) {
      row.failedAttempts = 0;
      row.lockedUntil = null;
    }
    if (text.includes("SELECT w.id")) return [{ id: "workspace", name: "Team", role: "read" }];
    return [];
  };
  vi.spyOn(client, "begin").mockImplementation((async (fn: (tx: unknown) => unknown) =>
    fn(query)) as never);
  const store = new PostgresCredentialStore(client);
  const auth = new DashboardPasswordAuth(
    store,
    {
      compare: async (value) => value === "correct",
      hash: async () => "unused",
      dummyHash: "unused",
    },
    () => now
  );
  return {
    auth,
    row,
    store,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it("AUTH-13 writes the fifth lock through real Drizzle timestamp serializers", async () => {
  const { auth, row } = fixture(false);
  expect(await auth.login(row.email, "wrong")).toBeNull();
  expect(row.failedAttempts).toBe(5);
  expect(typeof row.lockedUntil).toBe("string");
  expect(await auth.login(row.email, "correct")).toBeNull();
});

it("AUTH-13 normalizes Drizzle timestamp reads for email and user lookups", async () => {
  const { auth, row, store } = fixture(true);
  expect(await auth.login(row.email, "correct")).toBeNull();
  expect(await auth.change(row.userId, "correct", "new password long enough")).toBe("invalid");
  await store.withUser(row.userId, async ({ credential }) => {
    expect(credential!.lockedUntil).toBeInstanceOf(Date);
    expect(credential!.passwordUpdatedAt).toBe("2026-10-01T12:00:00.000Z");
  });
});

it("AUTH-13 Drizzle store returns generic HTTP 401 while locked and resets on success after expiry", async () => {
  const { auth, row, advance } = fixture(false);
  vi.stubEnv("MNEMO_DASHBOARD_SECRET", "offline-drizzle-test-secret-32-bytes-long");
  const app = new Hono();
  mountDashboardAuth(app, { dashboardPasswordAuth: auth } as ServerDeps);
  const login = (password: string) =>
    app.request("/dashboard/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: row.email, password }),
    });
  for (const value of ["wrong", "correct", "wrong"]) {
    const response = await login(value);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "invalid_credentials",
      message: "Invalid email or password.",
    });
  }
  advance(15 * 60_000);
  expect((await login("correct")).status).toBe(200);
  expect(row.failedAttempts).toBe(0);
  expect(row.lockedUntil).toBeNull();
  expect((await login("wrong")).status).toBe(401);
  expect(row.failedAttempts).toBe(1);
  expect((await login("correct")).status).toBe(200);
  expect(row.failedAttempts).toBe(0);
});
