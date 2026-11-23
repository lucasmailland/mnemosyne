import { createHash } from "node:crypto";
import bcrypt from "bcrypt";
import { WORKSPACE_ROLE_SCOPES } from "@mnemo-ai/types";
import type postgres from "postgres";
import type { RateLimitBackend } from "./ratelimit.js";

export const PASSWORD_COST = 12;
export const LOCK_FAILURES = 5;
export const LOCK_MS = 15 * 60_000;
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
export const emailIdentifier = (email: string): string =>
  createHash("sha256").update(normalizeEmail(email)).digest("hex");

export function passwordPolicyError(password: string, email: string): string | null {
  if ([...password].length < 12) return "Password must contain at least 12 characters.";
  if (Buffer.byteLength(password, "utf8") > 72) return "Password must be at most 72 UTF-8 bytes.";
  if (normalizeEmail(password) === normalizeEmail(email))
    return "Password must differ from your email.";
  return null;
}
export interface Credential {
  userId: string;
  email: string;
  passwordHash: string;
  passwordUpdatedAt: string;
  failedAttempts: number;
  lockedUntil: Date | null;
}
export interface Membership {
  id: string;
  name: string;
  role: "owner" | "admin" | "write" | "read";
}
export interface CredentialTx {
  credential: Credential | null;
  /** The credential's user is disabled (mnemo_user.disabled_at). False without a credential. */
  disabled: boolean;
  memberships(): Promise<Membership[]>;
  failure(attempts: number, until: Date | null): Promise<void>;
  resetFailures(): Promise<void>;
  /** Record a successful sign-in (mnemo_user.last_login_at). */
  touchLogin(): Promise<void>;
  /** Replace the hash and end every existing session (sessions_valid_after). */
  setPassword(hash: string): Promise<void>;
}
export interface CredentialStore {
  withEmail<T>(email: string, fn: (tx: CredentialTx) => Promise<T>): Promise<T>;
  withUser<T>(userId: string, fn: (tx: CredentialTx) => Promise<T>): Promise<T>;
}
interface PasswordCodec {
  compare(password: string, hash: string): Promise<boolean>;
  hash(password: string, cost: number): Promise<string>;
  dummyHash: string;
}
// Public, unusable dummy credential with the same work factor as real passwords.
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.3Y2bBJlBQLuNVrwp2Rz28Jh2lMkWyS6";
const codec: PasswordCodec = {
  compare: (password, hash) => bcrypt.compare(password, hash),
  hash: (password, cost) => bcrypt.hash(password, cost),
  dummyHash: DUMMY_HASH,
};
export interface PasswordIdentity {
  userId: string;
  passwordUpdatedAt: string;
  memberships: Membership[];
}

export class DashboardPasswordAuth {
  constructor(
    private store: CredentialStore,
    private passwords: PasswordCodec = codec,
    private now = Date.now
  ) {}

  /**
   * Compare outside any transaction. The bcrypt work (~cost 12) must never run
   * while a credential row lock or a pooled connection is held: concurrent
   * attempts on an existing account would queue behind it (staggered responses
   * reveal that the account exists) and a burst of logins would pin the pool.
   * Always compare, including missing users and locked accounts. Never replace
   * this with an early return or a wall-clock timing assertion in unit tests.
   */
  private compare(snapshot: Credential | null, password: string): Promise<boolean> {
    return this.passwords.compare(password, snapshot?.passwordHash ?? this.passwords.dummyHash);
  }

