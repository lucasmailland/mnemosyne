# Mnemosyne — Codex / OpenAI Agents Guide

**Primary reference: [`CLAUDE.md`](./CLAUDE.md)** — read it before touching any code. Every fact there is verified against source files.

**Implementation status: [`docs/STATUS.md`](./docs/STATUS.md)** — what is actually working vs. stubbed.

---

## CI gate — all three must pass before merge

```bash
pnpm typecheck   # no TypeScript errors across all 18 workspace packages
pnpm build       # all packages build cleanly
pnpm test        # unit tests + purity guards + migration sequence guard
```

Integration tests (`pnpm test:integration`) require Docker (`pnpm docker:up`). GitHub Actions is off: the pre-push hook runs the sweep without them, and a release runs `FULL=1 bash scripts/full-sweep.sh`, which includes them (`docs/RELEASING.md`).

---

## 5 non-negotiable rules

### 1 — Hexagonal purity: `packages/core/src/cognitive/` has zero infrastructure imports

No `drizzle-orm`, `postgres`, `pg`, `ioredis`, `redis`, or `@neondatabase` imports are allowed inside `packages/core/src/cognitive/`. All I/O goes through port interfaces in `@mnemo-ai/types`.

Enforced by vitest purity guard tests (NOT lint scripts — do not invoke as lint):

- `packages/types/src/__tests__/purity.test.ts`
- `packages/core/src/__tests__/v3-purity.test.ts`

### 2 — All workspace-scoped `mnemo_*` queries MUST go through `withMnemoTx(workspaceId, fn)`

Every `mnemo_*` table has `ENABLE ROW LEVEL SECURITY` AND `FORCE ROW LEVEL SECURITY`. Bypassing `withMnemoTx` makes queries run under the superuser connection role, silently skipping RLS and leaking cross-workspace data.

```typescript
import { withMnemoTx } from "@mnemo-ai/core";
const result = await withMnemoTx(workspaceId, async (tx) => {
  return await storage.queryFacts({ workspaceId }, tx);
});
```

Source: `packages/core/src/tx.ts`

Tenant-scoped tables that do not have a single `workspace_id` (`mnemo_tenant`,
`mnemo_user`, `mnemo_tenant_member`, `mnemo_workspace`,
`mnemo_workspace_member`) are the exception: they must run inside an explicit
transaction that sets the tenant/user GUCs with `SET LOCAL` / `set_config(...,
true)` before any query. Use `withMnemoTenantTx` where Drizzle core tx is
available, or the server tenant-route transaction helper when using raw
`postgres.js`. Never run these queries with a bare pooled client.

### 3 — Sensitivity ceiling uses `SENSITIVITY_ORDER` numeric map — NEVER string equality (MED-23)

```typescript
import { SENSITIVITY_ORDER } from "@mnemo-ai/types";
// ✅ Correct
SENSITIVITY_ORDER[a] >= SENSITIVITY_ORDER[b];
// ❌ Wrong — alphabetic order ≠ sensitivity order
"confidential" > "internal";
```

Source: `packages/types/src/security.ts`

### 4 — Sensitivity ceiling violations return 404, not 403

Return 404 on ceiling violations to avoid confirming that the resource exists (anti-probing).

### 5 — The 9 relation verbs are locked — do not invent new ones

```
related | compatible | scoped | conflicts_with | supersedes
not_conflict | derived_from | part_of | member_of
```

These 9 verbs and only these 9 are valid. The SQL CHECK constraint in `0001_baseline.sql` enforces them at the database level. Adding a new verb requires a migration.

Source: `packages/types/src/relations.ts`

---

## Quick reference

| I need…                              | Where                             |
| ------------------------------------ | --------------------------------- |
| Full system overview                 | `docs/INDEX.md`                   |
| What's actually implemented          | `docs/STATUS.md`                  |
| Data model                           | `docs/architecture/DATA_MODEL.md` |
| HTTP API                             | `docs/architecture/API.md`        |
| All rules, traps, and verified enums | `CLAUDE.md`                       |

---

## Local Development & Client Configuration

For running and testing Mnemosyne locally with AI coding agents:

- **Server URL**: `http://localhost:3939`
- **Local Config**: `~/.mnemo/config.json`
  ```json
  {
    "url": "http://localhost:3939",
    "apiKey": "mns_live_localdevkey12345678901234567890"
  }
  ```
- **MCP Environment Variables**:
  - `MNEMO_URL=http://localhost:3939`
  - `MNEMO_KEY=mns_live_localdevkey12345678901234567890`
- **Auto-Installer**: Run `mnemo install` (or `node packages/cli/dist/index.js install`) to register the MCP server in Claude Code, Cursor, OpenCode, Codex, and Gemini CLI.
