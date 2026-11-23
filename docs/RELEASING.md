# Releasing Mnemosyne

**English** · [Español](RELEASING.es.md)

## How releases work today

Releases are **manual**. GitHub Actions is turned off for this repository, so nothing in
`.github/workflows/` runs: not CI, not release-please, not `docker-publish.yml`, not
`deploy-canary.yml`. The release-please files (`.github/release-please-config.json` and
`.github/.release-please-manifest.json`) are kept for when CI is turned back on; the manifest
mirrors the versions in the `package.json` files.

### The release gate

Before every release, run the full sweep locally (Docker must be running) and keep its log
with the release:

```bash
FULL=1 bash scripts/full-sweep.sh 2>&1 | tee "sweep-$(git rev-parse --short HEAD).log"
```

`FULL=1` adds the integration suites against real Postgres and Redis, the benchmark regression
gate and the k6 load smoke to what the pre-push hook runs. Release only when the summary says
`PASS` on every line, and attach the log to the GitHub Release (or keep it next to the release
notes). This replaces the CI run that no longer happens. Both lanes also run the plugin hook
tests (`pnpm test:hooks`). Before the integration step the sweep checks that a container runtime
answers: with `DOCKER_HOST` unset and no `/var/run/docker.sock` it uses OrbStack's socket if
there is one, and otherwise fails the step with the `DOCKER_HOST` to set for OrbStack, Colima
or rootless Docker.

The host capture records must also match the build you publish. Any change to
`packages/harness` or to a host's plugin files makes them stale, and a stale record silently
drops that host to `mcp-only` on every fresh `mnemo install --capture`. After `pnpm build`:

```bash
node scripts/qualify-harness-host.mjs validate-all
```

If it fails, re-qualify each stale host on the machine its record names (see `CLAUDE.md`)
before releasing. No test accepts a stale record in its place.

## What is published

Only four packages are on npm: `@mnemo-ai/cli`, `@mnemo-ai/mcp`, `@mnemo-ai/client-ts` and
`@mnemo-ai/types`. Every other package is internal: it ships inside the server and migrate
images, or, for `@mnemo-ai/harness`, bundled into the CLI's `dist`. Each published package keeps
its own version; they are not linked.

## Steps

1. Start from a clean `main` (`git status` empty) and run the release gate above.
2. Bump the version of each package you publish. When a package changes, every published
   package that depends on it needs a release too, dependencies first:
   `types` → `client-ts` → `mcp` and `cli`.
3. Pack and check each package before publishing. `pnpm pack` rewrites `workspace:*` to real
   versions (plain `npm pack` does not), and `prepack` copies the root `LICENSE` in:

   ```bash
   (cd packages/cli && pnpm pack --pack-destination /tmp/mnemo-release)
   tar -tzf /tmp/mnemo-release/mnemo-ai-cli-*.tgz | grep -c LICENSE
   ```

4. Publish in dependency order with `pnpm --filter <package> publish --access public`.
5. Check the CLI as a user gets it: in an empty directory, `npm install` the published version
   and run `mnemo --version`.
6. Tag the commit you published from, one tag per package (`<directory>-v<version>`, the format
   release-please uses), and push the tags:

   ```bash
   git tag cli-v3.6.5 && git push origin cli-v3.6.5
   ```

7. Docker images are not published automatically either: build them from the same commit with
   `docker build -f docker/Dockerfile.server .` (and `Dockerfile.migrate`, `Dockerfile.dashboard`).

## Next release

Four packages are ahead of npm: `@mnemo-ai/types` `3.6.2` (npm has `3.6.1`, which lacks
`DEFAULT_LOCALE`, imported by the CLI at start-up), `@mnemo-ai/client-ts` `3.6.3`,
`@mnemo-ai/mcp` `3.6.4` and `@mnemo-ai/cli` `3.6.5`. `pnpm pack` pins each one to the exact
versions of the others, so publish in this order: `types`, `client-ts`, then `mcp` and `cli`. A
package published before its dependencies would not install.

## When CI is turned back on

release-please can take over again, but review `linked-versions` in
`.github/release-please-config.json` first: it would move every component to one version,
while the published packages now carry their own.
