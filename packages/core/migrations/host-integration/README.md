# Host-integration migrations (NOT applied by `mnemo-migrate`)

These `.example` files are **not** part of the portable migration stream. The
`mnemo-migrate` CLI only discovers `*.sql` files in the parent directory, so
nothing here runs automatically.

They exist as reference for hosts (like Orchester) that have their own
first-class tables and want to weave Mnemosyne into them.

## `0036_agent_memory_policy`

Adds a `memory_policy jsonb` column to a host-owned `agent` table. The portable
`@mnemo-ai/core` does **not** own an `agent` table and never queries this
column — its `parseAgentMemoryPolicy(raw)` simply validates a policy object the
caller passes in (see `src/policy/index.ts`). If your application stores a
per-agent policy on your own `agent` rows, copy this file into your app's own
migration stream and adjust the table name to match your schema.
