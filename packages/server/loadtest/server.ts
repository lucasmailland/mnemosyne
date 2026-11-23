/**
 * packages/server/loadtest/server.ts — VER-2 load-test server bootstrap
 *
 * Boots the real Mnemosyne server using the production createApp() path but
 * skips optional heavy deps (LLM, v3, federation) to keep startup fast.
 * Requires a real Postgres + Redis stack (see README.md for Docker Compose).
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm --filter @mnemo-ai/server loadtest:server
 *
 * Env vars:
 *   DATABASE_URL        — postgres DSN (required)
 *   LOADTEST_PORT       — listen port (default 3939)
 *   MNEMO_LLM_PROVIDER  — optional; enables /recall with auto-embedding
 *   MNEMO_LLM_API_KEY   — optional; required if MNEMO_LLM_PROVIDER is set
 *   MNEMO_ALLOW_UNSAFE_DB_ROLE=true — suppress superuser check for dev DBs
 */

import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import type { LLMProviderLike, ServerDeps } from "../src/deps.js";
import type { ApiKeyLookup } from "../src/auth.js";
import { logger } from "../src/logging.js";

const PORT = Number(process.env["LOADTEST_PORT"] ?? 3939);
const DATABASE_URL = process.env["DATABASE_URL"] ?? process.env["MNEMO_DATABASE_URL"];

if (!DATABASE_URL) {
  logger.error("DATABASE_URL is required");
  process.exit(1);
}

process.env["MNEMO_ALLOW_UNSAFE_DB_ROLE"] ??= "true";

// Wire @mnemo-ai/core (required peer dep)
let apiKeys: ApiKeyLookup;
try {
  const mod = await import("@mnemo-ai/core");
  apiKeys = mod.createApiKeyLookup({ databaseUrl: DATABASE_URL });
  logger.info("loadtest-server: apiKeys wired");
} catch (err) {
  logger.error({ err }, "Failed to init @mnemo-ai/core — is the DB running?");
  process.exit(1);
}

// Wire LLM provider (optional — recall without pre-embedded vectors will 501)
let llm: LLMProviderLike | undefined;
const providerName = process.env["MNEMO_LLM_PROVIDER"];
const llmApiKey = process.env["MNEMO_LLM_API_KEY"];
if (providerName && llmApiKey) {
  try {
    const mod = await import("@mnemo-ai/llm-providers");
    llm = mod.createProvider({ provider: providerName, apiKey: llmApiKey });
    logger.info({ provider: providerName }, "loadtest-server: LLM provider wired");
  } catch (err) {
    logger.warn({ err }, "LLM provider unavailable — recall without vector will 501");
  }
}

const deps = {
  apiKeys,
  llm,
  embedModel: "text-embedding-3-small",
} as unknown as ServerDeps;

const app = createApp({ deps, version: "3.0.0-alpha.0-loadtest" });

serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  logger.info({ port }, "loadtest-server: listening");
  logger.info(`DATABASE_URL=${DATABASE_URL.replace(/:[^@]+@/, ":***@")}`);
  logger.info("Ready: POST /facts to write, POST /recall to query");
});
