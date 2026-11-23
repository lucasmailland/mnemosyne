import type postgres from "postgres";

export interface UserStatus {
  disabledAt: Date | null;
  sessionsValidAfter: Date;
  isSuperadmin: boolean;
}
export interface UserStatusSource {
  load(userId: string): Promise<UserStatus | null>;
}

interface StatusRow {
  disabled_at: Date | string | null;
  sessions_valid_after: Date | string;
  is_superadmin: boolean;
}

/**
 * Reads `mnemo_user_status` (SECURITY DEFINER) as app_user inside a transaction,
 * like PostgresCredentialStore. No tenant context is needed: the function takes
 * the user id explicitly and returns zero rows for an unknown user.
 */
export class PostgresUserStatusSource implements UserStatusSource {
  constructor(private sql: postgres.Sql) {}
  async load(userId: string): Promise<UserStatus | null> {
    const rows = (await this.sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      return tx<StatusRow[]>`SELECT * FROM mnemosyne.mnemo_user_status(${userId})`;
    })) as unknown as StatusRow[];
    const row = rows[0];
    if (!row) return null;
    // Drizzle shares this postgres-js client and installs string timestamp
    // codecs, so normalize to Date at the boundary.
    return {
      disabledAt: row.disabled_at === null ? null : new Date(row.disabled_at),
      sessionsValidAfter: new Date(row.sessions_valid_after),
      isSuperadmin: row.is_superadmin,
    };
  }
}

interface Entry {
  status: UserStatus | null;
  expires: number;
}

/**
 * Short-TTL cache over a status source. Fails closed: a source error
 * propagates and nothing is cached. `invalidate` bumps a per-user generation so
 * a load already in flight cannot repopulate the cache with a stale answer.
 */
export class UserStatusService {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, Entry>();
  private readonly generation = new Map<string, number>();

  constructor(
    private source: UserStatusSource,
    opts: { ttlMs?: number; now?: () => number } = {}
  ) {
    this.ttlMs = opts.ttlMs ?? 15_000;
    this.now = opts.now ?? Date.now;
  }

  async get(userId: string): Promise<UserStatus | null> {
    const hit = this.cache.get(userId);
    if (hit && hit.expires > this.now()) return hit.status;
    const gen = this.generation.get(userId) ?? 0;
    const status = await this.source.load(userId);
    if ((this.generation.get(userId) ?? 0) === gen) {
      this.cache.set(userId, { status, expires: this.now() + this.ttlMs });
    }
    return status;
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
    this.generation.set(userId, (this.generation.get(userId) ?? 0) + 1);
  }

  /** Session rule shared by bridge and /dashboard/auth/session. */
  sessionAllowed(status: UserStatus | null, issuedAtSeconds: number): boolean {
    if (!status || status.disabledAt) return false;
    return issuedAtSeconds * 1000 >= Math.ceil(status.sessionsValidAfter.getTime() / 1000) * 1000;
  }
}
