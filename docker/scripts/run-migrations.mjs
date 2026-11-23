#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const MIGRATION_URL_ENV = "MNEMO_MIGRATION_DATABASE_URL";

export function resolveMigrationDatabaseUrl(env) {
  const value = env[MIGRATION_URL_ENV]?.trim();
  if (!value) {
    throw new Error(
      `${MIGRATION_URL_ENV} is required and must point directly to PostgreSQL; ` +
        "the migration entrypoint never falls back to DATABASE_URL"
    );
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${MIGRATION_URL_ENV} must be a valid PostgreSQL URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${MIGRATION_URL_ENV} must use the postgres: or postgresql: protocol`);
  }
  if (url.hostname.toLowerCase().includes("pgbouncer")) {
    throw new Error(
      "PgBouncer transaction pooling is unsupported for migrations; " +
        `${MIGRATION_URL_ENV} must use a direct PostgreSQL or session-pooled endpoint`
    );
  }

  // A URL cannot prove a provider's pool mode. Deployment owns the direct/session-pooled guarantee.
  return value;
}

function runNode(script, databaseUrl) {
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The same three steps run from two images. The migrate image
// (Dockerfile.migrate) lays core and adapter-postgres out at /app and /app/v3;
// the server image (Dockerfile.server, used by Fly's release_command and
// Railway's pre-deploy command) has them as packed packages in node_modules,
// each with its migrations/ next to its dist/. Each image has only one of the
// two layouts, so the first path that exists is the right one.
export const MIGRATION_STEPS = [
  ["/app/dist/migrate.js", "/app/node_modules/@mnemo-ai/core/dist/migrate.js"],
  ["/app/v3/dist/migrate.js", "/app/node_modules/@mnemo-ai/adapter-postgres/dist/migrate.js"],
  ["/app/scripts/provision-app-role.mjs"],
];

export function resolveStep(candidates, exists = existsSync) {
  const found = candidates.find((path) => exists(path));
  if (!found) throw new Error(`migration step not found in this image: ${candidates.join(" or ")}`);
  return found;
}

export function runProductionMigrations(env = process.env) {
  const databaseUrl = resolveMigrationDatabaseUrl(env);
  const scripts = MIGRATION_STEPS.map((candidates) => resolveStep(candidates));
  for (const script of scripts) runNode(script, databaseUrl);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runProductionMigrations();
  } catch (error) {
    process.stderr.write(
      `[migrate-entrypoint] ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}
