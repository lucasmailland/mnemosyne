export type MigrationEnvironment = Record<string, string | undefined>;

export function resolveMigrationDatabaseUrl(env: MigrationEnvironment): string;

export function runProductionMigrations(env?: MigrationEnvironment): void;

export const MIGRATION_STEPS: readonly (readonly string[])[];

export function resolveStep(
  candidates: readonly string[],
  exists?: (path: string) => boolean
): string;
