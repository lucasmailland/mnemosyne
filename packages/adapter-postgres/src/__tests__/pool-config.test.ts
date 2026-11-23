import { describe, it, expect } from 'vitest';
import { makePoolConfigFromEnv } from '../pool-config.js';

describe('makePoolConfigFromEnv', () => {
  it('uses DATABASE_URL', () => {
    const cfg = makePoolConfigFromEnv({ DATABASE_URL: 'postgres://localhost/test' });
    expect(cfg.url).toBe('postgres://localhost/test');
  });

  it('falls back to MNEMO_DATABASE_URL', () => {
    const cfg = makePoolConfigFromEnv({ MNEMO_DATABASE_URL: 'postgres://localhost/fallback' });
    expect(cfg.url).toBe('postgres://localhost/fallback');
  });

  it('throws when no URL is set', () => {
    expect(() => makePoolConfigFromEnv({})).toThrow('DATABASE_URL is required');
  });

  it('has sensible defaults', () => {
    const cfg = makePoolConfigFromEnv({ DATABASE_URL: 'postgres://localhost/test' });
    expect(cfg.max).toBe(10);
    expect(cfg.idleTimeout).toBe(20);
    expect(cfg.maxLifetime).toBe(1800);
    // CHAOS-10: was 30 s, so requests hung up to 35 s with the database unreachable.
    expect(cfg.connectTimeout).toBe(10);
  });

  it('carries bounded PG-TIMEOUTS session limits by default', () => {
    const cfg = makePoolConfigFromEnv({ DATABASE_URL: 'postgres://localhost/test' });
    expect(cfg.sessionTimeouts).toEqual({
      statementTimeoutMs: 60_000,
      lockTimeoutMs: 15_000,
      idleInTransactionTimeoutMs: 60_000,
    });
  });

  it('fails fast on an invalid PG-TIMEOUTS value', () => {
    expect(() =>
      makePoolConfigFromEnv({
        DATABASE_URL: 'postgres://localhost/test',
        MNEMO_PG_STATEMENT_TIMEOUT_MS: '5000',
        MNEMO_PG_LOCK_TIMEOUT_MS: '9000',
      })
    ).toThrow(/shorter than/);
  });

  it('reads custom pool size from env', () => {
    const cfg = makePoolConfigFromEnv({ DATABASE_URL: 'postgres://localhost/test', MNEMO_PG_POOL_MAX: '25' });
    expect(cfg.max).toBe(25);
  });

  it('sets replicaUrl when DATABASE_REPLICA_URL is present', () => {
    const cfg = makePoolConfigFromEnv({
      DATABASE_URL: 'postgres://primary/test',
      DATABASE_REPLICA_URL: 'postgres://replica/test',
    });
    expect(cfg.replicaUrl).toBe('postgres://replica/test');
  });

  it('leaves replicaUrl undefined when DATABASE_REPLICA_URL is absent', () => {
    const cfg = makePoolConfigFromEnv({ DATABASE_URL: 'postgres://localhost/test' });
    expect(cfg.replicaUrl).toBeUndefined();
  });

  it('falls back to default when pool size env var is not a number', () => {
    const cfg = makePoolConfigFromEnv({ DATABASE_URL: 'postgres://localhost/test', MNEMO_PG_POOL_MAX: 'abc' });
    expect(cfg.max).toBe(10);
  });

  it('MNEMO_DEPLOY_MODE=ha defaults pool max to 20', () => {
    const cfg = makePoolConfigFromEnv({ MNEMO_DEPLOY_MODE: 'ha', DATABASE_URL: 'postgres://x' } as any);
    expect(cfg.max).toBe(20);
  });

  it('MNEMO_DEPLOY_MODE=embedded defaults pool max to 5', () => {
    const cfg = makePoolConfigFromEnv({ MNEMO_DEPLOY_MODE: 'embedded', DATABASE_URL: 'postgres://x' } as any);
    expect(cfg.max).toBe(5);
  });

  it('explicit MNEMO_PG_POOL_MAX overrides the mode default', () => {
    const cfg = makePoolConfigFromEnv({ MNEMO_DEPLOY_MODE: 'ha', MNEMO_PG_POOL_MAX: '7', DATABASE_URL: 'postgres://x' } as any);
    expect(cfg.max).toBe(7);
  });

  it('no mode + no explicit max keeps the current default (standalone=10)', () => {
    const cfg = makePoolConfigFromEnv({ DATABASE_URL: 'postgres://x' } as any);
    expect(cfg.max).toBe(10);
  });
});