  /**
   * Record a comparison made against `snapshot`, under the row lock of `tx`.
   * The row is re-read under the lock, so lockout state is current; a password
   * replaced since the snapshot denies without counting a failure.
   */
  private async record(
    tx: CredentialTx,
    snapshot: Credential | null,
    matches: boolean
  ): Promise<boolean> {
    const row = tx.credential;
    if (!row || !snapshot || row.userId !== snapshot.userId) return false;
    if (row.passwordHash !== snapshot.passwordHash) return false;
    const now = this.now();
    if (row.lockedUntil && row.lockedUntil.getTime() > now) return false;
    if (!matches) {
      const attempts = (row.lockedUntil ? 0 : row.failedAttempts) + 1;
      await tx.failure(attempts, attempts >= LOCK_FAILURES ? new Date(now + LOCK_MS) : null);
      return false;
    }
    await tx.resetFailures();
    return true;
  }

  /**
   * Null for any refusal; "disabled" when the account exists but its user is
   * disabled, so the caller can audit the reason. Both get the same response.
   * A disabled account counts no failure and is refused whatever the password.
   */
  async login(email: string, password: string): Promise<PasswordIdentity | "disabled" | null> {
    const normalized = normalizeEmail(email);
    const snapshot = await this.store.withEmail(normalized, async (tx) => tx.credential);
    const matches = await this.compare(snapshot, password);
    // Same second transaction whether or not the account exists.
    return this.store.withEmail(normalized, async (tx) => {
      if (tx.disabled && snapshot && tx.credential?.userId === snapshot.userId) return "disabled";
      if (!(await this.record(tx, snapshot, matches))) return null;
      const memberships = await tx.memberships();
      if (!memberships.length) return null;
      return {
        userId: tx.credential!.userId,
        passwordUpdatedAt: tx.credential!.passwordUpdatedAt,
        memberships,
      };
    });
  }
  select(userId: string, version: string, workspaceId: string): Promise<Membership | null> {
    return this.store.withUser(userId, async (tx) => {
      if (!tx.credential || tx.disabled || tx.credential.passwordUpdatedAt !== version) return null;
      return (await tx.memberships()).find((member) => member.id === workspaceId) ?? null;
    });
  }
  async change(
    userId: string,
    currentPassword: string,
    newPassword: string
  ): Promise<"ok" | "invalid" | string> {
    const snapshot = await this.store.withUser(userId, async (tx) => tx.credential);
    const matches = await this.compare(snapshot, currentPassword);
    const error = snapshot ? passwordPolicyError(newPassword, snapshot.email) : null;
    // Hash the replacement before taking the lock, and only when it will be used.
    const hash =
      matches && snapshot && !error ? await this.passwords.hash(newPassword, PASSWORD_COST) : null;
    return this.store.withUser(userId, async (tx) => {
      if (tx.disabled) return "invalid";
      if (!(await this.record(tx, snapshot, matches))) return "invalid";
      if (error) return error;
      await tx.setPassword(hash!);
      return "ok";
    });
  }
  /**
   * Re-entry of a signed-in user's own password (superadmin grant/revoke).
   * Counts like a sign-in: a wrong password is a failure toward the lockout, a
   * right one resets the count, a locked or disabled account is refused.
   */
  async verify(userId: string, password: string): Promise<boolean> {
    const snapshot = await this.store.withUser(userId, async (tx) => tx.credential);
    const matches = await this.compare(snapshot, password);
    return this.store.withUser(userId, async (tx) => {
      if (tx.disabled) return false;
      return this.record(tx, snapshot, matches);
    });
  }
  /**
   * Hash a new password with the sign-in codec and cost (bcrypt, 12). Call it
   * outside any transaction, like every other bcrypt call here.
   */
  hashNew(password: string): Promise<string> {
    return this.passwords.hash(password, PASSWORD_COST);
  }
  /** Stamp last_login_at for a user who was just given a session. */
  touchLogin(userId: string): Promise<void> {
    return this.store.withUser(userId, (tx) => tx.touchLogin());
  }
}

type CredentialRow = Omit<Credential, "lockedUntil" | "passwordUpdatedAt"> & {
  lockedUntil: string | Date | null;
  passwordUpdatedAt: string | Date;
};

