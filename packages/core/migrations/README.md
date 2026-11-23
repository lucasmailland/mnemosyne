# Core Migrations (v2 schema stream)

**Scope:** This directory is the migration stream for the v2 tables of
`@mnemo-ai/core`. It is shipped inside the `mnemosyne-migrate` Docker image and run by the
`mnemo-migrate` CLI, before the v3 stream.

> The v3 (`mnemosyne` schema) migrations live in
> [`packages/adapter-postgres/migrations/baseline/`](../../adapter-postgres/migrations/baseline/);
> see the "Running Migrations" section of the [adapter-postgres README](../../adapter-postgres/README.md).

## How migrations run in production

The `mnemo-migrate` binary (declared as `bin.mnemo-migrate` in `package.json`) runs every
pending `.sql` file in this directory in lexical filename order. The Docker Compose stack gates
the server on `service_completed_successfully` from the migrate service — a failed migration
prevents the server from booting.

```bash
# Runs automatically in Docker
docker compose up migrate

# Or manually (requires DATABASE_URL in environment)
mnemo-migrate
```

Applied files are recorded by **filename** in `mnemo_migration_history`. Unlike the v3 stream
there is no checksum: editing an applied file is not detected, it just never runs again on that
database. That makes the rule below even more important here.

## Migration numbering

Files are numbered `NNNN_description.sql`. The numbering has gaps (e.g. 0018 → 0020) — they
are migrations that were reserved or removed.

Two files share the prefix `0064` (`0064_api_keys_lookup_hash.sql` and
`0064_mnemo_decision_confidence.sql`). They stay as they are: the history table keys on the
full filename, so both are tracked and they run in lexical order, while renaming either would
make every database that already applied it run it again under the new name.

**Do not renumber or rename existing files, and never edit one that has been pushed.** To
change what a pushed migration did, add a new file with the next number.

## Down migrations

Most files have a `.down.sql` companion, but not all: 0065, 0066, 0067 and 0074 have none.
`mnemo-migrate` never applies down files (run them by hand with `psql` if you must roll back),
and no test requires them.

## Adding a migration

1. Pick the next available number (check the highest existing `NNNN`).
2. Create `NNNN_description.sql`, and `NNNN_description.down.sql` when the change can be
   reversed.
3. Write the up migration; write the down migration to exactly reverse it.
4. Test locally: `docker compose up migrate` on a fresh database.
