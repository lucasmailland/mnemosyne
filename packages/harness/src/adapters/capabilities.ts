/**
 * How much of a host we are allowed to capture.
 *
 * Capture modes are earned, never assumed. A qualification record is evidence
 * that a specific host build, on a specific platform, actually emitted the events
 * an adapter depends on — recorded by running that build, not by reading its
 * documentation. Anything that cannot be matched to such a record falls back to
 * the mode that needs no evidence.
 *
 * The failure direction is always downward. Guessing high means silently
 * capturing nothing while reporting success, which is the exact failure other
 * projects have shipped for months: subscribing to event names that never existed.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type CaptureMode = "full" | "user-only" | "mcp-only" | "unavailable";

/** The hosts this harness knows how to capture from. */
export type CaptureHost = "opencode" | "claude-code" | "codex";

export interface QualificationRecord {
  version: 1;
  host: CaptureHost;
  /** Version of the host BINARY, which can differ from its plugin package. */
  hostVersion: string;
  pluginPackage: { name: string; version: string };
  /** `${process.platform}-${process.arch}` at qualification time. */
  platform: string;
  /** Digest of the packaged CLI the qualification ran from. */
  packageHash: string;
  /** Digest of the recorded native payload fixtures. */
  fixtureHash: string;
  /** Event names actually observed, not merely documented. */
  observedEvents: string[];
  /** Where the contract was read from, for a human re-checking it. */
  sources: string[];
  proofs: { transcript: boolean; compaction: boolean; deletion: boolean };
  qualifiedAt: string;
  mode: CaptureMode;
  /**
   * Why the qualifier capped `mode`, in words an operator can act on.
   *
   * Written by the qualifier since the gate checks landed, and until now read by
   * nobody — so the one sentence explaining why Codex is `mcp-only` existed on
   * disk and was never shown. Optional: records written before it stay valid.
   */
  gateReason?: string;
  /**
   * The host gate on the machine that RAN the qualifier (Codex: `features.hooks`).
   * Informational only, never a ceiling (APP-035): it describes that machine, not
   * the build. The CLI reads the same gate live on the user's machine and takes
   * the lower of record and gate.
   */
  qualifierGate?: { hooksEnabled: boolean };
  /**
   * How far the evidence reaches across host releases.
   *
   * `exact` — the default, and what a record without the field means for every
   * host but Codex (see DEFAULT_VERSION_MATCH) — covers only `hostVersion`. `same-major` covers `hostVersion` and every later release
   * of the same major. The qualifier writes it for a host whose proof never reads
   * the installed host (Claude Code: the plugin's own hooks.json against the
   * checked-in fixture), where pinning the version added no evidence and turned
   * capture off on every update. The package and fixture hashes still pin exactly
   * what was proven, and a new major is never covered.
   */
  hostVersionMatch?: "exact" | "same-major";
}

export interface CaptureDecision {
  mode: CaptureMode;
  /** Always present. An operator must never have to guess why capture is limited. */
  reason: string;
}

const HOSTS = new Set(["opencode", "claude-code", "codex"]);
const MODES = new Set<CaptureMode>(["full", "user-only", "mcp-only", "unavailable"]);
const SHA256 = /^[0-9a-f]{64}$/;

const MODE_RANK: Record<CaptureMode, number> = {
  unavailable: 0,
  "mcp-only": 1,
  "user-only": 2,
  full: 3,
};

function isRecord(value: unknown): value is QualificationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Partial<QualificationRecord>;
  return (
    r.version === 1 &&
    typeof r.host === "string" &&
    HOSTS.has(r.host) &&
    typeof r.hostVersion === "string" &&
    r.hostVersion.length > 0 &&
    typeof r.platform === "string" &&
    r.platform.length > 0 &&
    typeof r.packageHash === "string" &&
    SHA256.test(r.packageHash) &&
    typeof r.fixtureHash === "string" &&
    SHA256.test(r.fixtureHash) &&
    Array.isArray(r.observedEvents) &&
    r.observedEvents.every((event) => typeof event === "string") &&
    typeof r.proofs === "object" &&
    r.proofs !== null &&
    typeof r.proofs.transcript === "boolean" &&
    typeof r.proofs.compaction === "boolean" &&
    typeof r.proofs.deletion === "boolean" &&
    typeof r.mode === "string" &&
    MODES.has(r.mode as CaptureMode) &&
    (r.gateReason === undefined || typeof r.gateReason === "string") &&
    (r.hostVersionMatch === undefined ||
      r.hostVersionMatch === "exact" ||
      r.hostVersionMatch === "same-major")
  );
}

/**
 * The match rule for a record that does not state one.
 *
 * `exact` everywhere except Codex, which gets `same-major` (APP-035c): Codex
 * ships a minor release every few days (0.163.0 to 0.169.0 in one week) and its
 * qualifier, like Claude Code's, reads the installed host only for its version
 * string and its features.hooks gate — the event set comes from the checked-in
 * fixture. An exact pin therefore turned capture off on every update without
 * adding evidence. `same-minor` would not survive that cadence. So: the
 * qualified version is a floor, any later release of the same major is covered
 * (all of 0.x while Codex is pre-1.0), a new major never is, and the package,
 * fixture and platform checks still pin what was proven. A record that states
 * `exact` keeps it.
 */
