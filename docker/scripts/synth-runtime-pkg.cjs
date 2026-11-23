#!/usr/bin/env node
/**
 * Synthesise a flat runtime package.json for the server Docker image.
 *
 * Reads:
 *   ./server-pkg.json         — copy of packages/server/package.json
 *   ./*-pkg.json              — one per workspace dep included in the image
 *                               (core-pkg.json, adapter-redis-pkg.json, …)
 *   ./tarballs/*.tgz          — output of `pnpm pack` on the workspace deps
 *
 * Writes:
 *   ./package.json            — runtime manifest with:
 *     - all dependencies from server
 *     - peerDependencies of server promoted to direct deps; `workspace:*`
 *       entries replaced with `file:./tarballs/<tarball>` paths
 *     - peerDependencies of every *-pkg.json promoted as siblings so the
 *       tarball install can resolve them (e.g. postgres/drizzle-orm for
 *       core, ioredis for adapter-redis)
 *     - devDependencies dropped
 *
 * To add a new workspace dep: (a) `pnpm pack` it in the Dockerfile build
 * stage and (b) COPY its package.json as <name>-pkg.json in runtime-deps.
 * No changes to this script are needed.
 *
 * Tarball naming note: `pnpm pack` produces filenames of the form
 * `<scope-without-@>-<name>-<version>.tgz`, e.g.
 * `@mnemosyne/core` → `mnemosyne-core-2.0.0-alpha.0.tgz`. We build the
 * filename prefix the same way.
 */
const fs = require("fs");

const srv = JSON.parse(fs.readFileSync("./server-pkg.json", "utf8"));
const tarballs = fs.readdirSync("./tarballs");

// Read every *-pkg.json in cwd — each is a workspace dep whose peers we
// must lift into the runtime manifest so `npm install` can resolve them.
// Adding a new workspace dep to the server only requires (a) packing it
// in the Dockerfile build stage and (b) COPYing its package.json here as
// <name>-pkg.json; no script change needed.
const workspacePkgs = fs
  .readdirSync(".")
  .filter((f) => f.endsWith("-pkg.json"))
  .map((f) => {
    try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
  })
  .filter(Boolean);

/** "@mnemosyne/core" → "mnemosyne-core" (pnpm pack's filename prefix). */
function tarballPrefix(pkgName) {
  return pkgName.replace(/^@/, "").replace("/", "-");
}

function findTarball(pkgName) {
  const prefix = tarballPrefix(pkgName) + "-";
  const match = tarballs.find((f) => f.startsWith(prefix) && f.endsWith(".tgz"));
  if (!match) {
    throw new Error(
      `No tarball for "${pkgName}" (looked for ${prefix}*.tgz; have: ${tarballs.join(", ")})`
    );
  }
  return `file:./tarballs/${match}`;
}

const deps = { ...(srv.dependencies || {}) };

// Replace any workspace:* entries in regular dependencies with tarball refs.
// These are intra-monorepo packages (e.g. @mnemosyne/types) that aren't on
// any registry and must be installed from the packed .tgz files.
for (const [name, range] of Object.entries(deps)) {
  if (range.startsWith("workspace:")) deps[name] = findTarball(name);
}

const peerMeta = srv.peerDependenciesMeta || {};
for (const [name, range] of Object.entries(srv.peerDependencies || {})) {
  const isOptional = peerMeta[name]?.optional ?? false;
  if (range.startsWith("workspace:")) {
    try {
      deps[name] = findTarball(name);
    } catch (e) {
      if (!isOptional) throw e;
      // Optional workspace peer with no tarball — skip (not needed in minimal runtime image)
    }
  } else {
    deps[name] = range;
  }
}

// Lift peer deps from every workspace package included in the image
// (core, adapter-redis, etc.). These peers would normally be satisfied by
// the package's host; here, the tarball install IS the host, so they must
// be siblings in the runtime manifest.
//
// Skip `workspace:` ranges here. Workspace peers are resolved (to a tarball
// file: path) or intentionally dropped (optional peers with no packed
// tarball — e.g. adapter-postgres/adapter-vector/plugins/federation, which
// tsup bundles into dist/) by the server dependency + peer passes above.
// Re-adding them in this generic pass would reintroduce a literal
// `workspace:*` that `npm install` rejects (EUNSUPPORTEDPROTOCOL). Only real
// npm-range peers (postgres, drizzle-orm, ioredis, …) are lifted here.
for (const pkg of workspacePkgs) {
  for (const [name, range] of Object.entries(pkg.peerDependencies || {})) {
    if (typeof range === "string" && range.startsWith("workspace:")) continue;
    if (!deps[name]) deps[name] = range;
  }
}

const out = {
  name: srv.name,
  version: srv.version,
  type: srv.type,
  dependencies: deps,
};

fs.writeFileSync("./package.json", JSON.stringify(out, null, 2));
console.log(
  `Synthesised runtime package.json with ${Object.keys(deps).length} deps`
);
console.log("  workspace peers (via tarball):");
for (const [name, range] of Object.entries(deps)) {
  if (range.startsWith("file:")) console.log(`    ${name} ← ${range}`);
}
