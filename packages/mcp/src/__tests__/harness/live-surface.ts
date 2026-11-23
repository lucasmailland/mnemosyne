/**
 * B3.1 — reusable live-surface harness (design.md "B3. Full-surface test
 * coverage architecture").
 *
 * Extracted from `remember-recall.integration.test.ts`'s `beforeAll`, which
 * already does the hard part end-to-end:
 *   1. Boots a real pgvector/pgvector:pg17 testcontainer.
 *   2. Applies BOTH migration streams (core legacy + adapter-postgres v3)
 *      via their built CLIs.
 *   3. Builds the REAL Hono app in-process with real core + cognitive deps
 *      (a fake, deterministic embed adapter — no LLM key needed) and binds
 *      it to a real loopback TCP port via `@hono/node-server`'s
 *      `getRequestListener` — the same primitive `packages/server/src/index.ts`
 *      uses in production.
 *   4. Spawns the real built MCP stdio server (`dist/index.js`) as a child
 *      process pointed at that port via `MNEMO_URL`/`MNEMO_KEY` (the same
 *      env-var convention `packages/cli` already reads — see
 *      `packages/cli/src/index.ts`).
 *
 * This module generalizes that setup into a single `startLiveSurface()` call
 * exposing every client surface a B4 exercise needs: raw HTTP (`http`), the
 * SDK (`sdk`), the MCP stdio client (`mcp`), and a way to invoke the real
 * built CLI binary as a subprocess (`cli`) — so no B4 test file has to
 * re-implement server bootstrap/teardown, API key provisioning, or workspace
 * setup from scratch.
 *
 * Requires Docker AND a prior `pnpm --filter @mnemo-ai/mcp build` (MCP_ENTRY
 * is dist/index.js), `pnpm --filter @mnemo-ai/cli build` (CLI_ENTRY is
 * dist/index.js), `pnpm --filter @mnemo-ai/core build`, and
 * `pnpm --filter @mnemo-ai/adapter-postgres build` (their migrate CLIs run
 * from dist/). Also requires Node >=22 locally — see the Node-version note
 * in `remember-recall.integration.test.ts` and `CLAUDE.md`.
 *
 * By default every app pool connects as the container's superuser, which
 * bypasses RLS. `startLiveSurface({ nonSuperuser: true })` (plan 7.3, audit
 * 2026-11-22) connects them as the role `docker/scripts/provision-app-role.mjs`
 * provisions in production instead; `extraKeys` + `connectMcp` add more keys
 * (other workspaces, narrow scopes, a sensitivity ceiling) and their children.
 *
 * NOT implemented here (deliberately, B3's scope boundary): production
 * verification (design.md "B5. Production verification") will later point
 * this same harness at a real deployed instance via `MNEMO_VERIFY_URL` /
 * `MNEMO_VERIFY_KEY` env vars, skipping container startup entirely when they
 * are set. `startLiveSurface` keeps all container-boot/seed logic in one
 * linear block below specifically so that a future `if (!MNEMO_VERIFY_URL)`
 * guard around it is a small, local change rather than a restructure.
 */
import { createServer, type Server as HttpServer } from "node:http";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import bcrypt from "bcrypt";
import postgres from "postgres";
import { getRequestListener } from "@hono/node-server";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MnemosyneClient } from "@mnemo-ai/client-ts";
import { InMemoryPeerStore, MtlsAuthAdapter, type PeerConfig } from "@mnemo-ai/federation";
import { InMemoryJtiStore } from "@mnemo-ai/core";
import type { CacheAdapter, Sensitivity } from "@mnemo-ai/types";