/** Scoped transactions for tenant/user tables; no bare pooled credential query. */
export class PostgresCredentialStore implements CredentialStore {
  constructor(private sql: postgres.Sql) {}
  private async transaction<T>(
    identity: { email: string } | { userId: string },
    fn: (tx: CredentialTx) => Promise<T>
  ): Promise<T> {
    return this.sql.begin(async (sql) => {
      await sql`SET LOCAL ROLE app_user`;
      await sql`SELECT set_config('mnemosyne.actor_user_id', ${"userId" in identity ? identity.userId : "__dashboard_login__"}, true), set_config('mnemosyne.actor_tenant_id', '', true)`;
      const rows =
        "email" in identity
          ? await sql<
              CredentialRow[]
            >`SELECT * FROM mnemosyne.mnemo_dashboard_credential_lookup(${identity.email})`
          : await sql<
              CredentialRow[]
            >`SELECT c.user_id AS "userId", u.email, c.password_hash AS "passwordHash", c.password_updated_at::text AS "passwordUpdatedAt", c.failed_attempts AS "failedAttempts", c.locked_until AS "lockedUntil" FROM mnemosyne.mnemo_user_credential c JOIN mnemosyne.mnemo_user u ON u.id = c.user_id WHERE c.user_id = ${identity.userId} FOR UPDATE OF c`;
      const row = rows[0];
      // Drizzle shares this postgres-js client and installs string timestamp
      // codecs. Normalize at the store boundary for both lookup paths.
      const credential: Credential | null = row
        ? {
            ...row,
            passwordUpdatedAt: new Date(row.passwordUpdatedAt).toISOString(),
            lockedUntil: row.lockedUntil === null ? null : new Date(row.lockedUntil),
          }
        : null;
      if (credential)
        await sql`SELECT set_config('mnemosyne.actor_user_id', ${credential.userId}, true)`;
      // Read through mnemo_user_own (actor = the credential's user). A row the
      // policy hides counts as disabled: refuse rather than guess.
      const [user] = credential
        ? await sql<
            { disabled: boolean }[]
          >`SELECT disabled_at IS NOT NULL AS disabled FROM mnemosyne.mnemo_user WHERE id = ${credential.userId}`
        : [];
      const disabled = credential ? (user?.disabled ?? true) : false;
      return fn({
        credential,
        disabled,
        memberships: async () =>
          credential
            ? sql<
                Membership[]
              >`SELECT w.id, w.name, m.role FROM mnemosyne.mnemo_workspace_member m JOIN mnemosyne.mnemo_workspace w ON w.id = m.workspace_id WHERE m.user_id = ${credential.userId} ORDER BY w.name, w.id`
            : [],
        failure: async (attempts, until) => {
          if (credential)
            await sql`UPDATE mnemosyne.mnemo_user_credential SET failed_attempts = ${attempts}, locked_until = ${until?.toISOString() ?? null} WHERE user_id = ${credential.userId}`;
        },
        resetFailures: async () => {
          if (credential)
            await sql`UPDATE mnemosyne.mnemo_user_credential SET failed_attempts = 0, locked_until = NULL WHERE user_id = ${credential.userId}`;
        },
        touchLogin: async () => {
          if (credential)
            await sql`UPDATE mnemosyne.mnemo_user SET last_login_at = clock_timestamp() WHERE id = ${credential.userId}`;
        },
        setPassword: async (hash) => {
          if (!credential) return;
          await sql`UPDATE mnemosyne.mnemo_user_credential SET password_hash = ${hash}, password_updated_at = clock_timestamp(), failed_attempts = 0, locked_until = NULL WHERE user_id = ${credential.userId}`;
          // Same transaction: every session minted before this instant dies.
          // No row updated would leave old sessions alive: roll back instead.
          const bumped =
            await sql`UPDATE mnemosyne.mnemo_user SET sessions_valid_after = clock_timestamp() WHERE id = ${credential.userId} RETURNING id`;
          if (!bumped.length) throw new Error("sessions_valid_after not updated");
        },
      });
    }) as Promise<T>;
  }
  withEmail<T>(email: string, fn: (tx: CredentialTx) => Promise<T>): Promise<T> {
    return this.transaction({ email }, fn);
  }
  withUser<T>(userId: string, fn: (tx: CredentialTx) => Promise<T>): Promise<T> {
    return this.transaction({ userId }, fn);
  }
}

