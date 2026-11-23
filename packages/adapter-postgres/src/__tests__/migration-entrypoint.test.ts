import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MIGRATION_STEPS,
  resolveMigrationDatabaseUrl,
  resolveStep,
} from "../../../../docker/scripts/run-migrations.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("production migration entrypoint", () => {
  it("requires a dedicated migration URL and never falls back to DATABASE_URL", () => {
    expect(() =>
      resolveMigrationDatabaseUrl({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://app@pgbouncer:5435/mnemo",
      })
    ).toThrow(/MNEMO_MIGRATION_DATABASE_URL.*required/i);
  });

  it("rejects a dedicated URL using the known transaction-pool hostname", () => {
    expect(() =>
      resolveMigrationDatabaseUrl({
        NODE_ENV: "production",
        MNEMO_MIGRATION_DATABASE_URL: "postgres://admin@pgbouncer:5435/mnemo",
      })
    ).toThrow(/pgbouncer.*transaction.*unsupported/i);
  });

  it.each([
    "https://postgres.example.com/mnemo",
    "mysql://postgres.example.com/mnemo",
    "file:///tmp/mnemo",
  ])("rejects the non-PostgreSQL migration URL %s", (migrationUrl) => {
    expect(() =>
      resolveMigrationDatabaseUrl({
        NODE_ENV: "production",
        MNEMO_MIGRATION_DATABASE_URL: migrationUrl,
      })
    ).toThrow(/must use the postgres: or postgresql: protocol/i);
  });

  it("accepts an explicitly supplied direct PostgreSQL URL", () => {
    expect(
      resolveMigrationDatabaseUrl({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://app@pgbouncer:5435/mnemo",
        MNEMO_MIGRATION_DATABASE_URL: "postgres://admin@postgres:5432/mnemo",
      })
    ).toBe("postgres://admin@postgres:5432/mnemo");
  });

  it("accepts an explicitly supplied postgresql: URL", () => {
    expect(
      resolveMigrationDatabaseUrl({
        NODE_ENV: "production",
        MNEMO_MIGRATION_DATABASE_URL: "postgresql://admin@postgres:5432/mnemo",
      })
    ).toBe("postgresql://admin@postgres:5432/mnemo");
  });

  it("wires the Docker entrypoint and production compose to the dedicated URL", async () => {
    const [dockerfile, compose, productionCompose] = await Promise.all([
      readFile(resolve(ROOT, "docker/Dockerfile.migrate"), "utf8"),
      readFile(resolve(ROOT, "docker/docker-compose.yml"), "utf8"),
      readFile(resolve(ROOT, "docker/docker-compose.prod.yml"), "utf8"),
    ]);

    expect(dockerfile).toContain("run-migrations.mjs");
    expect(dockerfile).not.toMatch(/CMD.*dist\/migrate\.js/);
    expect(compose).toMatch(/migrate:[\s\S]*MNEMO_MIGRATION_DATABASE_URL:/);
    expect(productionCompose).toMatch(
      /migrate:[\s\S]*MNEMO_MIGRATION_DATABASE_URL:\s*\$\{MNEMO_MIGRATION_DATABASE_URL:\?/
    );
  });

  it("finds each step in the migrate image or in the server image's node_modules", () => {
    const migrateImage = new Set([
      "/app/dist/migrate.js",
      "/app/v3/dist/migrate.js",
      "/app/scripts/provision-app-role.mjs",
    ]);
    const serverImage = new Set([
      "/app/node_modules/@mnemo-ai/core/dist/migrate.js",
      "/app/node_modules/@mnemo-ai/adapter-postgres/dist/migrate.js",
      "/app/scripts/provision-app-role.mjs",
    ]);
    for (const image of [migrateImage, serverImage]) {
      const steps = MIGRATION_STEPS.map((candidates) =>
        resolveStep(candidates, (path: string) => image.has(path))
      );
      expect(new Set(steps)).toEqual(image);
    }
    expect(() => resolveStep(MIGRATION_STEPS[0]!, () => false)).toThrow(/not found in this image/);
  });
});
