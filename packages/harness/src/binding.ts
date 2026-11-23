import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  atomicWritePrivateFile,
  ensureSecureHarnessPaths,
  fsyncDirectory,
  readPrivateFile,
  type AtomicWriteOptions,
} from "./fs-security.js";

export interface BindingOptions extends AtomicWriteOptions {
  home?: string;
}

export interface BindingInput {
  serverUrl: string;
  workspaceId: string;
  apiKey: string;
}

export interface HarnessBinding {
  version: 1;
  /** Normalized origin, so one server reached two ways is one binding. */
  serverUrl: string;
  workspaceId: string;
  /** Non-secret digest of the API key. The key itself is never written. */
  keyFingerprint: string;
  /** Identifies THIS install of THIS queue to the server. */
  installationId: string;
  boundAt: string;
}

export type BindingResolution =
  | { status: "bound"; changed: false; binding: HarnessBinding }
  | { status: "rebound"; changed: true; binding: HarnessBinding; previous: HarnessBinding };

const BINDING_FILE = "binding.json";

/**
 * Non-reversible, non-secret digest of the API key.
 *
 * The queue has to notice that the key changed — a new key can mean a different
 * workspace or a different tenant entirely, and delivering queued events under it
 * would cross-contaminate. Storing the key to compare it would put a live
 * credential in a file whose whole purpose is to be read back later, so a
 * truncated digest is compared instead.
 */
export function keyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 32);
}

/**
 * Collapse the trivially different spellings of one origin.
 *
 * A trailing slash, a default port, or a case-different host is the same server;
 * treating those as a rebind would quarantine a healthy queue on a config tidy-up.
 * Anything beyond the origin is deliberately dropped — the harness paths are fixed,
 * so a path component here is noise, not routing.
 */
function normalizeServerUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Harness server URL must be http or https");
  }
  return url.origin;
}

function bindingPath(home: string | undefined, stateDir: string): string {
  void home;
  return join(stateDir, BINDING_FILE);
}

function isBinding(value: unknown): value is HarnessBinding {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<HarnessBinding>;
  return (
    candidate.version === 1 &&
    typeof candidate.serverUrl === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.keyFingerprint === "string" &&
    typeof candidate.installationId === "string"
  );
}

/**
 * The binding on disk, or null when there is none.
 *
 * A corrupt or unreadable file reads as "no binding" rather than throwing: this
 * is called on the capture path, and a host must never be wedged by its own
 * queue metadata. The next resolve simply binds again.
 */
export async function readBinding(options: BindingOptions = {}): Promise<HarnessBinding | null> {
  const paths = await ensureSecureHarnessPaths(options);
  try {
    const parsed: unknown = JSON.parse(
      await readPrivateFile(bindingPath(options.home, paths.state))
    );
    return isBinding(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Establish, confirm, or replace the binding this queue delivers under.
 *
 * Called before the first capture so an event is never queued without a recorded
 * destination — otherwise a queue drained after a config change could deliver a
 * conversation to a server the user never pointed it at.
 *
 * A changed server, workspace or key is reported rather than silently applied:
 * events already queued belong to the previous binding, and only the caller can
 * decide whether to drain, quarantine or discard them. The installation identity
 * is regenerated on a rebind precisely so the old identity cannot follow the
 * queue to a different destination.
 */
export async function resolveBinding(
  input: BindingInput,
  options: BindingOptions = {}
): Promise<BindingResolution> {
  if (!input.serverUrl || !input.workspaceId || !input.apiKey) {
    throw new TypeError("Harness binding requires a server URL, workspace and API key");
  }
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const workspaceId = input.workspaceId;
  const fingerprint = keyFingerprint(input.apiKey);

  const paths = await ensureSecureHarnessPaths(options);
  const target = bindingPath(options.home, paths.state);
  const previous = await readBinding(options);

  if (
    previous &&
    previous.serverUrl === serverUrl &&
    previous.workspaceId === workspaceId &&
    previous.keyFingerprint === fingerprint
  ) {
    return { status: "bound", changed: false, binding: previous };
  }

  const binding: HarnessBinding = {
    version: 1,
    serverUrl,
    workspaceId,
    keyFingerprint: fingerprint,
    installationId: randomUUID(),
    boundAt: new Date().toISOString(),
  };
  await atomicWritePrivateFile(target, JSON.stringify(binding), options);
  await fsyncDirectory(paths.state);

  return previous
    ? { status: "rebound", changed: true, binding, previous }
    : { status: "bound", changed: false, binding };
}
