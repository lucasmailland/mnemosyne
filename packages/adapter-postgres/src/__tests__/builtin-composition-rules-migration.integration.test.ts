// Integration test for RDD-7: Verify built-in composition rules are seeded with correct confidences
// Tests that migration 0011 correctly seeds the 3 built-in composition rule templates

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { createDrizzleClient, DrizzleStorageAdapter } from '../DrizzleStorageAdapter';
import { migrate } from '../migrate';
import postgres from 'postgres';
import { customAlphabet } from 'nanoid';

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

const PG_IMAGE = 'pgvector/pgvector:pg17';
const PG_USER = 'mnemo_test';
const PG_PASSWORD = 'mnemo_test';
const PG_DB = 'mnemo_test';

describe('Built-in composition rules migration — RDD-7', () => {
  let container: StartedTestContainer | undefined;
  let sql: ReturnType<typeof postgres>;
  let adapter: DrizzleStorageAdapter;
  let workspaceId: string;

  beforeAll(async () => {
    // Each integration suite is hermetic: spin up its own pgvector container.
    // TEST_DATABASE_URL, when set, skips the container for fast local runs.
    let databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) {
      container = await new GenericContainer(PG_IMAGE)
        .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
        .start();
      databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${PG_DB}`;
    }

    sql = postgres(databaseUrl, { max: 1 });
    await migrate({ databaseUrl });
    const { db, pgClient } = createDrizzleClient(databaseUrl);
    adapter = new DrizzleStorageAdapter(db, pgClient);

    // Create a test workspace. workspace_id is passed to mnemo_seed_builtin_rules,
    // which casts it to ::uuid, so the id MUST be a valid UUID. tenant_id is NOT NULL.
    workspaceId = crypto.randomUUID();
    await sql`
      INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id, created_at)
      VALUES (${workspaceId}, 'Test Workspace', ${`tenant-test-${nanoid(8)}`}, NOW())
      ON CONFLICT (id) DO NOTHING
    `;

    // Seed the per-workspace copies of the built-in composition rule templates.
    await sql`SELECT mnemosyne.mnemo_seed_builtin_rules(${workspaceId}::uuid)`;
  }, 120_000);

  afterAll(async () => {
    if (workspaceId) {
      await sql`DELETE FROM mnemosyne.mnemo_workspace WHERE id = ${workspaceId}`;
    }
    await sql.end();
    await container?.stop();
  });

  describe('Template seeding', () => {
    it('seeds builtin_transitive_part_of with confidence 0.8', async () => {
      const [template] = await sql<Array<{ id: string; action_dsl: any }>>`
        SELECT id, action_dsl
        FROM mnemosyne.mnemo_composition_rule_template
        WHERE id = 'builtin_transitive_part_of'
      `;

      expect(template).toBeDefined();
      if (!template) throw new Error('template not found');
      expect(template.action_dsl.baseConfidence).toBe(0.8);
    });

    it('seeds builtin_conflict_propagation with confidence 0.5 and correct verbs', async () => {
      const [template] = await sql<Array<{ id: string; condition_dsl: any; action_dsl: any }>>`
        SELECT id, condition_dsl, action_dsl
        FROM mnemosyne.mnemo_composition_rule_template
        WHERE id = 'builtin_conflict_propagation'
      `;

      expect(template).toBeDefined();
      if (!template) throw new Error('template not found');
      expect(template.action_dsl.baseConfidence).toBe(0.5);

      // Verify verb pattern: conflicts_with + supersedes (NOT conflicts_with + related)
      const clauses = template.condition_dsl.all;
      expect(clauses).toHaveLength(2);
      expect(clauses[0].verb).toBe('conflicts_with');
      expect(clauses[1].verb).toBe('supersedes'); // The spec requires 'supersedes', not 'related'
    });

    it('seeds builtin_scope_inheritance with confidence 0.6 and correct verbs', async () => {
      const [template] = await sql<Array<{ id: string; condition_dsl: any; action_dsl: any }>>`
        SELECT id, condition_dsl, action_dsl
        FROM mnemosyne.mnemo_composition_rule_template
        WHERE id = 'builtin_scope_inheritance'
      `;

      expect(template).toBeDefined();
      if (!template) throw new Error('template not found');
      expect(template.action_dsl.baseConfidence).toBe(0.6);

      // Verify verb pattern: scoped + scoped (NOT scoped + related)
      const clauses = template.condition_dsl.all;
      expect(clauses).toHaveLength(2);
      expect(clauses[0].verb).toBe('scoped');
      expect(clauses[1].verb).toBe('scoped'); // The spec requires 'scoped', not 'related'
    });
  });

  describe('Per-workspace rule copies', () => {
    it('creates workspace-scoped copy of transitive_part_of with confidence 0.8', async () => {
      const rules = await adapter.queryCompositionRules({
        workspaceId,
        limit: 100,
      });

      const transitiveRule = rules.items.find((r: any) => r.id.includes('builtin_transitive_part_of'));
      expect(transitiveRule).toBeDefined();

      const actionDsl = transitiveRule!.actionDsl as any;
      expect(actionDsl.baseConfidence).toBe(0.8);
    });

    it('creates workspace-scoped copy of conflict_propagation with confidence 0.5', async () => {
      const rules = await adapter.queryCompositionRules({
        workspaceId,
        limit: 100,
      });

      const conflictRule = rules.items.find((r: any) => r.id.includes('builtin_conflict_propagation'));
      expect(conflictRule).toBeDefined();

      const actionDsl = conflictRule!.actionDsl as any;
      expect(actionDsl.baseConfidence).toBe(0.5);

      const conditionDsl = conflictRule!.conditionDsl as any;
      expect(conditionDsl.all[1].verb).toBe('supersedes');
    });

    it('creates workspace-scoped copy of scope_inheritance with confidence 0.6', async () => {
      const rules = await adapter.queryCompositionRules({
        workspaceId,
        limit: 100,
      });

      const scopeRule = rules.items.find((r: any) => r.id.includes('builtin_scope_inheritance'));
      expect(scopeRule).toBeDefined();

      const actionDsl = scopeRule!.actionDsl as any;
      expect(actionDsl.baseConfidence).toBe(0.6);

      const conditionDsl = scopeRule!.conditionDsl as any;
      expect(conditionDsl.all[1].verb).toBe('scoped');
    });
  });

  describe('Regression tests — prevent drift', () => {
    it('Pattern A is NOT 0.85 or 0.9', async () => {
      const [template] = await sql<Array<{ action_dsl: any }>>`
        SELECT action_dsl
        FROM mnemosyne.mnemo_composition_rule_template
        WHERE id = 'builtin_transitive_part_of'
      `;

      if (!template) throw new Error('template not found');
      const conf = template.action_dsl.baseConfidence;
      expect(conf).not.toBe(0.85);
      expect(conf).not.toBe(0.9);
    });

    it('Pattern B is NOT 0.65 or 0.7, and uses supersedes (not related)', async () => {
      const [template] = await sql<Array<{ condition_dsl: any; action_dsl: any }>>`
        SELECT condition_dsl, action_dsl
        FROM mnemosyne.mnemo_composition_rule_template
        WHERE id = 'builtin_conflict_propagation'
      `;

      if (!template) throw new Error('template not found');
      const conf = template.action_dsl.baseConfidence;
      expect(conf).not.toBe(0.65);
      expect(conf).not.toBe(0.7);

      const verb2 = template.condition_dsl.all[1].verb;
      expect(verb2).not.toBe('related');
    });

    it('Pattern C is NOT 0.7 or 0.8, and uses scoped (not related)', async () => {
      const [template] = await sql<Array<{ condition_dsl: any; action_dsl: any }>>`
        SELECT condition_dsl, action_dsl
        FROM mnemosyne.mnemo_composition_rule_template
        WHERE id = 'builtin_scope_inheritance'
      `;

      if (!template) throw new Error('template not found');
      const conf = template.action_dsl.baseConfidence;
      expect(conf).not.toBe(0.7);
      expect(conf).not.toBe(0.8);

      const verb2 = template.condition_dsl.all[1].verb;
      expect(verb2).not.toBe('related');
    });
  });
});
