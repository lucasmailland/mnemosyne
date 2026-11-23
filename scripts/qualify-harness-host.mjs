#!/usr/bin/env node
/**
 * Qualify a harness host: prove, by running against the real installation, which
 * capture capabilities actually work — then write a content-free record of it.
 *
 * The record is evidence, not documentation. `capabilities.ts` refuses to enable
 * anything it cannot match to one, because the alternative is what other projects
 * shipped: subscribing to event names that never existed and capturing nothing,
 * silently, for months.
 *
 * Usage:
 *   node scripts/qualify-harness-host.mjs opencode
 *   node scripts/qualify-harness-host.mjs validate-all
 *
 * Requires `pnpm build` first: the digest is computed from the built bytes by
 * the same function the runtime uses. You cannot qualify what you have not built.
 *
 * Exits non-zero when a record is missing, stale or unverifiable.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const QUALIFICATIONS = join(REPO, "packages/harness/qualifications");
const FIXTURES = join(REPO, "packages/harness/fixtures");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The built harness, which is the ONLY implementation of the normalisation and
 * hashing this script records. Importing it (rather than reimplementing it here)
 * is the whole point: a record is matched on string equality, so a second copy of
 * either rule silently stops matching instead of failing loudly.
 */
let harnessModule;
async function harness() {
  if (!harnessModule) {
    const dist = join(REPO, "packages/harness/dist/index.js");
    if (!existsSync(dist)) fail("packages/harness is not built; run `pnpm build` first");
    harnessModule = await import(dist);
  }
  return harnessModule;
}

/** Version of the host binary, normalised by the same code the runtime reads with. */
async function hostVersionOf(host, binary) {
  const { readHostVersion } = await harness();
  const result = readHostVersion(host);
  if ("error" in result) return { available: false, reason: `${binary}: ${result.error}` };
  return { available: true, hostVersion: result.version };
}

/** Order-independent JSON, so a reserialised manifest hashes the same. */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}
const platform = () => `${process.platform}-${process.arch}`;

function fail(message) {
  console.error(`qualify: ${message}`);
  process.exit(1);
}

/**
 * Digest of the bytes that implement capture, from the same function the runtime
 * uses.
 *
 * It used to hash a `pnpm pack` tarball, which no installed process could ever
 * reproduce — `pnpm` reserialises package.json and rewrites `workspace:*` during
 * pack. That is why the runtime had no way to compute this value, and why the
 * check it fed had been quietly disabled. One function now serves both, so they
 * cannot drift again.
 */
async function packageHash(host) {
  const { computeCaptureArtifactHash } = await harness();
  const result = computeCaptureArtifactHash({
    host,
    artifactRoot: join(REPO, "packages/plugin"),
    harnessRoot: join(REPO, "packages/harness"),
  });
  if ("error" in result) fail(`cannot hash capture artifacts: ${result.error}`);
  return result.hash;
}

function fixtureHash(host) {
  const path = join(FIXTURES, `${host}-events.json`);
  if (!existsSync(path)) fail(`no recorded fixture for ${host}`);
  return sha256(readFileSync(path));
}

/**
 * Read the contract from the host as it is installed on THIS machine, and check
 * the checked-in fixture still describes it.
 */
async function verifyOpencode() {
  const root = join(homedir(), ".config/opencode/node_modules/@opencode-ai");
  const pluginTypes = join(root, "plugin/dist/index.d.ts");
  const sdkTypes = join(root, "sdk/dist/gen/types.gen.d.ts");
  if (!existsSync(pluginTypes) || !existsSync(sdkTypes)) {
    return { available: false, reason: "opencode plugin/sdk types are not installed" };
  }
  // A path resolving back into the repository would mean we qualified our own
  // source instead of the installed host.
  for (const path of [pluginTypes, sdkTypes]) {
    if (resolve(path).startsWith(REPO))
      fail(`refusing to qualify against a repository path: ${path}`);
  }

  const dts = readFileSync(pluginTypes, "utf8");
  const sdk = readFileSync(sdkTypes, "utf8");
  const fixture = JSON.parse(readFileSync(join(FIXTURES, "opencode-events.json"), "utf8"));

  const missingChannels = Object.values(fixture.channels).filter((c) => !dts.includes(`"${c}"`));
  const missingEvents = fixture.sessionEvents.filter((e) => !sdk.includes(`"${e}"`));

  const version = await hostVersionOf("opencode", "opencode");
  if (!version.available) return version;
  const hostVersion = version.hostVersion;

  return {
    available: true,
    hostVersion,
    pluginPackage: JSON.parse(readFileSync(join(root, "plugin/package.json"), "utf8")),
    observedEvents: fixture.sessionEvents.filter((e) => !missingEvents.includes(e)),
    sources: fixture.sources,
    missingChannels,
    missingEvents,
  };
}