import {
  createStdioCleanup,
  MCP_ENTRY,
  MCP_TIMEOUT_MS,
  stdioEnvironment,
} from "../contracts/stdio-tools.js";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/mcp/src/__tests__/harness -> packages/
const PACKAGES_DIR = resolve(HERE, "../../../../");
const CORE_DIR = resolve(PACKAGES_DIR, "core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(PACKAGES_DIR, "adapter-postgres/dist/migrate.js");
const CLI_ENTRY = resolve(PACKAGES_DIR, "cli/dist/index.js");
// The script Dockerfile.migrate runs after both migration streams: the grants
// production's app role gets, and only those.
const PROVISION_SCRIPT = resolve(PACKAGES_DIR, "../docker/scripts/provision-app-role.mjs");
const POSTGRES_PKG = resolve(HERE, "../../../node_modules/postgres");

/** The LOGIN role `nonSuperuser` connects the app as — production's default name. */
export const APP_ROLE = "mnemo_app";
const APP_ROLE_PASSWORD = "mnemo_app_live_surface";

const BCRYPT_COST = 12;

/** The workspace the harness's own keys live in (`LiveSurface.workspaceId`). */
export const HARNESS_WORKSPACE_ID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

/**
 * Every scope this repo currently defines (`packages/server/src/app-scope.ts`),
 * granted in full to the harness's seeded API key so a B4 exercise can hit
 * any route without a separate per-route scope-provisioning step. Each
 * `startLiveSurface()` call seeds a fresh throwaway workspace in a fresh
 * testcontainer, so the broad grant carries no cross-run blast radius.
 */
export const ALL_SCOPES = [
  "memory:read",
  "memory:write",
  "memory:delete",
  "memory:hard_delete",
  "memory:export",
  "memory:event",
  "memory:reasoning",
  "memory:self_edit",
  "memory:session",
  "memory:subscribe",
  "memory:task",
  "memory:procedural",
  "memory:governance",
  "memory:federation",
  "memory:admin",
  "federation:admin",
  "admin:keys",
  "admin:tenant",
  "admin:workspace",
] as const;

/**
 * B4.1 — `InMemoryPeerStore.upsertPinnedCert` deliberately refuses to create a
 * peer (FED-04: an unauthenticated ANNOUNCE must never be able to enrol an
 * attacker-controlled peer). Peers are created only by the operator route
 * `POST /memory/federation/peers` (federation:admin), which calls
 * `addPeer`. This subclass adds a `seed()` escape hatch used ONLY by the harness's own
 * fixture setup (in-process, before the server ever accepts a request) —
 * never reachable from an HTTP route, so it does not reopen FED-04.
 */
class SeedablePeerStore extends InMemoryPeerStore {
  private readonly seeded = new Map<string, PeerConfig>();

  async seed(peer: PeerConfig): Promise<void> {
    this.seeded.set(peer.peerId, peer);
  }

  override async get(peerId: string): Promise<PeerConfig | null> {
    return (await super.get(peerId)) ?? this.seeded.get(peerId) ?? null;
  }

  override async list(): Promise<PeerConfig[]> {
    const fromParent = await super.list();
    const parentIds = new Set(fromParent.map((p) => p.peerId));
    return [...fromParent, ...[...this.seeded.values()].filter((p) => !parentIds.has(p.peerId))];
  }

  override async upsertPinnedCert(
    peerId: string,
    certDer: Uint8Array,
    approvedAt: string
  ): Promise<void> {
    if (this.seeded.has(peerId)) {
      const existing = this.seeded.get(peerId)!;
      this.seeded.set(peerId, { ...existing, pinnedCertDer: certDer, approvedAt });
      return;
    }
    return super.upsertPinnedCert(peerId, certDer, approvedAt);
  }

  override async deletePeer(id: string): Promise<void> {
    this.seeded.delete(id);
    return super.deletePeer(id);
  }
}

/**
 * B4.1 — session routes (`POST /session/start` and everything downstream of
 * it: turn/collapse/discard/feedback/pin/scratch, plus the `/sessions`
 * aliases) gate on `deps.cache` and return 503 `redis_unavailable`
 * (`MNEMO_001`) without one — the original B3 harness wired no cache at all.
 * Same minimal in-memory `CacheAdapter` fake already established by
 * `session-label.integration.test.ts` / `search-path-session.integration.test.ts`
 * — real enough to satisfy the gate, not a real Redis testcontainer (no
 * sorted-set/pub-sub behavior is exercised by B4.1's session route tests).
 */
class FakeCache implements CacheAdapter {
  readonly id = "fake-cache-live-surface";
  readonly capabilities = {
    sortedSets: false,
    pubSub: false,
    patterns: true,
    atomic: true,
    hashes: false,
  };
  private store = new Map<string, string>();
  async get<T>(k: string): Promise<T | null> {
    const v = this.store.get(k);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  async set<T>(k: string, v: T): Promise<void> {
    this.store.set(k, JSON.stringify(v));
  }
  async delete(k: string): Promise<void> {
    this.store.delete(k);
  }
  async deletePattern(): Promise<number> {
    return 0;
  }
  async healthCheck(): Promise<{ status: "ok"; latencyMs: number }> {
    return { status: "ok", latencyMs: 0 };
  }
  async close(): Promise<void> {}
}

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface LiveSurface {
  baseUrl: string;
  apiKey: string;
  workspaceId: string;
  /** Superuser connection string, for a test's own seeding and assertions. Never what the app uses under `nonSuperuser`. */
  databaseUrl: string;
  /** The connection string every app pool uses: the `APP_ROLE` login under `nonSuperuser`, else `databaseUrl`. */
  appDatabaseUrl: string;
  /**
   * Spawns another real MCP stdio child bound to `apiKey` (e.g. one of
   * `extraKeys`) and connects to it. `toolProfile` is `MNEMO_MCP_TOOLS`;
   * `null` leaves it unset so the child serves its default profile. Closed by
   * `close()`.
   */
  connectMcp(apiKey: string, toolProfile?: string | null): Promise<Client>;
  /** Real `@mnemo-ai/client-ts` client, bound to `baseUrl`/`apiKey`. */
  sdk: MnemosyneClient;
  /** Real, already-connected MCP stdio client (the built `dist/index.js` server as a child process). */
  mcp: Client;
  /**
   * Spawns the real built `mnemo` CLI binary as a subprocess with
   * `MNEMO_URL`/`MNEMO_KEY` set. Never throws — a non-zero exit is reported
   * via `code`.
   *
   * B4.3 — `envOverride` merges on top of the default env (which itself
   * inherits `process.env`), letting a CLI coverage test (a) swap
   * `MNEMO_KEY` to one of `secondaryIdentities` for a command that needs a
   * user-bound identity (e.g. the `/export/jsonl` approval round trip), and
   * (b) point `HOME` at an isolated per-test temp dir so a host-mutating
   * command (`mnemo config set`, which otherwise writes to the REAL
   * `~/.mnemo/config.json` of whatever machine runs the test — the same
   * problem that made B1.3 permanently skip `login`/`init`/`install`/`link`)
   * can be exercised for real without touching the actual developer/CI
   * agent home directory. Passing neither keeps the original single-arg
   * behavior byte-for-byte.
   */
  cli(args: string[], envOverride?: Record<string, string>): Promise<CliResult>;
  /** Plain `fetch` against `baseUrl`, auto-injecting a bearer `Authorization` header unless `init.headers` already supplies one. */
  http(method: string, path: string, init?: RequestInit): Promise<Response>;
  /**
   * B4.1 — the real `PeerStore` backing `deps.federation`, exposed so a route
   * test can seed a peer fixture (`.seed(...)`, a harness-only escape hatch —
   * see {@link SeedablePeerStore}) before exercising the peer-admin routes
   * (`GET/DELETE /memory/federation/peers*`, `POST .../approve[-key]`).
   * `undefined` when `@mnemo-ai/federation` wiring is skipped.
   */
  federationPeerStore: SeedablePeerStore;
  /**
   * B4.1 — a second, user-bound identity pair for route families `apiKey`
   * (deliberately workspace-only, no bound userId) cannot exercise: tenant
   * membership/admin routes, break-glass dual control (requester ≠
   * approver, both `mk_admin_`-prefixed with distinct bound userIds), and
   * entity self-link. Same throwaway workspace/tenant as the rest of this
   * surface — torn down together on `close()`.
   */
  secondaryIdentities: {
    tenantId: string;
    userA: { id: string; apiKey: string };
    userB: { id: string; apiKey: string };
  };
  /** Tears down the MCP child process, HTTP listener, core/apiKeys connection pools, and the pgvector container. Idempotent. */
  close(): Promise<void>;
}

export interface StartLiveSurfaceOptions {
  /** Override the default full-scope grant — e.g. to exercise scope-denied paths. */
  scopes?: readonly string[];
  /**
   * Wire the real Postgres agent-policy store (`deps.accessPolicies`), which
   * also mounts the §19 RBAC middleware. Opt-in: the middleware's break-glass
   * gate changes what the `mk_admin_` identities may do in other suites.
   */
  accessPolicies?: boolean;
  /**
   * Plan 7.3 — run every connection the app holds (server deps, API key
   * lookup, metrics client, vector adapter) as a NOSUPERUSER NOBYPASSRLS
   * login role provisioned by the real `docker/scripts/provision-app-role.mjs`,
   * as production does. Migrations and the harness's own seeding stay
   * superuser. Without it the app connects as the container's superuser,
   * which bypasses RLS and every missing grant.
   */
  nonSuperuser?: boolean;
  /**
   * More `mns_live_` workspace keys to seed, each in `workspaceId` (created in
   * the harness tenant when it is not the harness workspace).
   */
  extraKeys?: readonly ExtraKey[];
}

export interface ExtraKey {
  /** Plaintext key; must start with `mns_live_`. */
  key: string;
  workspaceId: string;
  scopes: readonly string[];
  /** `mnemo_api_keys.max_sensitivity`; omitted = NULL (the server-wide MNEMO_SENSITIVITY_CEILING, `internal` by default). */
  maxSensitivity?: Sensitivity;
}

export async function startLiveSurface(
  options: StartLiveSurfaceOptions = {}
): Promise<LiveSurface> {
  const scopes = options.scopes ?? ALL_SCOPES;

  const container: StartedTestContainer = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: "mnemo", POSTGRES_PASSWORD: "mnemo", POSTGRES_DB: "mnemo" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const databaseUrl = `postgres://mnemo:mnemo@${host}:${port}/mnemo`;

  const bootstrap = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await bootstrap.end();
  }

  await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", databaseUrl],
    { timeout: 90_000 }
  );
  await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  const workspaceId = HARNESS_WORKSPACE_ID;
  const plaintextKey = "mns_live_livesurfaceharnesskey0001";
  const keyHash = await bcrypt.hash(plaintextKey, BCRYPT_COST);
  // Built as a Postgres array literal string (`{a,b,c}`) rather than via
  // `sql.array()` — empirically, `sql.array()` sent a bare comma-joined
  // string over the wire on this connection (a fresh `max: 1` client without
  // its type-array-oid map populated yet), which Postgres rejected as a
  // malformed array literal. `scopes` is always one of this module's own
  // constants (never untrusted input), so a plain `::text[]` cast on a
  // manually-built literal is safe and avoids that failure mode entirely.
  const toArrayLiteral = (list: readonly string[]) => `{${list.map((s) => `"${s}"`).join(",")}}`;
  const scopesLiteral = toArrayLiteral(scopes);
  const seed = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
  try {
    await seed`
      INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
      VALUES (${"key_live_surface_harness"}, ${workspaceId}, ${keyHash}, ${"live-surface-harness"}, ${"live-surface-harness"},
              ${scopesLiteral}::text[])
    `;
  } finally {
    await seed.end();
  }

  // B4.1 — a second, user-bound identity pair for route families that need
  // one (tenant/user admin routes, break-glass dual control, entity
  // self-link). `key_live_surface_harness` above is deliberately
  // workspace-only (no bound userId) to match the original B3 harness's own
  // "any route without per-route scope provisioning" design intent — adding
  // these does not change that key's shape, only adds two more.
  const tenantId = "tenant-live-surface-harness";
  const adminUserAId = "b2c3d4e5-user-0000-00000000000a";
  const adminUserBId = "b2c3d4e5-user-0000-00000000000b";
  const adminKeyA = "mk_admin_livesurfaceadminkeya0001";
  const adminKeyB = "mk_admin_livesurfaceadminkeyb0001";
  const [adminHashA, adminHashB] = await Promise.all([
    bcrypt.hash(adminKeyA, BCRYPT_COST),
    bcrypt.hash(adminKeyB, BCRYPT_COST),
  ]);
  const adminSeed = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
  try {
    await adminSeed`
      INSERT INTO mnemosyne.mnemo_tenant (id, name, kind)
      VALUES (${tenantId}, ${"live-surface-harness tenant"}, ${"organization"})
    `;
    // The primary key's home workspace is a real row in this tenant, as the
    // bootstrap key's is in production. Since AUTH-TENANT-NULL (aa64f704) a key
    // with no tenant and no user acts in its home workspace's tenant, and one
    // whose tenant cannot be resolved is refused every tenant-plane route.
    await adminSeed`
      INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id)
      VALUES (${workspaceId}, ${"live-surface-harness workspace"}, ${tenantId})
    `;
    await adminSeed`
      INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id)
      VALUES (${adminUserAId}, ${"live-surface-admin-a@example.com"}, ${tenantId})
    `;
    await adminSeed`
      INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id)
      VALUES (${adminUserBId}, ${"live-surface-admin-b@example.com"}, ${tenantId})
    `;
    await adminSeed`
      INSERT INTO mnemosyne.mnemo_api_keys
        (id, workspace_id, tenant_id, user_id, key_kind, key_hash, name, label, scopes)
      VALUES
        (${"key_live_surface_admin_a"}, ${workspaceId}, ${tenantId}, ${adminUserAId}, ${"user"},
         ${adminHashA}, ${"live-surface-admin-a"}, ${"live-surface-admin-a"}, ${scopesLiteral}::text[]),
        (${"key_live_surface_admin_b"}, ${workspaceId}, ${tenantId}, ${adminUserBId}, ${"user"},
         ${adminHashB}, ${"live-surface-admin-b"}, ${"live-surface-admin-b"}, ${scopesLiteral}::text[])
    `;
    for (const [i, extra] of (options.extraKeys ?? []).entries()) {
      await adminSeed`
        INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id)
        VALUES (${extra.workspaceId}, ${`live-surface workspace ${extra.workspaceId}`}, ${tenantId})
        ON CONFLICT (id) DO NOTHING
      `;
      const name = `live-surface-extra-${i}`;
      await adminSeed`
        INSERT INTO mnemosyne.mnemo_api_keys
          (id, workspace_id, key_hash, name, label, scopes, max_sensitivity)
        VALUES
          (${`key_live_surface_extra_${i}`}, ${extra.workspaceId}, ${await bcrypt.hash(extra.key, BCRYPT_COST)},
           ${name}, ${name}, ${toArrayLiteral(extra.scopes)}::text[], ${extra.maxSensitivity ?? null})
      `;
    }
  } finally {
    await adminSeed.end();
  }

  const appDatabaseUrl = options.nonSuperuser
    ? await provisionAppRole(databaseUrl, host, port)
    : databaseUrl;

  const [coreMod, adapterPgMod, adapterVectorMod, v3CoreMod, appMod, typesTestingMod] =
    await Promise.all([
      import("@mnemo-ai/core"),
      import("@mnemo-ai/adapter-postgres"),
      import("@mnemo-ai/adapter-vector"),
      import("@mnemo-ai/core/cognitive"),
      import("@mnemo-ai/server/app"),
      import("@mnemo-ai/types/testing"),
    ]);

  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: appDatabaseUrl });

  const DIMS = 1536;
  const fakeEmbed: import("@mnemo-ai/types").EmbedAdapter = {
    id: "fake-embed",
    model: "fake-model",
    dimensions: DIMS,
    // Deterministic NON-zero vector — cosine similarity between two
    // all-zero vectors is undefined and degenerates pgvector's ranking
    // (same rationale as remember-recall.integration.test.ts).
    async embed(texts) {
      return texts.map(() => new Float32Array(DIMS).fill(0.1));
    },
    async embedSingle() {
      return new Float32Array(DIMS).fill(0.1);
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };
  const { db: v3Db, pgClient: v3Pg } = adapterPgMod.createDrizzleClient(appDatabaseUrl);
  // Column encryption on, as production runs with MNEMO_MASTER_KEY: without a
  // provisioner a confidential/restricted write fails closed (500). Trivial
  // base64 "wrap" (same as adapter-postgres's actor-dek-user-id test): the
  // fact cipher and the DEK bookkeeping are real, the KEK is not.
  const v3Storage = new adapterPgMod.DrizzleStorageAdapter(
    v3Db,
    v3Pg,
    (_ws: string, _actor: string, wrapped: string) => Buffer.from(wrapped, "base64"),
    () => {
      const dek = randomBytes(32);
      return { dek, wrapped: dek.toString("base64") };
    }
  );
  const v3Vector = new adapterVectorMod.PgVectorAdapter({ connectionString: appDatabaseUrl });
  const noopLogger: import("@mnemo-ai/types").Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: function () {
      return this;
    },
  };
  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const noopTelemetry = {
    startSpan: () => noopSpan,
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
  const outboxAdapter: import("@mnemo-ai/types").OutboxAdapter = {
    async append(e) {
      return v3Storage.appendOutbox(e);
    },
    async claimBatch(n) {
      return v3Storage.claimOutbox(n);
    },
    async markProcessed(ids) {
      return v3Storage.markOutboxProcessed(ids);
    },
    async markFailed(id, err) {
      return v3Storage.markOutboxFailed(id, err);
    },
    async getStats() {
      return { pending: 0, failed: 0, oldestPendingMs: 0 };
    },
  };
  const cognitive = v3CoreMod.createCore({
    storage: v3Storage,
    vector: v3Vector,
    embed: fakeEmbed,
    outbox: outboxAdapter,
    logger: noopLogger,
    telemetry: noopTelemetry,
  });

  // B4.1: `mountTenants` returns early (`if (!pgSql) return`) and `mountKeys`
  // skips every route past `GET /me` (`if (!sql) return`) when
  // `deps.metricsPgClient` is absent — the original B3 harness never set it,
  // so POST /tenants, /admin/keys, and their siblings were entirely
  // unmountable (a 404, not an auth/scope error) through this harness. Same
  // `appDatabaseUrl` as every other app pool: the superuser by default, the
  // provisioned `APP_ROLE` under `nonSuperuser`.
  const metricsPgClient = postgres(appDatabaseUrl, { max: 5, onnotice: () => void 0 });

  const federationPeerStore = new SeedablePeerStore();

  const deps = {
    apiKeys,
    cognitive,
    // B4.1: several route families (tasks, reminders, hyperedges, composition,
    // reasoning, metacognition, webhooks CRUD, …) read `deps.storage` directly
    // rather than through `deps.core`/`deps.cognitive` — omitting it here (as
    // the original B3 harness did) makes every one of those routes 500 with
    // "storage adapter not available" the moment B4 tries to exercise them.
    // `v3Storage` is the same DrizzleStorageAdapter instance `api.integration.test.ts`
    // already wires as `ServerDeps.storage`, so this brings the harness to
    // parity with that established pattern.
    storage: v3Storage,
    llm: undefined,
    embedModel: "fake-model",
    telemetry: noopTelemetry,
    metricsPgClient,
    cache: new FakeCache(),
    // B4.1: `mountFederation` no-ops entirely (`if (!fed) return`) when
    // `deps.federation` is absent — the original B3 harness never wired it,
    // so all 9 `/memory/federation/*` routes were literally unmountable
    // through this harness. The peer-admin routes only need
    // `peerStore`/`mtls`/`jobStore`, so they are wired for real here. The
    // routes a peer calls (/items, /resolve) need a second, signed server;
    // packages/server's federation-pull.integration.test.ts boots two.
    federation: {
      peerStore: federationPeerStore,
      mtls: new MtlsAuthAdapter(federationPeerStore),
      jobStore: { create: () => {}, get: () => null, update: () => {} },
      syncEngine: undefined,
      jtiStore: new InMemoryJtiStore(),
      selfAudience: "mnemo:instance:self",
    },
    // B4.1: `mountApprovals`/`mountBreakGlass` are ALSO conditionally mounted
    // (`if (deps.approvals)` / no route at all otherwise) — wiring the
    // `@mnemo-ai/types` in-memory test doubles brings GET/POST /approvals/*
    // and POST/GET /break-glass* into existence for this harness, and (as a
    // side effect matching real production wiring) makes GET/POST /export
    // take its real approval-gated branch instead of the bypass path.
    approvals: new typesTestingMod.InMemoryApprovalStore(),
    breakGlass: new typesTestingMod.InMemoryBreakGlassStore(),
    ...(options.accessPolicies
      ? { accessPolicies: new adapterPgMod.DrizzleAccessPolicyStore(v3Db) }
      : {}),
  } as unknown as Parameters<typeof appMod.createApp>[0]["deps"];
  const app = appMod.createApp({ deps, version: "live-surface-harness" });

  // Bind the real app to a real loopback port so the MCP stdio child process
  // (a separate OS process) and the CLI subprocess can reach it over HTTP.
  const httpServer: HttpServer = createServer(getRequestListener(app.fetch));
  await new Promise<void>((res) => httpServer.listen(0, "127.0.0.1", res));
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("live-surface: HTTP server did not bind to a TCP port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const mcpCleanups: Array<() => Promise<void>> = [];
  async function connectMcp(apiKey: string, toolProfile: string | null = null): Promise<Client> {
    const env = stdioEnvironment(baseUrl, apiKey, toolProfile);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_ENTRY],
      env,
      stderr: "pipe",
    });
    const client = new Client(
      { name: "mnemosyne-live-surface-harness", version: "1.0.0" },
      { capabilities: {} }
    );
    mcpCleanups.push(createStdioCleanup(client, transport));
    await client.connect(transport, {
      timeout: MCP_TIMEOUT_MS,
      maxTotalTimeout: MCP_TIMEOUT_MS,
    });
    return client;
  }
  const mcpClient = await connectMcp(plaintextKey);

  const sdk = new MnemosyneClient({ url: baseUrl, apiKey: plaintextKey });

  async function cli(args: string[], envOverride?: Record<string, string>): Promise<CliResult> {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_ENTRY, ...args], {
        env: { ...process.env, MNEMO_URL: baseUrl, MNEMO_KEY: plaintextKey, ...envOverride },
        timeout: 30_000,
      });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; code?: number | string };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(error),
        code: typeof e.code === "number" ? e.code : 1,
      };
    }
  }

  async function http(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("authorization")) {
      headers.set("authorization", `Bearer ${plaintextKey}`);
    }
    return fetch(`${baseUrl}${path}`, { ...init, method, headers });
  }

  let closed: Promise<void> | undefined;
  function close(): Promise<void> {
    return (closed ??= (async () => {
      for (const cleanup of mcpCleanups) await cleanup();
      await new Promise<void>((res) => httpServer.close(() => res()));
      await apiKeys.close().catch(() => void 0);
      await metricsPgClient.end().catch(() => void 0);
      // Every pool must end before the container stops, or a queued write lands on a dead socket.
      await v3Pg.end().catch(() => void 0);
      await v3Vector.close().catch(() => void 0);
      await container.stop().catch(() => void 0);
    })());
  }

  return {
    baseUrl,
    apiKey: plaintextKey,
    workspaceId,
    databaseUrl,
    appDatabaseUrl,
    connectMcp,
    sdk,
    mcp: mcpClient,
    cli,
    http,
    federationPeerStore,
    secondaryIdentities: {
      tenantId,
      userA: { id: adminUserAId, apiKey: adminKeyA },
      userB: { id: adminUserBId, apiKey: adminKeyB },
    },
    close,
  };
}

