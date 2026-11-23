#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * create-api-key.js
 *
 * Why this script exists:
 *   Bootstrapping a self-hosted Mnemosyne instance has a chicken-and-egg
 *   problem — the HTTP API requires an API key, but there's no UI yet to
 *   mint the first key. This script connects directly to Postgres and
 *   inserts a fresh key, so the operator can immediately make their first
 *   authenticated request.
 *
 * Why hardcode the INSERT (instead of importing from @mnemosyne/server)?
 *   - We want this script to work in a minimal runtime image where the
 *     server's full ORM/migration code may not be loaded. The schema for
 *     `mnemo_api_keys` is stable and owned by the server's migrations.
 *   - The script is intentionally dumb: it does one thing, prints one line,
 *     exits. No flags parsing beyond `--workspace`. No interactive prompts.
 *
 * Why `postgres` (postgres-js) and not `pg`?
 *   The server image ships `postgres` (postgres-js) — that's the driver
 *   @mnemosyne/core dynamic-imports for migrations and queries. `pg` is
 *   NOT in the deployed node_modules, so we use the same `postgres` client
 *   the server uses. Resolving from the deployed node_modules avoids adding
 *   any extra runtime cost.
 *
 * Usage:
 *   docker compose exec server node scripts/create-api-key.cjs [--label "my laptop"]
 *
 *   --workspace is optional and must be a UUID when given; omit it and a fresh
 *   workspace UUID is generated. (There is no `ws_default` — the v3 runtime
 *   casts workspace_id to ::uuid.)
 *
 * Output:
 *   A single line to stdout:
 *     mns_live_<24-char-id>
 *
 *   Errors go to stderr; exit code is non-zero on failure.
 */

const crypto = require("node:crypto");

// ---------- workspace UUID helpers ----------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}
function resolveWorkspace(w) {
  if (w == null || w === "") return crypto.randomUUID();
  if (!isUuid(w))
    throw new Error(
      `--workspace must be a UUID (got "${w}"). The v3 runtime casts workspace_id to ::uuid; non-uuid workspaces return HTTP 500.`
    );
  return w;
}

// ---------- arg parsing (intentionally minimal) ----------
/** Scopes of the full-access key this script mints for the installation's owner. */
const MINTED_SCOPES = [
    "memory:read",
    "memory:write",
    "memory:delete",
    "memory:admin",
    "memory:export",
    "memory:governance",
    "memory:task",
    "memory:event",
    "memory:session",
    "memory:reasoning",
    "memory:procedural",
    "memory:self_edit",
    "memory:subscribe",
    "memory:federation",
    "memory:hard_delete",
    // Peer trust administration (federation peer approve/reject/revoke) —
    // not in SPEC_SCOPES / mintable by workspace flows, but this script
    // mints a full-access dev/bootstrap key, so it needs it explicitly or
    // dev keys silently lose the 5 peer-management routes.
    "federation:admin",
  // APP-040: manage keys in the dashboard. With memory:admin it makes the
  // installation's own key an admin there instead of a contributor.
  "admin:keys",
];