/** The per-address sign-in bucket, shared by every public dashboard auth endpoint. */
export const dashboardIpKey = (ip: string): string => `dashboard:ip:${emailIdentifier(ip)}`;

export const DEFAULT_IP_BURST = 30;
const MAX_IP_BURST = 10_000;

/** A positive whole number up to 10000; anything else is the default of 30. */
export function parseIpBurst(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return DEFAULT_IP_BURST;
  const value = Number(raw.trim());
  return value >= 1 && value <= MAX_IP_BURST ? value : DEFAULT_IP_BURST;
}

/** Token buckets use opaque keys. Memory is bounded and has no background timer. */
export class DashboardLoginLimiter {
  private buckets = new Map<string, { tokens: number; time: number }>();
  /** Per-address tokens per 15 minutes (MNEMO_DASHBOARD_LOGIN_IP_BURST, default 30). */
  readonly ipBurst: number;
  constructor(
    private backend?: RateLimitBackend,
    private now = Date.now,
    env: Record<string, string | undefined> = process.env
  ) {
    this.ipBurst = parseIpBurst(env["MNEMO_DASHBOARD_LOGIN_IP_BURST"]);
  }
  private local(key: string, burst: number): number {
    const now = this.now();
    const old = this.buckets.get(key) ?? { tokens: burst, time: now };
    const tokens = Math.min(burst, old.tokens + (Math.max(0, now - old.time) * burst) / LOCK_MS);
    this.buckets.delete(key);
    this.buckets.set(key, { tokens: tokens >= 1 ? tokens - 1 : tokens, time: now });
    if (this.buckets.size > 10_000) this.buckets.delete(this.buckets.keys().next().value!);
    return tokens >= 1 ? 0 : Math.ceil(((1 - tokens) * LOCK_MS) / burst / 1000);
  }
  /** Sign-in attempts: per client address (ipBurst) and per email (10) every 15 minutes. */
  consume(ip: string, email: string): Promise<number> {
    return this.consumeKeys([
      [dashboardIpKey(ip), this.ipBurst],
      [`dashboard:email:${emailIdentifier(email)}`, 10],
    ]);
  }
  /** One token from the per-address bucket alone (the public link endpoints). */
  consumeIp(ip: string): Promise<number> {
    return this.consumeKeys([[dashboardIpKey(ip), this.ipBurst]]);
  }
  /**
   * Take one token from each bucket (key, burst per 15 minutes). Returns the
   * seconds to wait, 0 when every bucket allowed it.
   */
  async consumeKeys(entries: ReadonlyArray<readonly [string, number]>): Promise<number> {
    const local = Math.max(...entries.map(([key, burst]) => this.local(key, burst)));
    if (this.backend?.healthy) {
      try {
        const results = await Promise.all(
          entries.map(([key, burst]) =>
            this.backend!.consumeToken(key, burst / (LOCK_MS / 1000), burst)
          )
        );
        return Math.max(0, ...results.map((r) => (r.allowed ? 0 : r.resetSeconds)));
      } catch {
        /* The continuously maintained local buckets take over. */
      }
    }
    return local;
  }
}

export function membershipScopes(role: Membership["role"]): string[] {
  // Use the same workspace authority as API-key role narrowing, including
  // entity/session scopes required by the dashboard. Never grant tenant scopes.
  return Object.hasOwn(WORKSPACE_ROLE_SCOPES, role) ? [...WORKSPACE_ROLE_SCOPES[role]] : [];
}