const DEFAULT_VERSION_MATCH: Partial<
  Record<CaptureHost, NonNullable<QualificationRecord["hostVersionMatch"]>>
> = { codex: "same-major" };

/**
 * A version as its binary's prefix plus dotted numbers — `2.1.330` or
 * `codex-cli 0.163.0` — or null for anything that cannot be ordered safely
 * (a pre-release suffix included).
 */
function versionParts(version: string): { prefix: string; parts: number[] } | null {
  const match = /^(\D*?)(\d+(?:\.\d+)*)$/.exec(version);
  return match ? { prefix: match[1]!, parts: match[2]!.split(".").map(Number) } : null;
}

function versionMatchOf(record: QualificationRecord): "exact" | "same-major" {
  return record.hostVersionMatch ?? DEFAULT_VERSION_MATCH[record.host] ?? "exact";
}

/** Whether `installed` is a release the record's evidence reaches. */
function coversHostVersion(record: QualificationRecord, installed: string): boolean {
  if (record.hostVersion === installed) return true;
  if (versionMatchOf(record) !== "same-major") return false;
  const q = versionParts(record.hostVersion);
  const c = versionParts(installed);
  if (!q || !c || q.prefix !== c.prefix) return false;
  const qualified = q.parts;
  const current = c.parts;
  if (qualified[0] !== current[0]) return false;
  for (let i = 0; i < Math.max(qualified.length, current.length); i += 1) {
    const a = current[i] ?? 0;
    const b = qualified[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Decide the capture mode for the host as it is installed right now.
 *
 * Every check is a reason to go DOWN a mode, never up, and the record's own
 * claimed mode is a ceiling rather than a promise: a record cannot promote itself
 * past the evidence it carries.
 */
export function resolveCaptureMode(input: {
  record: unknown;
  hostVersion: string;
  platform: string;
  packageHash: string;
  fixtureHash: string;
}): CaptureDecision {
  const { record } = input;
  if (!isRecord(record)) {
    return {
      mode: "mcp-only",
      reason: "no valid qualification record for this host; capture stays off",
    };
  }
  if (!coversHostVersion(record, input.hostVersion)) {
    // A record proves what one build did. An upgrade can rename or drop an event,
    // which is precisely the failure this whole mechanism exists to catch.
    return {
      mode: "mcp-only",
      reason:
        versionMatchOf(record) === "same-major"
          ? `qualification covers host version ${record.hostVersion} and later releases of that major, this is ${input.hostVersion}`
          : `qualification is for host version ${record.hostVersion}, this is ${input.hostVersion}`,
    };
  }
  if (record.platform !== input.platform) {
    return {
      mode: "mcp-only",
      reason: `qualification is for platform ${record.platform}, this is ${input.platform}`,
    };
  }
  if (record.packageHash !== input.packageHash) {
    return { mode: "mcp-only", reason: "package hash does not match the qualified build" };
  }
  if (record.fixtureHash !== input.fixtureHash) {
    return { mode: "mcp-only", reason: "fixture hash does not match the qualified recording" };
  }

  // Reconciliation needs the transcript; closing a session needs deletion. Either
  // one unproven means user messages only — still useful, and honest about it.
  const missing = (["transcript", "deletion"] as const).filter((proof) => !record.proofs[proof]);
  const earned: CaptureMode = missing.length > 0 ? "user-only" : "full";

  // The record's claimed mode is a CEILING, and it has to be applied before the
  // proofs are allowed to settle the answer. It carries knowledge no proof can:
  // Codex qualifies `mcp-only` on a platform without hooks (Windows), and no
  // number of proven events makes a hook fire that the host never calls. (A local
  // `features.hooks` is NOT such knowledge — it is checked live; APP-035.)
  //
  // Returning early on unproven proofs skipped this comparison entirely, which
  // PROMOTED a claimed `mcp-only` to `user-only` — a gate raising the very mode
  // it exists to lower, and reporting the promotion as a limitation.
  const claimed = record.mode;
  const recordBinds = MODE_RANK[claimed] < MODE_RANK[earned];
  const mode = recordBinds ? claimed : earned;

  if (recordBinds) {
    return { mode, reason: record.gateReason ?? `qualification record limits capture to ${mode}` };
  }
  if (missing.length > 0) {
    return { mode, reason: `unproven capabilities: ${missing.join(", ")}` };
  }
  return {
    mode,
    reason: `qualified against ${record.host} ${record.hostVersion} on ${record.platform}`,
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The installed package's own root, found by looking for its manifest.
 *
 * A fixed relative hop cannot work: this module sits at `src/adapters/` in the
 * repository and at `dist/` once bundled, so any constant number of `..` is
 * right in one and wrong in the other. The previous `join(HERE, "..", "..")`
 * resolved to the FILESYSTEM ROOT from an installed package, which made every
 * host permanently mcp-only — a wrong answer that was safe, and therefore silent.
 *
 * Returns null rather than a guess when the manifest is not found, so the caller
 * degrades with a reason instead of reading some unrelated directory.
 */
function packageRoot(): string | null {
  let current = HERE;
  for (let hop = 0; hop < 4; hop += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, "package.json"), "utf8")) as {
        name?: string;
      };
      if (manifest.name === "@mnemo-ai/harness") return current;
    } catch {
      /* keep walking: no manifest here */
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** sha256 of a file, or null when it cannot be read. */
function digestFile(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** Files that actually implement capture for one host, relative to an artifact root. */
const HOST_ARTIFACTS: Record<QualificationRecord["host"], string[]> = {
  opencode: ["opencode/mnemosyne.ts"],
  "claude-code": ["hooks/hooks.json", "scripts/harness-hook.sh"],
  codex: ["hooks/codex-hooks.json", "scripts/harness-hook.sh"],
};

function digestTree(dir: string, prefix: string, into: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const full = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) digestTree(full, rel, into);
    else into.push(`${rel}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
  }
}

/**
 * Digest of the bytes that actually implement capture on THIS machine.
 *
 * Replaces a caller-supplied hash, which was a credential the artifact issued to
 * itself: nothing stopped a caller asserting whatever value made the check pass,
 * and in practice nothing set it at all.
 *
 * `package.json` is deliberately excluded. `pnpm pack` reserialises it and
 * rewrites `workspace:*` to concrete versions, so any digest including it is
 * reproducible only inside a pack — which is exactly why the old definition could
 * never be computed at runtime.
 *
 * Missing or unreadable input returns an error rather than a partial digest; the
 * caller degrades on it, downward as always.
 */
export function computeCaptureArtifactHash(input: {
  host: QualificationRecord["host"];
  artifactRoot: string;
  harnessRoot?: string;
}): { hash: string } | { error: string } {
  const harnessRoot = input.harnessRoot ?? packageRoot();
  if (harnessRoot === null) return { error: "harness package root not found" };

  const lines: string[] = [];
  try {
    digestTree(join(harnessRoot, "dist"), "dist", lines);
  } catch {
    return { error: "harness dist is missing or unreadable" };
  }
  for (const relative of HOST_ARTIFACTS[input.host]) {
    try {
      const bytes = readFileSync(join(input.artifactRoot, relative));
      lines.push(`${relative}:${createHash("sha256").update(bytes).digest("hex")}`);
    } catch {
      return { error: `capture artifact missing: ${relative}` };
    }
  }
  lines.sort();
  return { hash: createHash("sha256").update(lines.join("\n")).digest("hex") };
}

/**
 * Decide the capture mode for a host from the checked-in qualification record.
 *
 * Reads only the record shipped with this package — never a path a caller
 * supplies — because the record is the thing that authorises capture, and a
 * caller-chosen one would let anything grant itself full access.
 *
 * Every failure to read, parse or match resolves downward to `mcp-only`.
 */
export function resolveHostCaptureMode(input: {
  host: QualificationRecord["host"];
  hostVersion: string;
  /** Where this host's capture artifacts live. A LOCATION, never a hash value. */
  artifactRoot?: string;
  platform?: string;
  qualificationsDir?: string;
  fixturesDir?: string;
}): CaptureDecision {
  const root = input.qualificationsDir && input.fixturesDir ? null : packageRoot();
  if (root === null && (!input.qualificationsDir || !input.fixturesDir)) {
    return { mode: "mcp-only", reason: "harness package root not found" };
  }
  const qualifications = input.qualificationsDir ?? join(root!, "qualifications");
  const fixtures = input.fixturesDir ?? join(root!, "fixtures");

  let record: unknown = null;
  try {
    record = JSON.parse(readFileSync(join(qualifications, `${input.host}.json`), "utf8"));
  } catch {
    return { mode: "mcp-only", reason: `no qualification record for ${input.host}` };
  }

  const fixtureHash = digestFile(join(fixtures, `${input.host}-events.json`));
  if (fixtureHash === null) {
    return { mode: "mcp-only", reason: `no recorded fixture for ${input.host}` };
  }

  // The observed hash is computed here, from the artifacts on disk. Passing the
  // record's own hash — as this did — made the comparison compare a value to
  // itself, so the check could never fail and the guarantee it advertised did
  // not exist.
  if (input.artifactRoot === undefined) {
    return { mode: "mcp-only", reason: "no artifact root supplied; capture cannot be verified" };
  }
  const observed = computeCaptureArtifactHash({
    host: input.host,
    artifactRoot: input.artifactRoot,
  });
  if ("error" in observed) return { mode: "mcp-only", reason: observed.error };

  return resolveCaptureMode({
    record,
    hostVersion: input.hostVersion,
    platform: input.platform ?? `${process.platform}-${process.arch}`,
    packageHash: observed.hash,
    fixtureHash,
  });
}