/**
 * Claude Code's contract lives in its own hook manifest and the plugin's
 * contract-test allowlist, which cites the official hook reference. Both are
 * checked-in files, so this qualifier verifies the SUBSCRIPTION rather than
 * reaching into an installed package the host does not expose.
 */
async function verifyClaudeCode() {
  const version = await hostVersionOf("claude-code", "claude");
  if (!version.available) return version;
  const hostVersion = version.hostVersion;

  const fixture = JSON.parse(readFileSync(join(FIXTURES, "claude-code-events.json"), "utf8"));
  const hooksJson = JSON.parse(
    readFileSync(join(REPO, "packages/plugin/hooks/hooks.json"), "utf8")
  );
  const subscribed = Object.keys(hooksJson.hooks).sort();

  // Every event we subscribe to has to be one the host actually defines.
  const undefinedEvents = subscribed.filter((event) => !fixture.hookEvents.includes(event));

  return {
    available: true,
    hostVersion,
    // Nothing above read the installed host beyond its version string, so the
    // version adds no evidence: the record reaches later releases of this major,
    // and the package and fixture hashes still pin what was proven.
    hostVersionMatch: "same-major",
    pluginPackage: { name: "claude-code-hooks", version: hostVersion },
    observedEvents: subscribed,
    sources: fixture.sources,
    missingChannels: undefinedEvents,
    missingEvents: [],
  };
}

/**
 * Codex has two gates that fail SILENTLY: hooks live behind `features.hooks`,
 * which defaults off, and hooks do not exist on Windows. Installing a manifest in
 * either case looks entirely successful and captures nothing, so both are read
 * from the real config before anything claims to be capturable.
 */
async function verifyCodex() {
  const version = await hostVersionOf("codex", "codex");
  if (!version.available) return version;
  const hostVersion = version.hostVersion;

  const fixture = JSON.parse(readFileSync(join(FIXTURES, "codex-events.json"), "utf8"));
  const manifest = JSON.parse(
    readFileSync(join(REPO, "packages/plugin/hooks/codex-hooks.json"), "utf8")
  );
  const subscribed = Object.keys(manifest.hooks).sort();
  const undefinedEvents = subscribed.filter((event) => !fixture.hookEvents.includes(event));

  // Read the flag from the user's real config, with the SAME parser the installer
  // writes it with. This used to be a regex over `toml.split("[features]")[1]`,
  // which reported ENABLED for a `hooks = true` belonging to `[features.experimental]`
  // or to any later table — the qualifier then recorded that capture was possible
  // and the operator was told it worked.
  const gateReader = join(REPO, "packages/cli/dist/codex-config.js");
  if (!existsSync(gateReader)) fail("packages/cli is not built; run `pnpm build` first");
  const { readCodexHooksGate } = await import(gateReader);
  const configPath = join(homedir(), ".codex/config.toml");
  let hooksEnabled = false;
  if (existsSync(configPath)) {
    const gate = readCodexHooksGate(readFileSync(configPath, "utf8"));
    // An unreadable config is not a disabled one; either way it is recorded as
    // the qualifier's gate state and says which it was.
    if (gate.status === "malformed") {
      console.error(`qualify: ${configPath} could not be parsed: ${gate.reason}`);
    } else {
      hooksEnabled = gate.enabled;
    }
  }

  return {
    available: true,
    hostVersion,
    // Codex bumps its minor every few days and this check reads the host only
    // for its version and the features.hooks gate (APP-035c), so the record
    // reaches later releases of this major, as for Claude Code.
    hostVersionMatch: "same-major",
    pluginPackage: { name: "codex-hooks", version: hostVersion },
    observedEvents: subscribed,
    sources: fixture.sources,
    missingChannels: undefinedEvents,
    missingEvents: [],
    gate: {
      platformSupported: process.platform !== "win32",
      hooksEnabled,
    },
  };
}

