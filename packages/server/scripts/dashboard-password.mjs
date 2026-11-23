#!/usr/bin/env node
// Administrative DB access only. Does not load dotenv or accept password args.
import postgres from "postgres";
import bcrypt from "bcrypt";
import { normalizeEmail, passwordPolicyError } from "../dist/dashboard-password.js";

const inputError = (message) => Object.assign(new Error(message), { safe: true });
const usage =
  "Usage: node packages/server/scripts/dashboard-password.mjs --email <email> [--create] [--workspace <id>] [--superadmin] < password-from-stdin";
async function main() {
  const args = process.argv.slice(2);
  let email,
    workspaceId,
    create = false,
    superadmin = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--email" && !email) email = args.shift();
    else if (arg === "--workspace" && !workspaceId) workspaceId = args.shift();
    else if (arg === "--create" && !create) create = true;
    else if (arg === "--superadmin" && !superadmin) superadmin = true;
    else throw inputError(usage);
  }
  if (!email || !email.includes("@") || email.length > 254 || (workspaceId && !create))
    throw inputError(usage);
  email = normalizeEmail(email);
  if (process.stdin.isTTY)
    throw inputError("Supply the password on stdin through a pipe with terminal echo disabled.");
  let input = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    input = Buffer.concat([input, Buffer.from(chunk)]);
    if (input.length > 1024) throw inputError("Password input is too large.");
  }
  const password = input.toString("utf8").replace(/\r?\n$/, "");
  input.fill(0);
  const error = passwordPolicyError(password, email);
  if (error) throw inputError(error);
  if (!process.env.DATABASE_URL)
    throw inputError("DATABASE_URL must already be provided by the administrator.");
  // The superadmin table accepts no write from the app role: break-glass needs
  // an administrator connection, separate from DATABASE_URL.
  const adminUrl = process.env.MNEMO_ADMIN_DATABASE_URL;
  if (superadmin && !adminUrl)
    throw inputError(
      "--superadmin needs MNEMO_ADMIN_DATABASE_URL (the migration owner connection) provided by the administrator."
    );
  const hash = await bcrypt.hash(password, 12);
  let grantedUserId;
  const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      // mnemosyne.region: a personal workspace provisioned here gets the
      // instance's region (the mnemo_workspace.region default, migration 0062).
      await tx`SELECT set_config('mnemosyne.actor_user_id', '', true), set_config('mnemosyne.actor_tenant_id', '', true), set_config('mnemosyne.region', ${process.env.MNEMO_REGION ?? ""}, true)`;
      // Serialize provisioning/password resets for the same normalized email.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${email}, 0))`;
      const users =
        await tx`SELECT id, disabled_at FROM mnemosyne.mnemo_user WHERE lower(btrim(email)) = ${email}`;
      if (users.length > 1)
        throw inputError("Email is ambiguous; resolve duplicate case variants first.");
      if (superadmin && users[0]?.disabled_at)
        throw inputError("User is disabled; enable the account before granting superadmin.");
      let userId = users[0]?.id;
      if (!userId && !create)
        throw inputError("User does not exist. Provision the user first, or pass --create.");
      let targetTenant;
      if (!userId) {
        if (workspaceId) {
          const rows = await tx`SELECT mnemosyne.mnemo_workspace_tenant_id(${workspaceId}) AS id`;
          targetTenant = rows[0]?.id;
          if (!targetTenant) throw inputError("Workspace does not exist.");
          await tx`SELECT set_config('mnemosyne.actor_tenant_id', ${targetTenant}, true)`;
        }
        // Keep a personal tenant for the user model, but --workspace grants
        // exactly that workspace: no implicit Personal workspace or selector.
        await tx`RESET ROLE`;
        if (targetTenant) {
          const [personal] =
            await tx`SELECT tenant_id FROM mnemosyne.mnemo_provision_tenant(${email}, 'personal', 'free', NULL)`;
          await tx`SET LOCAL ROLE app_user`;
          const [user] =
            await tx`INSERT INTO mnemosyne.mnemo_user (email, display_name, personal_tenant_id, provisioned_by_tenant_id) VALUES (${email}, ${email}, ${personal.tenant_id}, ${targetTenant}) RETURNING id`;
          userId = user.id;
          await tx`SELECT set_config('mnemosyne.actor_tenant_id', ${personal.tenant_id}, true)`;
          await tx`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${personal.tenant_id}, ${userId}, 'owner')`;
          await tx`SELECT set_config('mnemosyne.actor_tenant_id', ${targetTenant}, true)`;
        } else {
          const [user] =
            await tx`SELECT user_id FROM mnemosyne.mnemo_provision_user(${email}, ${email}, ${"Personal"})`;
          userId = user.user_id;
          await tx`SET LOCAL ROLE app_user`;
        }
        if (targetTenant) {
          await tx`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${targetTenant}, ${userId}, 'member')`;
          await tx`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'read')`;
        }
      }
      await tx`SELECT set_config('mnemosyne.actor_user_id', ${userId}, true)`;
      await tx`INSERT INTO mnemosyne.mnemo_user_credential (user_id, password_hash) VALUES (${userId}, ${hash}) ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_updated_at = clock_timestamp(), failed_attempts = 0, locked_until = NULL`;
      // A reset ends every open session, as a reset link does. The own-row
      // policy admits this as app_user once actor_user_id names the user.
      const ended =
        await tx`UPDATE mnemosyne.mnemo_user SET sessions_valid_after = clock_timestamp() WHERE id = ${userId} RETURNING id`;
      if (ended.length !== 1) throw new Error("sessions not ended");
      grantedUserId = userId;
    });
    if (superadmin) {
      const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
      try {
        // Idempotent; the disabled check repeats here because the user may have
        // been disabled since the transaction above.
        const rows = await admin`
          INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by)
          SELECT id, 'system:script' FROM mnemosyne.mnemo_user WHERE id = ${grantedUserId} AND disabled_at IS NULL
          ON CONFLICT (user_id) DO NOTHING RETURNING user_id`;
        if (!rows.length) {
          const [existing] =
            await admin`SELECT 1 AS ok FROM mnemosyne.mnemo_instance_admin WHERE user_id = ${grantedUserId}`;
          if (!existing)
            throw inputError(
              "Password set, but the user is disabled so superadmin was not granted."
            );
        }
      } catch (error) {
        if (error?.safe === true) throw error;
        throw inputError(
          "Password set, but the superadmin grant failed. Check MNEMO_ADMIN_DATABASE_URL and migrations."
        );
      } finally {
        await admin.end();
      }
      process.stdout.write("Superadmin granted.\n");
    }
    process.stdout.write("Password set successfully.\n");
  } catch (error) {
    // Never print database errors: drivers can include SQL parameter values.
    if (error?.safe === true) throw error;
    throw inputError("Could not set password. Check database permissions and migrations.");
  } finally {
    await sql.end();
  }
}
main().catch((error) => {
  process.stderr.write(
    `${error?.safe === true ? error.message : "Could not set password. Check database permissions and migrations."}\n`
  );
  process.exitCode = 1;
});