/**
 * Runs the real `provision-app-role.mjs` against the container, as
 * Dockerfile.migrate does, and returns the app role's connection string. The
 * script imports `postgres`, which only resolves from inside a package, so it
 * runs from a temp copy next to a link to this package's own dependency (same
 * approach as packages/server's verify-security.integration.test.ts).
 */
async function provisionAppRole(databaseUrl: string, host: string, port: number): Promise<string> {
  const scriptDir = await mkdtemp(join(tmpdir(), "mnemo-live-surface-provision-"));
  try {
    await cp(PROVISION_SCRIPT, join(scriptDir, "provision-app-role.mjs"));
    await mkdir(join(scriptDir, "node_modules"));
    await symlink(await realpath(POSTGRES_PKG), join(scriptDir, "node_modules", "postgres"), "dir");
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(scriptDir, "provision-app-role.mjs")],
      {
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? "",
          DATABASE_URL: databaseUrl,
          MNEMO_APP_DB_PASSWORD: APP_ROLE_PASSWORD,
          MNEMO_APP_DB_USER: APP_ROLE,
        },
      }
    );
    if (!stdout.includes("provisioned")) {
      throw new Error(`live-surface: provision-app-role did not provision: ${stdout}`);
    }
  } finally {
    await rm(scriptDir, { recursive: true, force: true });
  }
  return `postgres://${APP_ROLE}:${APP_ROLE_PASSWORD}@${host}:${port}/mnemo`;
}

export interface ToolOutcome {
  isError: boolean;
  /** Every text content block, joined. */
  text: string;
  structured: Record<string, unknown> | undefined;
}

/** One `tools/call` with a generous timeout, flattened for assertions. */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 30_000,
    maxTotalTimeout: 30_000,
  });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return {
    isError: result.isError === true,
    text: content.map((c) => c.text ?? "").join("\n"),
    structured: result.structuredContent as Record<string, unknown> | undefined,
  };
}