async function qualify(host) {
  const verifiers = {
    opencode: verifyOpencode,
    "claude-code": verifyClaudeCode,
    codex: verifyCodex,
  };
  const verify = verifiers[host];
  if (!verify) fail(`no qualifier for host: ${host}`);
  const observed = await verify();
  if (!observed.available) fail(observed.reason);
  if (observed.missingChannels.length > 0 || observed.missingEvents.length > 0) {
    fail(
      `installed host no longer matches the recorded fixture; missing ` +
        `channels=[${observed.missingChannels}] events=[${observed.missingEvents}]`
    );
  }

  // Proofs are claims about what was OBSERVED, so each one requires a real
  // capture run against a live session. Anything not observed is recorded false,
  // which caps the mode below `full` rather than assuming it works.
  const proofs = {
    transcript: process.env.MNEMO_QUALIFY_TRANSCRIPT_PROOF === "observed",
    compaction: process.env.MNEMO_QUALIFY_COMPACTION_PROOF === "observed",
    deletion: process.env.MNEMO_QUALIFY_DELETION_PROOF === "observed",
  };
  // A platform without hooks beats any proof: the BUILD cannot capture there,
  // so the record says mcp-only and says why.
  //
  // `features.hooks` is different (APP-035): it is a setting on whichever machine
  // ran this script, not a property of the build. Capping the record on it made
  // the shipped codex.json mcp-only — a ceiling no user could lift by enabling
  // hooks. The CLI reads that gate live on the user's machine and takes the lower
  // of record and gate, so here it is only recorded, as `qualifierGate`.
  let mode = proofs.transcript && proofs.deletion ? "full" : "user-only";
  let gateReason;
  if (observed.gate && !observed.gate.platformSupported) {
    mode = "mcp-only";
    gateReason = "hooks are not available on this platform";
  }

  const record = {
    version: 1,
    host,
    hostVersion: observed.hostVersion,
    ...(observed.hostVersionMatch ? { hostVersionMatch: observed.hostVersionMatch } : {}),
    pluginPackage: { name: observed.pluginPackage.name, version: observed.pluginPackage.version },
    platform: platform(),
    packageHash: await packageHash(host),
    fixtureHash: fixtureHash(host),
    observedEvents: observed.observedEvents,
    sources: observed.sources,
    proofs,
    qualifiedAt: new Date().toISOString(),
    mode,
    ...(gateReason ? { gateReason } : {}),
    ...(observed.gate ? { qualifierGate: { hooksEnabled: observed.gate.hooksEnabled } } : {}),
  };
  const target = join(QUALIFICATIONS, `${host}.json`);
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`qualify: wrote ${target} (mode=${mode})`);
  if (mode !== "full") {
    const unproven = Object.entries(proofs)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    console.log(`qualify: unproven capabilities: ${unproven.join(", ")}`);
  }
}

/** Re-check every checked-in record against the host installed here. */
async function validateAll() {
  if (!existsSync(QUALIFICATIONS)) fail("no qualifications directory");
  const records = readdirSync(QUALIFICATIONS).filter((name) => name.endsWith(".json"));
  if (records.length === 0) fail("no qualification records to validate");

  let failures = 0;
  for (const name of records) {
    const host = name.replace(/\.json$/, "");
    const record = JSON.parse(readFileSync(join(QUALIFICATIONS, name), "utf8"));
    const problems = [];
    if (record.platform !== platform())
      problems.push(`platform ${record.platform} != ${platform()}`);
    if (record.fixtureHash !== fixtureHash(host)) problems.push("fixture hash drifted");
    if (record.packageHash !== (await packageHash(host))) problems.push("package hash drifted");
    if (problems.length > 0) {
      // Not fatal on its own: a record from another platform is simply not
      // applicable here, and capabilities.ts already refuses to use it.
      console.log(`qualify: ${host} not applicable here (${problems.join("; ")})`);
      if (record.platform === platform()) failures += 1;
    } else {
      console.log(`qualify: ${host} valid (mode=${record.mode})`);
    }
  }
  if (failures > 0) fail(`${failures} record(s) for this platform are stale`);
}

const [command, ...rest] = process.argv.slice(2);

// `--packed` used to select between hashing a `pnpm pack` tarball and hashing the
// working tree. There is only one digest now — computed from the built bytes by
// the same function the runtime calls — so the flag selected nothing while still
// being accepted, and CI passed it. A flag that reads as "verify the real
// artifact" and does nothing is the precise failure this whole mechanism exists
// to catch, so it is refused rather than ignored.
if (rest.includes("--packed")) {
  fail("--packed no longer exists: the digest is always computed from the built artifacts");
}
if (rest.length > 0) fail(`unknown argument: ${rest[0]}`);

if (command === "validate-all") await validateAll();
else if (command) await qualify(command);
else fail("usage: qualify-harness-host.mjs <host|validate-all>");
