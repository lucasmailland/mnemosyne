/**
 * openspec change `enable-deep-mode-consolidation` — sdd-verify remediation.
 *
 * Closes a WARNING from the change's verify pass: the boot-level env→mode
 * flag (`MNEMO_CONSOLIDATION_DEEP_MODE_ENABLED`) had NO durable automated
 * test — it had only been checked by booting the real server manually.
 * Mirrors the sibling `scoped-conflict-check-boot.integration.test.ts`
 * structure/harness, which covers the analogous
 * `MNEMO_SCOPED_CONFLICT_CHECK_ENABLED` boot flag.
 *
 * Proves `wireConsolidation()` (packages/server/src/boot/consolidation.ts)
 * resolves `schedulerCtx.mode` from the env var exactly per its
 * `!== "false" ? "deep" : "fast"` logic, and logs `{ mode }` on
 * `consolidation.scheduler_started` — for all three cases:
 *   - unset → "deep"
 *   - "false" → "fast"
 *   - any other value (e.g. "true", garbage) → "deep"
 *
 * Runs against a real Postgres (pgvector) testcontainer — `wireConsolidation`
 * opens a real `postgres.js` pool via `createDrizzleClient(databaseUrl)`, so
 * this is genuine boot wiring, not a mocked storage double.
 *
 * Prerequisites: Docker daemon running.
 * Run with: pnpm --filter @mnemo-ai/server test:integration -- deep-mode-consolidation-boot
 * (Node 22 required — testcontainers/undici; see CLAUDE.md.)
 */
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ServerDeps } from "../../deps.js";
import { logger } from "../../logging.js";
import { wireConsolidation } from "../../boot/consolidation.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo";
const PG_PASSWORD = "mnemo";
const PG_DB = "mnemo";

const ENV_KEY = "MNEMO_CONSOLIDATION_DEEP_MODE_ENABLED";

let container: StartedTestContainer;
let databaseUrl: string;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  const bootstrap = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await bootstrap.end();
  }

  // Only the v3 (`mnemosyne` schema) migration stream — this test never
  // touches the legacy v2 core or the public schema.
  const { migrate } = await import("@mnemo-ai/adapter-postgres/migrate");
  const result = await migrate({ databaseUrl, log: () => void 0 });
  expect(result.applied.length + result.skipped.length).toBeGreaterThan(0);
}, 180_000);

afterAll(async () => {
  // Bounded teardown (R-26): under `turbo run test:integration` several
  // packages start and stop containers at once, and the Docker daemon stalled
  // this stop past the 120 s hook timeout, failing the run and making turbo
  // cancel adapter-postgres and mcp. The container is disposable and Ryuk
  // reaps it when the worker exits, so give the stop 20 s and move on.
  await Promise.race([
    container?.stop({ timeout: 0 }).catch(() => void 0),
    new Promise<void>((resolve) => setTimeout(resolve, 20_000).unref()),
  ]);
}, 30_000);

describe("boot-level MNEMO_CONSOLIDATION_DEEP_MODE_ENABLED -> schedulerCtx.mode", () => {
  const ORIGINAL_ENV = process.env[ENV_KEY];
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
    if (ORIGINAL_ENV === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = ORIGINAL_ENV;
    }
    vi.restoreAllMocks();
  });

  /**
   * Boots the real `wireConsolidation()` against the live testcontainer and
   * returns the `mode` field logged on `consolidation.scheduler_started`.
   * No `llm`/`v3` are supplied — `replayValidator` resolves to `undefined`,
   * which is irrelevant to the flag-resolution logic under test.
   */
  async function bootAndCaptureLoggedMode(): Promise<string | undefined> {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const fakeDeps = {} as unknown as ServerDeps;

    const handle = await wireConsolidation({
      databaseUrl,
      storageForDeps: {} as unknown as ServerDeps["storage"],
      deps: fakeDeps,
    });
    stop = handle?.stop;

    const startedCall = infoSpy.mock.calls.find(
      ([, msg]) => msg === "consolidation.scheduler_started"
    );
    expect(startedCall).toBeDefined();
    return (startedCall?.[0] as { mode?: string } | undefined)?.mode;
  }

  it('env var unset -> boot log shows mode: "deep"', async () => {
    delete process.env[ENV_KEY];

    const mode = await bootAndCaptureLoggedMode();

    expect(mode).toBe("deep");
  });

  it('env var = "false" -> boot log shows mode: "fast"', async () => {
    process.env[ENV_KEY] = "false";

    const mode = await bootAndCaptureLoggedMode();

    expect(mode).toBe("fast");
  });

  it('env var set to any other value (e.g. "true" or garbage) -> boot log shows mode: "deep"', async () => {
    process.env[ENV_KEY] = "true";
    const modeTrue = await bootAndCaptureLoggedMode();
    expect(modeTrue).toBe("deep");

    stop?.();
    stop = undefined;

    process.env[ENV_KEY] = "not-a-real-value";
    const modeGarbage = await bootAndCaptureLoggedMode();
    expect(modeGarbage).toBe("deep");
  });
});
