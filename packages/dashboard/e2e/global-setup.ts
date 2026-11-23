import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FullConfig } from "@playwright/test";
import { seedPalace } from "./seed";
import {
  ACCOUNTS,
  ADMIN_SESSION_FILE,
  EMPTY_SESSION_FILE,
  READER_SESSION_FILE,
  STATE_FILE,
  type E2EState,
} from "./support";

/**
 * Provisions a FRESH stack (docker/docker-compose.e2e.yml) for the specs:
 *
 * 1. POST /dashboard/bootstrap: first API key + the shared "E2E Team" workspace.
 * 2. One account per spec concern, created with the same admin script an
 *    operator runs in production (`node scripts/dashboard-password.mjs` inside
 *    the server container, password on stdin).
 * 3. A second membership for the multi-workspace account, inserted as the
 *    database superuser: the admin script deliberately never adds memberships
 *    to an existing user.
 *
 * 4. The palace's data (facts, a supersede, decisions, a conflict, an episode,
 *    entities) in the E2E Team workspace, through the API (seed.ts).
 *
 * It refuses an already bootstrapped stack instead of reusing it: lockouts and
 * rate-limit buckets from a previous run would change what the specs observe.
 */
const REPO_ROOT = resolve(__dirname, "../../..");
const COMPOSE_FILE = resolve(REPO_ROOT, "docker/docker-compose.e2e.yml");

function compose(args: string[], input?: string): string {
  return execFileSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function sql(query: string): string {
  return compose([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "mnemo_admin",
    "-d",
    "mnemosyne",
    "-tA",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    query,
  ]);
}

function setPassword(email: string, password: string, extra: string[] = []): void {
  compose(
    [
      "exec",
      "-T",
      "server",
      "node",
      "scripts/dashboard-password.mjs",
      "--email",
      email,
      "--create",
      ...extra,
    ],
    `${password}\n`
  );
}

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]!.use.baseURL!;

  const status = await fetch(`${baseURL}/dashboard/bootstrap/status`);
  if (!status.ok)
    throw new Error(`e2e: dashboard not reachable at ${baseURL} (HTTP ${status.status})`);
  if ((await status.json()).bootstrapped)
    throw new Error(
      "e2e: this stack is already bootstrapped. The specs need a fresh one: run `pnpm test:e2e:dashboard` " +
        "from the repo root, or `docker compose -f docker/docker-compose.e2e.yml down -v` and up again."
    );

  const teamWorkspaceId = randomUUID();
  const apiKey = `mns_test_${randomBytes(16).toString("hex")}`;
  const boot = await fetch(`${baseURL}/dashboard/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Same value as MNEMO_SETUP_TOKEN in docker/docker-compose.e2e.yml.
      "x-setup-token": process.env["MNEMO_SETUP_TOKEN"] ?? "e2e-setup-token-0123456789",
    },
    body: JSON.stringify({
      apiKey,
      workspaceId: teamWorkspaceId,
      label: "E2E Team",
      adminEmail: ACCOUNTS.admin.email,
      adminPassword: ACCOUNTS.admin.password,
    }),
  });
  if (boot.status !== 201)
    throw new Error(`e2e: bootstrap failed (HTTP ${boot.status}): ${await boot.text()}`);

  for (const account of Object.values(ACCOUNTS)) {
    if ("bootstrapAdmin" in account) continue; // created by the bootstrap above
    setPassword(
      account.email,
      account.password,
      "readerOfTeam" in account ? ["--workspace", teamWorkspaceId] : []
    );
  }

  sql(
    `INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
     SELECT ${literal(teamWorkspaceId)}, id, 'write' FROM mnemosyne.mnemo_user
      WHERE email = ${literal(ACCOUNTS.multi.email)}`
  );

  // Leaver Team: its only owner is `leaver`, so offboarding that account must
  // ask for a new owner. Not a personal tenant, like any team workspace.
  const leaverTeamId = randomUUID();
  const leaverTenantId = randomUUID();
  sql(
    `INSERT INTO mnemosyne.mnemo_tenant (id, name, kind) VALUES (${literal(leaverTenantId)}, 'Leaver Team', 'organization');
     INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id) VALUES (${literal(leaverTeamId)}, 'Leaver Team', ${literal(leaverTenantId)});
     INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role)
       SELECT ${literal(leaverTenantId)}, id, 'member' FROM mnemosyne.mnemo_user
        WHERE email IN (${literal(ACCOUNTS.leaver.email)}, ${literal(ACCOUNTS.heir.email)});
     INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
       SELECT ${literal(leaverTeamId)}, id,
              CASE WHEN email = ${literal(ACCOUNTS.leaver.email)} THEN 'owner' ELSE 'write' END
         FROM mnemosyne.mnemo_user
        WHERE email IN (${literal(ACCOUNTS.leaver.email)}, ${literal(ACCOUNTS.heir.email)})`
  );

  // Managed Team: a workspace the Installation spec manages as a non-member
  // superadmin (grantee owns it, heir reads).
  const managedTeamId = randomUUID();
  const managedTenantId = randomUUID();
  sql(
    `INSERT INTO mnemosyne.mnemo_tenant (id, name, kind) VALUES (${literal(managedTenantId)}, 'Managed Team', 'organization');
     INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id) VALUES (${literal(managedTeamId)}, 'Managed Team', ${literal(managedTenantId)});
     INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role)
       SELECT ${literal(managedTenantId)}, id, 'member' FROM mnemosyne.mnemo_user
        WHERE email IN (${literal(ACCOUNTS.grantee.email)}, ${literal(ACCOUNTS.heir.email)});
     INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
       SELECT ${literal(managedTeamId)}, id,
              CASE WHEN email = ${literal(ACCOUNTS.grantee.email)} THEN 'owner' ELSE 'read' END
         FROM mnemosyne.mnemo_user
        WHERE email IN (${literal(ACCOUNTS.grantee.email)}, ${literal(ACCOUNTS.heir.email)})`
  );

  // Orphan Team: a team workspace with no member at all, as one created with an
  // operator key is. The superadmin gives it an owner from All workspaces.
  sql(
    `INSERT INTO mnemosyne.mnemo_tenant (id, name, kind) VALUES (${literal(randomUUID())}, 'Orphan Team', 'organization');
     INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id)
       SELECT ${literal(randomUUID())}, 'Orphan Team', t.id FROM mnemosyne.mnemo_tenant t WHERE t.name = 'Orphan Team'`
  );

  const personalWorkspace = (email: string) =>
    sql(
      `SELECT w.name FROM mnemosyne.mnemo_workspace w
         JOIN mnemosyne.mnemo_workspace_member m ON m.workspace_id = w.id
         JOIN mnemosyne.mnemo_user u ON u.id = m.user_id
        WHERE u.email = ${literal(email)} AND m.role = 'owner'`
    );

  const state: E2EState = {
    apiKey,
    teamWorkspaceId,
    teamWorkspaceName: "E2E Team",
    ownerWorkspaceName: personalWorkspace(ACCOUNTS.owner.email),
    multiPersonalWorkspaceName: personalWorkspace(ACCOUNTS.multi.email),
    leaverTeamId,
    leaverTeamName: "Leaver Team",
    palace: seedPalace(apiKey),
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  // A session from an earlier stack is worthless; the gate specs sign in once per run.
  rmSync(ADMIN_SESSION_FILE, { force: true });
  rmSync(EMPTY_SESSION_FILE, { force: true });
  rmSync(READER_SESSION_FILE, { force: true });
}
