import { defineConfig, devices } from "@playwright/test";

/**
 * Dashboard end-to-end specs. They run against a real stack (server +
 * dashboard + Postgres + Redis), never against mocks:
 *
 *   pnpm test:e2e:dashboard        # repo root: builds the stack, runs, tears down
 *
 * or, against a stack that is already up (docker/docker-compose.e2e.yml):
 *
 *   MNEMO_E2E_BASE_URL=http://localhost:3300 pnpm --filter @mnemo-ai/dashboard test:e2e
 *
 * One worker and no parallelism: the login rate limits (30 attempts per IP per
 * 15 minutes) are shared by every spec, and lockout state is per account.
 */
const baseURL = process.env["MNEMO_E2E_BASE_URL"] ?? "http://localhost:3300";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  // A retry would replay logins and eat the shared rate-limit budget.
  retries: 0,
  forbidOnly: !!process.env["CI"],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env["CI"]
    ? [["list"], ["html", { open: "never" }], ["junit", { outputFile: "test-results/junit.xml" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    // localhost, not 127.0.0.1: browsers treat it as a secure context, so the
    // dashboard's Secure session cookie works over plain HTTP, as in production.
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
});