function parseArgs(argv) {
  const args = { workspace: null, label: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace" || a === "-w") {
      args.workspace = argv[++i];
    } else if (a === "--label" || a === "-l") {
      args.label = argv[++i];
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  process.stderr.write(
    [
      "Usage: create-api-key.js [--workspace <uuid>] [--label <text>]",
      "",
      "Creates a new API key for the given workspace and prints it.",
      "The plaintext key is shown exactly once — store it now.",
      "",
      "Options:",
      "  --workspace <uuid>  Workspace UUID (generated if omitted)",
      '  --label <text>      Human-readable label (default: "bootstrap")',
      "",
    ].join("\n")
  );
}

// ---------- key generation ----------
// Format: mns_live_<base32(24 chars)>
// - `mns_live_` prefix lets us cheaply detect a leaked key in logs/regex,
//   and leaves room for a future `mns_test_` namespace.
// - Base32 (Crockford-ish, no padding) is URL-safe and easier to copy from
//   a terminal than base64 (no +/=).
const BASE32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function generateKey() {
  const bytes = crypto.randomBytes(15); // 15 bytes -> 24 base32 chars
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return `mns_live_${out.slice(0, 24)}`;
}

// Hash for storage at rest. We store the hash, not the plaintext, so a DB
// dump can't be replayed against the API.
//
// MUST be bcrypt cost 12 — this has to match exactly what the live auth
// middleware verifies with. `server/src/auth.ts` exports BCRYPT_COST = 12
// and hashes via `bcrypt.hash(plaintext, BCRYPT_COST)`; the middleware then
// authenticates by `bcrypt.compare(token, key_hash)`. If we wrote any other
// format (e.g. sha256) the key would be un-verifiable and auth would reject
// it. The bcrypt module is loaded lazily in main() (same `bcrypt` the server
// depends on) so the help/arg-error paths don't pay the import cost.
const BCRYPT_COST = 12;
async function hashKey(plaintext, bcrypt) {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

// ---------- key + workspace ----------
/**
 * APP-050 (audit 2026-11-22): insert the key, and when its workspace does not
 * exist yet create it (with its tenant) in the same transaction, the way
 * POST /bootstrap does. The key used to be inserted alone, so its workspace had
 * no row: memory_workspace answered 404 for it and the dashboard listed none.
 */
async function registerKey(sql, { keyId, workspaceId, hashed, lookupHash, label, scopes, arrayOid }) {
  await sql.begin(async (tx) => {
    const existing = await tx`
      select id from mnemosyne.mnemo_workspace where id = ${workspaceId} limit 1
    `;
    if (existing.length === 0) {
      const tenantId = crypto.randomUUID();
      await tx`select set_config('mnemosyne.tenant_id', ${tenantId}, true)`;
      await tx`select set_config('mnemosyne.user_id', ${"bootstrap"}, true)`;
      await tx`select set_config('mnemosyne.region', ${process.env.MNEMO_REGION ?? ""}, true)`;
      await tx`
        insert into mnemosyne.mnemo_tenant (id, name, kind, plan)
        values (${tenantId}, 'default', 'personal', 'free')
        on conflict (id) do nothing
      `;
      await tx`
        insert into mnemosyne.mnemo_workspace (id, name, tenant_id, visibility)
        values (${workspaceId}, ${label === "bootstrap" ? "default" : label}, ${tenantId}, 'private')
        on conflict (id) do nothing
      `;
    }
    await tx`
      insert into mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, lookup_hash, name, label, scopes)
      values (${keyId}, ${workspaceId}, ${hashed}, ${lookupHash}, ${label}, ${label}, ${tx.array(scopes, arrayOid)})
    `;
  });
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  let workspaceId;
  try {
    workspaceId = resolveWorkspace(args.workspace);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    printHelp();
    process.exit(2);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    process.stderr.write("error: DATABASE_URL is not set in the environment\n");
    process.exit(2);
  }

  // Lazy-require so the help/arg-error paths don't pay the import cost,
  // and so a missing dependency produces an actionable message.
  //
  // `postgres` (postgres-js) is the driver the server image actually ships
  // (`@mnemosyne/core` dynamic-imports it). `bcrypt` is a direct dep of
  // @mnemosyne/server — we use the same module so our stored hash matches
  // what the auth middleware verifies.
  let postgres;
  let bcrypt;
  try {
    postgres = require("postgres");
    bcrypt = require("bcrypt");
  } catch (err) {
    process.stderr.write(
      "error: could not load 'postgres' and 'bcrypt' from server dependencies. " +
        "Are you running this inside the mnemosyne-server container?\n"
    );
    process.exit(2);
  }

  const plaintext = generateKey();
  const hashed = await hashKey(plaintext, bcrypt); // bcrypt $2b$ hash, cost 12
  const keyId = `key_${crypto.randomBytes(12).toString("hex")}`;
  const label = args.label ?? "bootstrap";

  // postgres-js: a single short-lived connection is enough for one insert.
  const sql = postgres(dbUrl, { max: 1, onnotice: () => undefined });
  try {
    // Schema reference (owned by @mnemosyne/server migration 0001):
    //   mnemo_api_keys (
    //     id            text primary key,
    //     workspace_id  text not null,
    //     key_hash      text not null unique,   -- bcrypt $2b$… (cost 12)
    //     label         text not null default '',
    //     created_at    timestamptz not null default now(),
    //     last_used_at  timestamptz,
    //     revoked_at    timestamptz
    //   )
    //
    const ALL_SCOPES = MINTED_SCOPES;

    // 1009 is `_text` — the OID of text[] ITSELF, not of its element type.
    //
    // That distinction is the whole bug. `sql.array(x)` with no type infers
    // from x[0] and lands on 25 (text), then looks 25 up in
    // `options.shared.typeArrayMap` to find the matching array OID. That map is
    // populated by the type-fetch postgres-js runs when a connection is
    // established — and this script's INSERT is the FIRST query on a
    // brand-new connection, so the lookup misses and the parameter is sent as
    // `x.toString()`: `memory:read,memory:write,…`, no braces, type text.
    // Postgres then rejects it with
    //   column "scopes" is of type text[] but expression is of type text
    // (and `malformed array literal` if you "fix" it by adding a ::text[] cast).
    //
    // Passing the array OID directly skips the map entirely, so it is correct on
    // a cold connection as well as a warm one. Verified both ways: with 25 the
    // same INSERT succeeds only if some other query ran first, which is exactly
    // the kind of ordering dependency a bootstrap script must not have.
    const TEXT_ARRAY_OID = 1009;

    function computeLookupHash(t) {
      const pepper = process.env.MNEMO_KEY_PEPPER ?? "";
      return crypto.createHmac("sha256", pepper).update(t).digest("hex");
    }
    const lookupHash = computeLookupHash(plaintext);

    await registerKey(sql, {
      keyId,
      workspaceId,
      hashed,
      lookupHash,
      label,
      scopes: ALL_SCOPES,
      arrayOid: TEXT_ARRAY_OID,
    });
  } catch (err) {
    process.stderr.write(`error: failed to insert API key: ${err.message}\n`);
    process.exit(1);
  } finally {
    await sql.end().catch(() => {});
  }

  // The contract: one clean line to stdout. Scripts piping us (e.g.
  // `KEY=$(docker compose exec ...)`) depend on this.
  process.stdout.write(plaintext + "\n");
}

if (typeof module !== "undefined") {
  module.exports = { ...(module.exports || {}), isUuid, resolveWorkspace, registerKey, MINTED_SCOPES };
}

// Only run when invoked directly (not when require()d by tests)
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`error: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
