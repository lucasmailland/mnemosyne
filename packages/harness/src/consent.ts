/**
 * The on-switch for capture, and the only one.
 *
 * Installing a host's artifacts does not start capture, and it must not: the
 * artifacts are files in the user's config, while consent is a decision the user
 * made once and can revoke. Keeping them separate is what makes
 * `mnemo harness disable` a real off-switch instead of a second config edit.
 *
 * Before this existed, `harness-hook.sh` gated on `MNEMO_HARNESS_V1_ENABLED`
 * being `true` in the HOST's process — a variable an installer cannot set for a
 * process that starts tomorrow. So `hooks.json` installed cleanly, reported
 * success, and captured nothing, for as long as nobody checked. The env var is the
 * server's feature flag; on the client it is only a kill switch (`false`), never
 * consent. The marker is what an install writes.
 *
 * One marker per host: consent to capture Claude Code is not consent to capture
 * Codex. Written through the harness's own secure-path machinery, so it inherits
 * the ownership, mode and atomicity rules every other harness file already has.
 */

import { join } from "node:path";

import type { CaptureHost, CaptureMode } from "./adapters/capabilities.js";
import type { BindingOptions } from "./binding.js";
import {
  assertSafePathComponent,
  atomicWritePrivateFile,
  ensureSecureHarnessPaths,
  fsyncDirectory,
  readPrivateFile,
} from "./fs-security.js";

export interface CaptureConsent {
  /** Select exactly one capture writer when promoting a qualified runtime. */
  writer?: "legacy" | "managed";
  version: 1;
  host: CaptureHost;
  /** The mode consented to, which is the mode that was honestly available. */
  mode: CaptureMode;
  consentedAt: string;
  /** What the host was when consent was given, so an upgrade is visible. */
  hostVersion: string;
  /** What the capture artifacts were, so a changed build is visible. */
  packageHash: string;
}

export type CaptureConsentInput = Omit<CaptureConsent, "version" | "consentedAt"> & {
  consentedAt?: string;
};

function markerPath(captureDir: string, host: CaptureHost): string {
  // The host name reaches this from a command line. It becomes a filename, so it
  // gets the same component check every other harness path component gets.
  assertSafePathComponent(`${host}.json`);
  return join(captureDir, `${host}.json`);
}

function isConsent(value: unknown): value is CaptureConsent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CaptureConsent>;
  return (
    candidate.version === 1 &&
    typeof candidate.host === "string" &&
    typeof candidate.mode === "string" &&
    typeof candidate.consentedAt === "string" &&
    typeof candidate.hostVersion === "string" &&
    typeof candidate.packageHash === "string"
  );
}

/** Record that the user turned capture on for this host. */
export async function writeCaptureConsent(
  input: CaptureConsentInput,
  options: BindingOptions = {}
): Promise<CaptureConsent> {
  const paths = await ensureSecureHarnessPaths(options);
  const consent: CaptureConsent = {
    version: 1,
    ...(input.writer ? { writer: input.writer } : {}),
    host: input.host,
    mode: input.mode,
    consentedAt: input.consentedAt ?? new Date().toISOString(),
    hostVersion: input.hostVersion,
    packageHash: input.packageHash,
  };
  await atomicWritePrivateFile(
    markerPath(paths.capture, input.host),
    JSON.stringify(consent),
    options
  );
  await fsyncDirectory(paths.capture);
  return consent;
}

/**
 * The consent recorded for this host, or null.
 *
 * Null for every reachable failure — absent, unreadable, malformed, or written by
 * a version this build does not understand. A gate that cannot read its own
 * evidence must read as OFF: the alternative is capturing a user's conversation
 * on the strength of a file we could not parse.
 */
export async function readCaptureConsent(
  host: CaptureHost,
  options: BindingOptions = {}
): Promise<CaptureConsent | null> {
  try {
    const paths = await ensureSecureHarnessPaths(options);
    const parsed: unknown = JSON.parse(await readPrivateFile(markerPath(paths.capture, host)));
    return isConsent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Revoke consent for this host.
 *
 * Returns whether a marker was actually removed. Clearing an absent marker is
 * success, not an error — the caller asked for capture to be off, and it is.
 */
export async function clearCaptureConsent(
  host: CaptureHost,
  options: BindingOptions = {}
): Promise<boolean> {
  const paths = await ensureSecureHarnessPaths(options);
  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(markerPath(paths.capture, host));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await fsyncDirectory(paths.capture);
  return true;
}
