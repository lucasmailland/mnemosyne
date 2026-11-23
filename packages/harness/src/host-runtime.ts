import { randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  HARNESS_PROTOCOL_VERSION,
  canonicalJson,
  computeTerminalDigestV1,
} from "@mnemo-ai/types/harness-runtime";
import {
  computeCaptureArtifactHash,
  type CaptureHost,
  type CaptureMode,
} from "./adapters/capabilities.js";
import {
  CLAUDE_CODE_EVENTS,
  toTranscriptMessages,
  toVisibleMessage as toClaudeVisibleMessage,
} from "./adapters/claude-code.js";
import { toVisibleMessage as toCodexVisibleMessage } from "./adapters/codex.js";
import { toVisibleMessage as toOpencodeOutboxInput } from "./adapters/opencode.js";
import { keyFingerprint, readBinding, resolveBinding, type HarnessBinding } from "./binding.js";
import { readCaptureConsent } from "./consent.js";
import { drainLegacySpools } from "./legacy-capture.js";
import {
  clearDeliveryBackoff,
  flushOutbox,
  type DeliveryTransport,
  type FlushResult,
  type TransportResponse,
} from "./delivery.js";
import {
  atomicWritePrivateFile,
  ensureSecureHarnessPaths,
  fsyncDirectory,
  listSecureRegularFiles,
  readPrivateFile,
  sessionLockName,
  withAdvisoryLock,
  type AtomicWriteOptions,
  type HarnessPaths,
} from "./fs-security.js";
import {
  enqueueEventCancellation,
  enqueueSessionEnd,
  enqueueSessionStart,
  enqueueTurnRetraction,
  enqueueVisibleMessage,
  readPendingEvents,
  type OutboxOptions,
} from "./outbox.js";
import {
  planReconciliation,
  type TerminalMember as HarnessTerminalMember,
  type TranscriptMessage,
} from "./reconcile.js";
import { normalizeVisibleMessage } from "./sanitize.js";
import { classifyTurnOrigin } from "@mnemo-ai/types/harness-runtime";
import {
  readSessionState,
  sourceSessionKey,
  type MessageIdentity,
  type SessionState,
} from "./state.js";

const MAX_TRANSCRIPT_BYTES = 100 * 1024 * 1024;
const DEFAULT_HTTP_TIMEOUT_MS = 4_000;
const QUIESCED_STATE_FILE = "quiesced.json";
const CLIENT_INSTANCE_FILE = "client-instance.json";

function latestAcknowledgedGeneration(current: number, state: SessionState): number {
  let generation = Math.max(current, state.generationMappings[String(current)] ?? current);
  for (const event of Object.values(state.acknowledgedEvents))
    generation = Math.max(generation, event.effectiveGeneration ?? event.sourceGeneration ?? 0);
  for (const message of Object.values(state.acknowledgedMessages))
    generation = Math.max(generation, message.sourceGeneration);
  for (const partial of Object.values(state.acknowledgedMessageChunks ?? {}))
    generation = Math.max(generation, partial.sourceGeneration);
  return generation;
}

export interface ClaudeTranscriptRawEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

export interface SafeTranscriptOptions {
  home?: string;
  claudeConfigDir?: string;
  uid?: number;
}

export interface SafeTranscriptResult {
  rawEntries: ClaudeTranscriptRawEntry[];
  messages: TranscriptMessage[];
}

function currentUid(override?: number): number {
  if (override !== undefined) return override;
  if (typeof process.getuid !== "function") {
    throw new Error("POSIX uid inspection is required for harness transcript security");
  }
  return process.getuid();
}

export function resolveClaudeAllowedRoot(options: SafeTranscriptOptions = {}): string {
  const configured = options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR;
  if (configured && configured.trim().length > 0) {
    return resolve(configured.trim());
  }
  const home = resolve(options.home ?? process.env.HOME ?? homedir());
  return join(home, ".claude");
}

async function assertNoSymlinksInChain(allowedRoot: string, targetPath: string): Promise<void> {
  const rootResolved = resolve(allowedRoot);
  const targetResolved = resolve(targetPath);
  const rel = relative(rootResolved, targetResolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Transcript path is outside the allowed Claude configuration directory");
  }

  const rootStat = await lstat(rootResolved);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Allowed Claude configuration root is not a real directory");
  }

  const segments = rel.split("/").filter((seg) => seg.length > 0);
  let cursor = rootResolved;
  for (let i = 0; i < segments.length - 1; i += 1) {
    cursor = join(cursor, segments[i]!);
    const st = await lstat(cursor);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Unsafe transcript ancestor component: ${cursor}`);
    }
  }

  const finalStat = await lstat(targetResolved);
  if (finalStat.isSymbolicLink() || !finalStat.isFile()) {
    throw new Error("Transcript path must be a regular non-symlink file");
  }
}

export async function readClaudeTranscript(
  transcriptPath: string,
  options: SafeTranscriptOptions = {}
): Promise<SafeTranscriptResult> {
  if (
    typeof transcriptPath !== "string" ||
    transcriptPath.length === 0 ||
    transcriptPath.includes("\0") ||
    !isAbsolute(transcriptPath) ||
    !transcriptPath.endsWith(".jsonl")
  ) {
    throw new Error("Transcript path must be an absolute .jsonl file path");
  }

  const allowedRoot = resolveClaudeAllowedRoot(options);
  const resolvedTarget = resolve(transcriptPath);
  await assertNoSymlinksInChain(allowedRoot, resolvedTarget);

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(resolvedTarget, fsConstants.O_RDONLY | noFollow);
  let rawText: string;
  try {
    const st = await handle.stat();
    if (!st.isFile()) {
      throw new Error("Transcript target is not a regular file");
    }
    if (st.uid !== currentUid(options.uid)) {
      throw new Error("Transcript file is not owned by the current user");
    }
    if (st.size > MAX_TRANSCRIPT_BYTES) {
      throw new Error("Transcript file exceeds maximum allowed byte size");
    }
    rawText = await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }

  const orderedUuids: string[] = [];
  const byUuid = new Map<string, ClaudeTranscriptRawEntry>();
  const unkeyed: ClaudeTranscriptRawEntry[] = [];

  for (const rawLine of rawText.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const entry = parsed as ClaudeTranscriptRawEntry;
    if (typeof entry.uuid === "string" && entry.uuid.length > 0) {
      if (!byUuid.has(entry.uuid)) {
        orderedUuids.push(entry.uuid);
      }
      byUuid.set(entry.uuid, entry);
    } else {
      unkeyed.push(entry);
    }
  }

  const rawEntries: ClaudeTranscriptRawEntry[] = [
    ...orderedUuids.map((uuid) => byUuid.get(uuid)!),
    ...unkeyed,
  ];
  return {
    rawEntries,
    messages: toTranscriptMessages(rawEntries),
  };
}

export interface ProvisionalPromptEntry {
  provisionalId: string;
  occurrenceIndex: number;
  contentHash: string;
  turnClosed: boolean;
  transcriptUuid?: string;
}

export interface SessionRuntimeRecord {
  version: 1;
  host: CaptureHost;
  clientInstanceId: string;
  hostSessionId: string;
  activeGeneration: number;
  startedGenerations: number[];
  endedGenerations: number[];
  sessionStartedWithConsent: boolean;
  preConsentMessageIds: string[];
  provisionalPrompts: ProvisionalPromptEntry[];
  transcriptBindings: Record<string, string>;
  compactedMessageIds: Record<string, string[]>;
  serverSessionId?: string;
}

function runtimeRecordPath(paths: HarnessPaths, sessionKey: string): string {
  return join(paths.state, `runtime-${sessionKey}.json`);
}

function defaultRuntimeRecord(
  host: CaptureHost,
  clientInstanceId: string,
  hostSessionId: string
): SessionRuntimeRecord {
  return {
    version: 1,
    host,
    clientInstanceId,
    hostSessionId,
    activeGeneration: 0,
    startedGenerations: [],
    endedGenerations: [],
    sessionStartedWithConsent: false,
    preConsentMessageIds: [],
    provisionalPrompts: [],
    transcriptBindings: {},
    compactedMessageIds: {},
  };
}

async function readRuntimeRecord(
  paths: HarnessPaths,
  host: CaptureHost,
  clientInstanceId: string,
  hostSessionId: string
): Promise<SessionRuntimeRecord> {
  const sessionKey = sourceSessionKey(host, clientInstanceId, hostSessionId);
  try {
    const parsed = JSON.parse(
      await readPrivateFile(runtimeRecordPath(paths, sessionKey))
    ) as Partial<SessionRuntimeRecord>;
    if (parsed && parsed.version === 1 && typeof parsed.activeGeneration === "number") {
      return {
        version: 1,
        host,
        clientInstanceId,
        hostSessionId,
        activeGeneration: parsed.activeGeneration,
        startedGenerations: Array.isArray(parsed.startedGenerations)
          ? parsed.startedGenerations
          : [],
        endedGenerations: Array.isArray(parsed.endedGenerations) ? parsed.endedGenerations : [],
        sessionStartedWithConsent: Boolean(parsed.sessionStartedWithConsent),
        preConsentMessageIds: Array.isArray(parsed.preConsentMessageIds)
          ? parsed.preConsentMessageIds
          : [],
        provisionalPrompts: Array.isArray(parsed.provisionalPrompts)
          ? parsed.provisionalPrompts
          : [],
        transcriptBindings:
          parsed.transcriptBindings && typeof parsed.transcriptBindings === "object"
            ? parsed.transcriptBindings
            : {},
        compactedMessageIds:
          parsed.compactedMessageIds && typeof parsed.compactedMessageIds === "object"
            ? parsed.compactedMessageIds
            : {},
        ...(typeof parsed.serverSessionId === "string"
          ? { serverSessionId: parsed.serverSessionId }
          : {}),
      };
    }
  } catch {
    // Missing or unreadable falls back to fresh record
  }
  return defaultRuntimeRecord(host, clientInstanceId, hostSessionId);
}

async function writeRuntimeRecord(
  paths: HarnessPaths,
  record: SessionRuntimeRecord,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const sessionKey = sourceSessionKey(record.host, record.clientInstanceId, record.hostSessionId);
  await atomicWritePrivateFile(
    runtimeRecordPath(paths, sessionKey),
    JSON.stringify(record),
    options
  );
  await fsyncDirectory(paths.state);
}

export interface ResolvedHarnessCredentials {
  home: string;
  serverUrl?: string;
  apiKey?: string;
  workspaceId?: string;
  binding: HarnessBinding | null;
  clientInstanceId: string;
  /**
   * The configured server or workspace differs from the persisted binding. The
   * binding's destination must not receive the configured credential, and the
   * configured destination must not receive events bound elsewhere.
   */
  destinationMismatch: boolean;
}

function normalizeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function readJsonFileSafe(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function findWorkspaceIdFromCwd(startDir: string): string | undefined {
  let current = resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = readJsonFileSafe(join(current, ".mnemo.json"));
    if (typeof candidate?.workspaceId === "string" && candidate.workspaceId.trim().length > 0) {
      return candidate.workspaceId.trim();
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

async function resolveFallbackClientInstanceId(
  paths: HarnessPaths,
  options: AtomicWriteOptions = {}
): Promise<string> {
  const filePath = join(paths.state, CLIENT_INSTANCE_FILE);
  try {
    const parsed = JSON.parse(await readPrivateFile(filePath)) as { clientInstanceId?: string };
    if (typeof parsed?.clientInstanceId === "string" && parsed.clientInstanceId.length > 0) {
      return parsed.clientInstanceId;
    }
  } catch {
    // create below
  }
  const clientInstanceId = randomUUID();
  await atomicWritePrivateFile(filePath, JSON.stringify({ version: 1, clientInstanceId }), options);
  await fsyncDirectory(paths.state);
  return clientInstanceId;
}

export async function resolveHarnessCredentials(
  options: {
    home?: string;
    cwd?: string;
    serverUrl?: string;
    apiKey?: string;
    workspaceId?: string;
    autoBind?: boolean;
  } & AtomicWriteOptions = {}
): Promise<ResolvedHarnessCredentials> {
  const home = resolve(options.home ?? process.env.HOME ?? homedir());
  const paths = await ensureSecureHarnessPaths({ ...options, home });
  const mnemoConfig = readJsonFileSafe(join(home, ".mnemo", "config.json"));
  let binding = await readBinding({ ...options, home });

  const apiKey =
    options.apiKey ??
    process.env.MNEMO_KEY ??
    process.env.MNEMO_API_KEY ??
    (typeof mnemoConfig?.apiKey === "string" ? mnemoConfig.apiKey : undefined);

  const configuredUrl =
    options.serverUrl ??
    process.env.MNEMO_URL ??
    (typeof mnemoConfig?.url === "string" ? mnemoConfig.url : undefined);
  const configuredWorkspaceId =
    options.workspaceId ??
    process.env.MNEMO_WORKSPACE_ID ??
    (options.cwd ? findWorkspaceIdFromCwd(options.cwd) : undefined) ??
    (typeof mnemoConfig?.workspaceId === "string" ? mnemoConfig.workspaceId : undefined);
  const serverUrl = configuredUrl ?? binding?.serverUrl;
  const workspaceId = configuredWorkspaceId ?? binding?.workspaceId;

  if (!binding && options.autoBind !== false && serverUrl && workspaceId && apiKey) {
    try {
      const resolved = await resolveBinding(
        { serverUrl, workspaceId, apiKey },
        { ...options, home }
      );
      binding = resolved.binding;
    } catch {
      // keep unbound
    }
  }

  const clientInstanceId =
    binding?.installationId ?? (await resolveFallbackClientInstanceId(paths, options));

  const destinationMismatch =
    !!binding &&
    ((configuredUrl !== undefined && normalizeOrigin(configuredUrl) !== binding.serverUrl) ||
      (configuredWorkspaceId !== undefined && configuredWorkspaceId !== binding.workspaceId));

  return {
    home,
    serverUrl: binding?.serverUrl ?? serverUrl,
    apiKey,
    workspaceId: binding?.workspaceId ?? workspaceId,
    binding,
    clientInstanceId,
    destinationMismatch,
  };
}

export function createFetchDeliveryTransport(
  timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS
): DeliveryTransport {
  return {
    async post(input): Promise<TransportResponse> {
      const response = await fetch(input.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.apiKey}`,
          "X-Workspace-Id": input.workspaceId,
        },
        body: input.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const text = await response.text();
      return {
        status: response.status,
        headers,
        text,
      };
    },
  };
}

/** How long a host hook may spend delivering before it returns to the host. */
const HOOK_DELIVERY_BUDGET_MS = 3_000;

/**
 * Publish the server session each managed Claude Code session was acknowledged
 * into, at the mapping the plugin's hooks read (`~/.mnemo/sessions/<id>.json`),
 * so SessionStart and auto-recall see the episode the managed writer opened.
 */
async function publishManagedSessionMappings(
  paths: HarnessPaths,
  flushed: FlushResult,
  binding: HarnessBinding
): Promise<void> {
  const latest = new Map<string, NonNullable<FlushResult["sessions"]>[number]>();
  for (const session of flushed.sessions ?? []) {
    if (session.host !== "claude-code") continue;
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(session.hostSessionId)) continue;
    latest.set(session.hostSessionId, session);
  }
  if (latest.size === 0) return;
  const dir = join(paths.mnemoRoot, "sessions");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const session of latest.values()) {
    await atomicWritePrivateFile(
      join(dir, `${session.hostSessionId}.json`),
      JSON.stringify({
        mnemoSessionId: session.sessionId,
        workspaceId: binding.workspaceId,
        serverUrl: binding.serverUrl,
        sourceGeneration: session.effectiveGeneration ?? 0,
        sourceClientInstanceId: session.clientInstanceId,
        createdAt: new Date().toISOString(),
      })
    );
  }
}

function writeManagedSessionStateFile(hostSessionId: string, serverSessionId?: string): void {
  const safeId = hostSessionId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeId) return;
  const stateDir = process.env.TMPDIR ?? tmpdir();
  const managedMarker = join(stateDir, `.mnemo-managed-session-${safeId}`);
  try {
    writeFileSync(managedMarker, serverSessionId ?? "managed", { mode: 0o600 });
  } catch {
    // non-fatal
  }
}

function computeLiveSetFromState(
  sourceGeneration: number,
  acknowledgedMessages: Record<string, MessageIdentity>,
  pending: Awaited<ReturnType<typeof readPendingEvents>>
): HarnessTerminalMember[] {
  const members = new Map<string, HarnessTerminalMember>();
  for (const [, msg] of Object.entries(acknowledgedMessages)) {
    if (msg.sourceGeneration !== sourceGeneration) continue;
    if (msg.type === "L") {
      members.set(msg.hostMessageId, {
        type: "L",
        hostMessageId: msg.hostMessageId,
        role: msg.role,
        contentHash: msg.contentHash,
      });
      continue;
    }
    if (msg.retracted) continue;
    members.set(msg.hostMessageId, {
      type: "M",
      hostMessageId: msg.hostMessageId,
      role: msg.role,
      contentHash: msg.contentHash,
    });
  }
  const cancelled = new Set<string>();
  for (const entry of pending) {
    if (entry.event.type === "event.cancel") cancelled.add(entry.event.targetEventId);
  }
  for (const entry of pending) {
    const ev = entry.event;
    if (cancelled.has(ev.eventId)) continue;
    if (ev.type === "turn.append" && ev.sourceGeneration === sourceGeneration) {
      members.set(ev.hostMessageId, {
        type: "M",
        hostMessageId: ev.hostMessageId,
        role: ev.role,
        contentHash: ev.chunk?.messageContentHash ?? ev.contentHash,
      });
    } else if (ev.type === "turn.retract" && ev.sourceGeneration === sourceGeneration) {
      members.delete(ev.hostMessageId);
    } else if (ev.type === "sequence.loss" && ev.sourceGeneration === sourceGeneration) {
      members.set(ev.lostHostMessageId, {
        type: "L",
        hostMessageId: ev.lostHostMessageId,
        role: ev.lostRole,
        contentHash: ev.lostContentHash,
      });
    }
  }
  return [...members.values()];
}

export interface CaptureHostHookInput extends OutboxOptions {
  host: CaptureHost;
  event: string;
  rawPayload: string;
  claudeConfigDir?: string;
  cwd?: string;
  serverUrl?: string;
  apiKey?: string;
  workspaceId?: string;
  transport?: DeliveryTransport;
  timeoutMs?: number;
  /** Where this host's capture artifacts live now, so a changed build is detected. */
  artifactRoot?: string;
  /** What the live host gate allows right now. */
  liveGateMode?: CaptureMode;
}

const CAPTURE_MODE_RANK: Record<CaptureMode, number> = {
  unavailable: 0,
  "mcp-only": 1,
  "user-only": 2,
  full: 3,
};

/**
 * The mode consent may still be honored at. Consent is only ever written for a
 * mode the qualification proved against the artifacts hashed into the marker, so
 * once those artifacts change the proof no longer covers what runs, and the
 * saved mode is capped by the live host gate as well. Unverifiable resolves down.
 */
function currentConsentMode(
  consent: { host: CaptureHost; mode: CaptureMode; packageHash: string },
  input: { artifactRoot?: string; liveGateMode?: CaptureMode }
): CaptureMode {
  if (input.artifactRoot === undefined || consent.packageHash.length === 0) return "mcp-only";
  const current = computeCaptureArtifactHash({
    host: consent.host,
    artifactRoot: input.artifactRoot,
  });
  if ("error" in current || current.hash !== consent.packageHash) return "mcp-only";
  const gate = input.liveGateMode ?? "mcp-only";
  return CAPTURE_MODE_RANK[gate] < CAPTURE_MODE_RANK[consent.mode] ? gate : consent.mode;
}

export interface CaptureHostHookResult {
  captured: boolean;
  durable: boolean;
  reason?: string;
}

/**
 * Every turn.append carries its turn origin. Adapters that know the origin set
 * it; the rest are classified from role and content, the same rule the server
 * applies, so a chunked message repeats one origin on every fragment.
 */
function withTurnOrigin<
  T extends { role: "user" | "assistant"; content: string; turnOrigin?: unknown },
>(message: T): T {
  if (message.turnOrigin) return message;
  return { ...message, ...classifyTurnOrigin(message.role, message.content) };
}

export async function captureHostHook(input: CaptureHostHookInput): Promise<CaptureHostHookResult> {
  const envToggle = process.env.MNEMO_HARNESS_V1_ENABLED?.trim().toLowerCase();
  if (envToggle === "false" || envToggle === "0") {
    return { captured: false, durable: false, reason: "disabled_by_env" };
  }

  const home = resolve(input.home ?? process.env.HOME ?? homedir());
  const outboxOpts: OutboxOptions = { ...input, home };
  const savedConsent = await readCaptureConsent(input.host, { home });
  if (!savedConsent) {
    return { captured: false, durable: false, reason: "consent_not_granted" };
  }
  if (savedConsent.mode === "mcp-only" || savedConsent.mode === "unavailable") {
    return { captured: false, durable: false, reason: "capture_mode_inactive" };
  }
  const effectiveMode = currentConsentMode(savedConsent, input);
  if (effectiveMode === "mcp-only" || effectiveMode === "unavailable") {
    return { captured: false, durable: false, reason: "capture_requalification_required" };
  }
  const consent = { ...savedConsent, mode: effectiveMode };
  // Exactly one writer per host. Claude Code also ships the legacy hook writer;
  // the consent marker names which one owns capture, and anything other than an
  // explicit managed selection leaves capture to the legacy writer.
  if (input.host === "claude-code" && consent.writer !== "managed") {
    return { captured: false, durable: false, reason: "legacy_writer_selected" };
  }

  let payload: Record<string, unknown> = {};
  if (input.rawPayload && input.rawPayload.trim().length > 0) {
    try {
      const parsed = JSON.parse(input.rawPayload);
      if (typeof parsed === "object" && parsed !== null) {
        payload = parsed as Record<string, unknown>;
      } else {
        return { captured: false, durable: false, reason: "invalid_hook_payload" };
      }
    } catch {
      return { captured: false, durable: false, reason: "invalid_hook_payload" };
    }
  }

  const cwd =
    typeof payload.cwd === "string" && payload.cwd.length > 0
      ? payload.cwd
      : (input.cwd ?? process.cwd());

  const creds = await resolveHarnessCredentials({
    ...outboxOpts,
    cwd,
    serverUrl: input.serverUrl,
    apiKey: input.apiKey,
    workspaceId: input.workspaceId,
    autoBind: true,
  });
  if (creds.destinationMismatch) {
    // Never send the configured key to the bound server, nor queue new turns
    // under a binding the operator has moved away from.
    return { captured: false, durable: false, reason: "binding_destination_changed" };
  }

  const paths = await ensureSecureHarnessPaths(outboxOpts);
  const clientInstanceId = creds.clientInstanceId;

  const tryFlush = async (): Promise<void> => {
    if (!creds.binding || !creds.apiKey) return;
    const binding = creds.binding;
    const flushed = await flushOutbox({
      ...outboxOpts,
      binding,
      apiKey: creds.apiKey,
      transport: input.transport ?? createFetchDeliveryTransport(input.timeoutMs),
      // The host waits on this hook; draining a backlog is the drain command's job.
      budgetMs: HOOK_DELIVERY_BUDGET_MS,
    }).catch(() => undefined);
    if (flushed)
      await publishManagedSessionMappings(paths, flushed, binding).catch(() => undefined);
  };

  if (input.host === "codex") {
    const hostSessionId =
      typeof payload.session_id === "string" && payload.session_id.length > 0
        ? payload.session_id
        : typeof payload.conversation_id === "string" && payload.conversation_id.length > 0
          ? payload.conversation_id
          : "";
    if (!hostSessionId) {
      return { captured: false, durable: false, reason: "missing_session_id" };
    }
    const runtime = await readRuntimeRecord(paths, "codex", clientInstanceId, hostSessionId);
    if (!runtime.startedGenerations.includes(runtime.activeGeneration)) {
      await enqueueSessionStart(
        {
          host: "codex",
          hostSessionId,
          clientInstanceId,
          requestedGeneration: runtime.activeGeneration,
        },
        outboxOpts
      );
      runtime.startedGenerations.push(runtime.activeGeneration);
      runtime.sessionStartedWithConsent = true;
    }
    if (input.event === "UserPromptSubmit") {
      const msg = toCodexVisibleMessage(payload as { session_id?: string; prompt?: string }, {
        clientInstanceId,
        sourceGeneration: runtime.activeGeneration,
      });
      if (msg) {
        await enqueueVisibleMessage(withTurnOrigin(msg), outboxOpts);
      }
    }
    await writeRuntimeRecord(paths, runtime, outboxOpts);
    await tryFlush();
    return { captured: true, durable: true };
  }

  if (input.host === "opencode") {
    const outboxInput = toOpencodeOutboxInput(payload as never, {
      clientInstanceId,
      sourceGeneration: 0,
    });
    if (!outboxInput) {
      return { captured: false, durable: false, reason: "unsupported_opencode_payload" };
    }
    const runtime = await readRuntimeRecord(
      paths,
      "opencode",
      clientInstanceId,
      outboxInput.hostSessionId
    );
    if (!runtime.startedGenerations.includes(runtime.activeGeneration)) {
      await enqueueSessionStart(
        {
          host: "opencode",
          hostSessionId: outboxInput.hostSessionId,
          clientInstanceId,
          requestedGeneration: runtime.activeGeneration,
        },
        outboxOpts
      );
      runtime.startedGenerations.push(runtime.activeGeneration);
      runtime.sessionStartedWithConsent = true;
    }
    await enqueueVisibleMessage(
      withTurnOrigin({ ...outboxInput, sourceGeneration: runtime.activeGeneration }),
      outboxOpts
    );
    await writeRuntimeRecord(paths, runtime, outboxOpts);
    await tryFlush();
    return { captured: true, durable: true };
  }

  // Claude Code host runtime
  const hostSessionId =
    typeof payload.session_id === "string" && payload.session_id.trim().length > 0
      ? payload.session_id.trim()
      : "";
  if (!hostSessionId) {
    return { captured: false, durable: false, reason: "missing_session_id" };
  }

  // Stop runs asynchronously and can overlap the next UserPromptSubmit. Both
  // read-modify-write this session's runtime record, so they take turns.
  const sessionKey = sourceSessionKey("claude-code", clientInstanceId, hostSessionId);
  return withAdvisoryLock(paths, `runtime-${sessionKey}`, () =>
    captureClaudeCodeHook({
      input,
      payload,
      home,
      outboxOpts,
      paths,
      clientInstanceId,
      consent,
      hostSessionId,
      tryFlush,
    })
  );
}

interface ClaudeCodeHookContext {
  input: CaptureHostHookInput;
  payload: Record<string, unknown>;
  home: string;
  outboxOpts: OutboxOptions;
  paths: HarnessPaths;
  clientInstanceId: string;
  consent: { mode: CaptureMode; consentedAt: string };
  hostSessionId: string;
  tryFlush: () => Promise<void>;
}

async function captureClaudeCodeHook(ctx: ClaudeCodeHookContext): Promise<CaptureHostHookResult> {
  const { input, payload, home, outboxOpts, paths, clientInstanceId, consent, hostSessionId } = ctx;
  const { tryFlush } = ctx;

  const transcriptPath =
    typeof payload.transcript_path === "string" && payload.transcript_path.trim().length > 0
      ? payload.transcript_path.trim()
      : undefined;

  const runtime = await readRuntimeRecord(paths, "claude-code", clientInstanceId, hostSessionId);
  const stateBefore = await readSessionState(
    "claude-code",
    clientInstanceId,
    hostSessionId,
    outboxOpts
  );

  runtime.activeGeneration = latestAcknowledgedGeneration(runtime.activeGeneration, stateBefore);

  const consentedAtMs = Date.parse(consent.consentedAt);

  const loadFilteredTranscript = async (): Promise<TranscriptMessage[] | null> => {
    if (consent.mode !== "full" || !transcriptPath) return null;
    try {
      const loaded = await readClaudeTranscript(transcriptPath, {
        home,
        claudeConfigDir: input.claudeConfigDir,
      });
      const preConsentSet = new Set(runtime.preConsentMessageIds);
      const filteredRaw = loaded.rawEntries.filter((entry) => {
        if (typeof entry.uuid === "string" && preConsentSet.has(entry.uuid)) {
          return false;
        }
        if (typeof entry.timestamp === "string" && Number.isFinite(consentedAtMs)) {
          const entryMs = Date.parse(entry.timestamp);
          if (Number.isFinite(entryMs) && entryMs < consentedAtMs) {
            if (typeof entry.uuid === "string" && entry.uuid.length > 0) {
              preConsentSet.add(entry.uuid);
              if (!runtime.preConsentMessageIds.includes(entry.uuid)) {
                runtime.preConsentMessageIds.push(entry.uuid);
              }
            }
            return false;
          }
        }
        return true;
      });
      return toTranscriptMessages(filteredRaw);
    } catch {
      return null;
    }
  };

  if (input.event === CLAUDE_CODE_EVENTS.sessionStart) {
    const alreadyEnded =
      runtime.endedGenerations.includes(runtime.activeGeneration) ||
      stateBefore.terminalDigests[String(runtime.activeGeneration)] !== undefined ||
      Object.values(stateBefore.acknowledgedEvents).some(
        (ev) => ev.type === "session.end" && ev.sourceGeneration === runtime.activeGeneration
      );
    if (alreadyEnded) {
      runtime.activeGeneration += 1;
    }

    if (!runtime.sessionStartedWithConsent && transcriptPath) {
      try {
        const loaded = await readClaudeTranscript(transcriptPath, {
          home,
          claudeConfigDir: input.claudeConfigDir,
        });
        for (const entry of loaded.rawEntries) {
          if (
            typeof entry.uuid === "string" &&
            typeof entry.timestamp === "string" &&
            Number.isFinite(consentedAtMs) &&
            Date.parse(entry.timestamp) < consentedAtMs &&
            !runtime.preConsentMessageIds.includes(entry.uuid)
          ) {
            runtime.preConsentMessageIds.push(entry.uuid);
          }
        }
      } catch {
        // transcript may not exist yet at SessionStart
      }
    }

    runtime.sessionStartedWithConsent = true;
    if (!runtime.startedGenerations.includes(runtime.activeGeneration)) {
      await enqueueSessionStart(
        {
          host: "claude-code",
          hostSessionId,
          clientInstanceId,
          requestedGeneration: runtime.activeGeneration,
        },
        outboxOpts
      );
      runtime.startedGenerations.push(runtime.activeGeneration);
    }
    writeManagedSessionStateFile(hostSessionId, runtime.serverSessionId);
    await writeRuntimeRecord(paths, runtime, outboxOpts);
    await tryFlush();
    const stateAfter = await readSessionState(
      "claude-code",
      clientInstanceId,
      hostSessionId,
      outboxOpts
    );
    const postMappedGen = latestAcknowledgedGeneration(runtime.activeGeneration, stateAfter);
    if (postMappedGen !== runtime.activeGeneration) {
      runtime.activeGeneration = postMappedGen;
      if (!runtime.startedGenerations.includes(postMappedGen)) {
        runtime.startedGenerations.push(postMappedGen);
      }
      await writeRuntimeRecord(paths, runtime, outboxOpts);
    }
    return { captured: true, durable: true };
  }

  // If the session started before consent was granted, snapshot pre-consent transcript entries
  if (!runtime.sessionStartedWithConsent) {
    if (transcriptPath) {
      try {
        const loaded = await readClaudeTranscript(transcriptPath, {
          home,
          claudeConfigDir: input.claudeConfigDir,
        });
        const currentPrompt =
          input.event === CLAUDE_CODE_EVENTS.userPromptSubmit && typeof payload.prompt === "string"
            ? normalizeVisibleMessage(
                { role: "user", content: payload.prompt },
                { truncate: false }
              ).contentHash
            : null;
        for (let idx = 0; idx < loaded.rawEntries.length; idx += 1) {
          const entry = loaded.rawEntries[idx]!;
          if (typeof entry.uuid !== "string" || entry.uuid.length === 0) continue;
          const isLastEntryMatchingCurrentPrompt =
            currentPrompt !== null &&
            idx === loaded.rawEntries.length - 1 &&
            entry.message?.role === "user" &&
            toTranscriptMessages([entry])[0]?.contentHash === currentPrompt;
          if (
            !isLastEntryMatchingCurrentPrompt &&
            !runtime.preConsentMessageIds.includes(entry.uuid)
          ) {
            runtime.preConsentMessageIds.push(entry.uuid);
          }
        }
      } catch {
        // ignore unreadable transcript during pre-consent snapshot
      }
    }
    runtime.sessionStartedWithConsent = true;
  }

  const ensureCurrentGenerationStarted = async (): Promise<void> => {
    const alreadyEnded =
      runtime.endedGenerations.includes(runtime.activeGeneration) ||
      stateBefore.terminalDigests[String(runtime.activeGeneration)] !== undefined ||
      Object.values(stateBefore.acknowledgedEvents).some(
        (ev) => ev.type === "session.end" && ev.sourceGeneration === runtime.activeGeneration
      );
    if (alreadyEnded && input.event !== CLAUDE_CODE_EVENTS.sessionEnd) {
      runtime.activeGeneration += 1;
    }
    if (!runtime.startedGenerations.includes(runtime.activeGeneration)) {
      await enqueueSessionStart(
        {
          host: "claude-code",
          hostSessionId,
          clientInstanceId,
          requestedGeneration: runtime.activeGeneration,
        },
        outboxOpts
      );
      runtime.startedGenerations.push(runtime.activeGeneration);
    }
  };

  if (input.event === CLAUDE_CODE_EVENTS.userPromptSubmit) {
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    if (prompt.length === 0) {
      return { captured: false, durable: false, reason: "empty_prompt" };
    }
    await ensureCurrentGenerationStarted();
    const normalized = normalizeVisibleMessage(
      { role: "user", content: prompt },
      { truncate: false }
    );

    // Check if the last provisional prompt is still open with identical content
    // and the transcript has not closed the turn with an assistant response.
    const lastProvisional = runtime.provisionalPrompts.at(-1);
    if (
      lastProvisional &&
      !lastProvisional.turnClosed &&
      lastProvisional.contentHash === normalized.contentHash
    ) {
      let turnAdvancedInTranscript = false;
      const transcriptMsgs = await loadFilteredTranscript();
      if (transcriptMsgs) {
        const userCountInTranscript = transcriptMsgs.filter((m) => m.role === "user").length;
        if (userCountInTranscript > runtime.provisionalPrompts.length) {
          turnAdvancedInTranscript = true;
        } else if (
          transcriptMsgs.at(-1)?.role === "assistant" &&
          userCountInTranscript >= runtime.provisionalPrompts.length
        ) {
          turnAdvancedInTranscript = true;
        }
      }
      if (!turnAdvancedInTranscript) {
        await writeRuntimeRecord(paths, runtime, outboxOpts);
        await tryFlush();
        return { captured: true, durable: true };
      }
    }

    for (const prev of runtime.provisionalPrompts) {
      prev.turnClosed = true;
    }

    const samePromptCount = runtime.provisionalPrompts.filter(
      (p) => p.contentHash === normalized.contentHash
    ).length;
    const visible = toClaudeVisibleMessage(
      { session_id: hostSessionId, prompt },
      {
        clientInstanceId,
        sourceGeneration: runtime.activeGeneration,
        occurrenceIndex: samePromptCount,
      }
    );
    if (!visible) {
      return { captured: false, durable: false, reason: "invalid_prompt" };
    }

    await enqueueVisibleMessage(withTurnOrigin(visible), outboxOpts);
    runtime.provisionalPrompts.push({
      provisionalId: visible.hostMessageId,
      occurrenceIndex: samePromptCount,
      contentHash: normalized.contentHash,
      turnClosed: false,
    });
    writeManagedSessionStateFile(hostSessionId, runtime.serverSessionId);
    await writeRuntimeRecord(paths, runtime, outboxOpts);
    await tryFlush();
    return { captured: true, durable: true };
  }

  if (
    input.event === CLAUDE_CODE_EVENTS.stop ||
    input.event === CLAUDE_CODE_EVENTS.preCompact ||
    input.event === CLAUDE_CODE_EVENTS.sessionEnd
  ) {
    for (const prev of runtime.provisionalPrompts) {
      prev.turnClosed = true;
    }
    await ensureCurrentGenerationStarted();

    const applyTranscriptReconciliation = async (): Promise<{
      liveSet: HarnessTerminalMember[];
      terminalReady: boolean;
      reconciledFromTranscript: boolean;
    }> => {
      const currentState = await readSessionState(
        "claude-code",
        clientInstanceId,
        hostSessionId,
        outboxOpts
      );
      runtime.activeGeneration = latestAcknowledgedGeneration(
        runtime.activeGeneration,
        currentState
      );

      const allPending = await readPendingEvents(outboxOpts);
      const sessionPending = allPending.filter(
        (p) =>
          p.event.host === "claude-code" &&
          p.event.clientInstanceId === clientInstanceId &&
          p.event.hostSessionId === hostSessionId
      );

      const transcriptMessages = await loadFilteredTranscript();
      if (!transcriptMessages) {
        const fallbackLive = computeLiveSetFromState(
          runtime.activeGeneration,
          currentState.acknowledgedMessages,
          sessionPending
        );
        return {
          liveSet: fallbackLive,
          terminalReady: true,
          reconciledFromTranscript: false,
        };
      }

      // Bind transcript user UUIDs to provisional prompt IDs so UserPromptSubmit
      // messages are recognized rather than duplicated or retracted.
      const boundProvisionalIds = new Set<string>();
      for (const msg of transcriptMessages) {
        if (msg.role !== "user") continue;
        const existingBinding = runtime.transcriptBindings[msg.hostMessageId];
        if (existingBinding) {
          boundProvisionalIds.add(existingBinding);
        }
      }

      for (const msg of transcriptMessages) {
        if (msg.role !== "user") continue;
        const existingBinding = runtime.transcriptBindings[msg.hostMessageId];
        if (existingBinding) {
          msg.hostMessageId = existingBinding;
          continue;
        }
        // Prefer an unbound provisional prompt with matching contentHash, or the first unbound provisional prompt
        const candidate =
          runtime.provisionalPrompts.find(
            (p) =>
              !p.transcriptUuid &&
              !boundProvisionalIds.has(p.provisionalId) &&
              p.contentHash === msg.contentHash
          ) ??
          runtime.provisionalPrompts.find(
            (p) => !p.transcriptUuid && !boundProvisionalIds.has(p.provisionalId)
          );
        if (candidate) {
          candidate.transcriptUuid = msg.hostMessageId;
          runtime.transcriptBindings[msg.hostMessageId] = candidate.provisionalId;
          boundProvisionalIds.add(candidate.provisionalId);
          msg.hostMessageId = candidate.provisionalId;
        }
      }

      // A resumed conversation's transcript still holds its predecessors'
      // messages. They belong to the generation that captured them, so they are
      // neither re-appended to nor counted in the active generation's terminal set.
      const ownedByEarlierGeneration = new Set<string>();
      for (const known of Object.values(currentState.acknowledgedMessages)) {
        if (known.sourceGeneration < runtime.activeGeneration) {
          ownedByEarlierGeneration.add(known.hostMessageId);
        }
      }
      for (const entry of sessionPending) {
        if (
          entry.event.type === "turn.append" &&
          entry.event.sourceGeneration < runtime.activeGeneration
        ) {
          ownedByEarlierGeneration.add(entry.event.hostMessageId);
        }
      }
      const activeSegment = transcriptMessages.filter(
        (msg) => !ownedByEarlierGeneration.has(msg.hostMessageId)
      );

      const compactedForGen = runtime.compactedMessageIds[String(runtime.activeGeneration)] ?? [];
      const plan = planReconciliation({
        sourceGeneration: runtime.activeGeneration,
        transcript: activeSegment,
        acknowledgedMessages: currentState.acknowledgedMessages,
        acknowledgedMessageChunks: currentState.acknowledgedMessageChunks,
        pending: sessionPending.map((p) => p.event),
        compactedMessageIds: compactedForGen,
      });

      for (const cancellation of plan.cancellations) {
        await enqueueEventCancellation(
          {
            host: "claude-code",
            hostSessionId,
            clientInstanceId,
            sourceGeneration: runtime.activeGeneration,
            targetEventId: cancellation.targetEventId,
            reason: cancellation.reason,
          },
          outboxOpts
        );
      }
      for (const retraction of plan.retractions) {
        await enqueueTurnRetraction(
          {
            host: "claude-code",
            hostSessionId,
            clientInstanceId,
            sourceGeneration: runtime.activeGeneration,
            hostMessageId: retraction.hostMessageId,
            reason: retraction.reason,
          },
          outboxOpts
        );
      }
      for (const append of plan.appends) {
        await enqueueVisibleMessage(
          withTurnOrigin({
            host: "claude-code" as const,
            hostSessionId,
            clientInstanceId,
            sourceGeneration: runtime.activeGeneration,
            hostMessageId: append.hostMessageId,
            role: append.role,
            content: append.content,
            ...(append.turnOrigin
              ? {
                  turnOrigin: append.turnOrigin,
                  ...(append.turnOriginEvidence !== undefined
                    ? { turnOriginEvidence: append.turnOriginEvidence }
                    : {}),
                }
              : {}),
            ...(append.supersedesSourceMessageId !== undefined
              ? { supersedesSourceMessageId: append.supersedesSourceMessageId }
              : {}),
          }),
          outboxOpts
        );
      }

      if (input.event === CLAUDE_CODE_EVENTS.preCompact) {
        const mergedCompacted = new Set([
          ...compactedForGen,
          ...plan.liveSet.map((m) => m.hostMessageId),
        ]);
        runtime.compactedMessageIds[String(runtime.activeGeneration)] = [...mergedCompacted];
      }

      return {
        liveSet: plan.liveSet,
        terminalReady: true,
        reconciledFromTranscript: true,
      };
    };

    let reconciled = await applyTranscriptReconciliation();

    if (input.event === CLAUDE_CODE_EVENTS.sessionEnd) {
      await tryFlush();

      const stateForEnd = await readSessionState(
        "claude-code",
        clientInstanceId,
        hostSessionId,
        outboxOpts
      );
      const genMap = latestAcknowledgedGeneration(runtime.activeGeneration, stateForEnd);
      runtime.activeGeneration = genMap;
      // Delivery may have moved pending occurrences into this segment, even if
      // another ACK had already advanced the runtime's generation beforehand.
      reconciled = await applyTranscriptReconciliation();

      const pendingBeforeEnd = (await readPendingEvents(outboxOpts)).filter(
        (p) =>
          p.event.host === "claude-code" &&
          p.event.clientInstanceId === clientInstanceId &&
          p.event.hostSessionId === hostSessionId
      );

      // Verify no chunked message has missing chunks before emitting session.end
      let hasIncompleteChunks = false;
      for (const [key, partial] of Object.entries(stateForEnd.acknowledgedMessageChunks ?? {})) {
        if (partial.sourceGeneration !== runtime.activeGeneration) continue;
        void key;
        const covered = new Set<number>(Object.keys(partial.chunks).map(Number));
        for (const p of pendingBeforeEnd) {
          if (
            p.event.type === "turn.append" &&
            p.event.sourceGeneration === runtime.activeGeneration &&
            p.event.hostMessageId === partial.hostMessageId &&
            p.event.chunk
          ) {
            covered.add(p.event.chunk.chunkIndex);
          }
        }
        if (covered.size < partial.chunkCount) {
          hasIncompleteChunks = true;
          break;
        }
      }

      const liveMembers = reconciled.reconciledFromTranscript
        ? reconciled.liveSet
        : computeLiveSetFromState(
            runtime.activeGeneration,
            stateForEnd.acknowledgedMessages,
            pendingBeforeEnd
          );

      const digest = computeTerminalDigestV1(liveMembers);
      const alreadyHasEnd =
        pendingBeforeEnd.some(
          (p) =>
            p.event.type === "session.end" &&
            p.event.sourceGeneration === runtime.activeGeneration &&
            p.event.finalMessageSetDigest === digest
        ) ||
        Object.values(stateForEnd.acknowledgedEvents).some(
          (ev) =>
            ev.type === "session.end" &&
            ev.sourceGeneration === runtime.activeGeneration &&
            ev.terminalDigest === digest
        );

      if (!hasIncompleteChunks && !alreadyHasEnd) {
        await enqueueSessionEnd(
          {
            host: "claude-code",
            hostSessionId,
            clientInstanceId,
            sourceGeneration: runtime.activeGeneration,
            reason: "host_end",
            finalMessageSetDigest: digest,
          },
          outboxOpts
        );
        if (!runtime.endedGenerations.includes(runtime.activeGeneration)) {
          runtime.endedGenerations.push(runtime.activeGeneration);
        }
      }
    }

    await writeRuntimeRecord(paths, runtime, outboxOpts);
    await tryFlush();
    return { captured: true, durable: true };
  }

  return { captured: false, durable: false, reason: `unsupported_event:${input.event}` };
}

export async function listHarnessQueue(options: OutboxOptions = {}): Promise<{
  pending: Array<{
    eventId: string;
    type: string;
    enqueueSequence: number;
    bytes: number;
    occurredAt: string;
  }>;
  quarantined: Array<{ id: string; bytes: number }>;
}> {
  const home = resolve(options.home ?? process.env.HOME ?? homedir());
  const paths = await ensureSecureHarnessPaths({ ...options, home });
  const pending = await readPendingEvents({ ...options, home });
  const quarantineFiles = await listSecureRegularFiles(paths.quarantine);
  const quarantined: Array<{ id: string; bytes: number }> = [];
  for (const file of quarantineFiles) {
    const st = await stat(file);
    quarantined.push({ id: basename(file), bytes: st.size });
  }
  // Claude Code's legacy writer spools offline turns outside the outbox; they
  // are just as undelivered, so they are listed with the rest (metadata only).
  const legacy: Array<{
    eventId: string;
    type: string;
    enqueueSequence: number;
    bytes: number;
    occurredAt: string;
  }> = [];
  for (const file of await legacySpoolFiles(paths.state)) {
    try {
      const parsed = JSON.parse(await readPrivateFile(file)) as { pending?: unknown };
      if (!Array.isArray(parsed?.pending)) continue;
      const occurredAt = (await stat(file)).mtime.toISOString();
      parsed.pending.forEach((turn, index) => {
        legacy.push({
          eventId: `${basename(file, ".json")}:${index}`,
          type: "legacy.turn",
          enqueueSequence: index,
          bytes: Buffer.byteLength(JSON.stringify(turn), "utf8"),
          occurredAt,
        });
      });
    } catch {
      // unreadable spool: nothing listable
    }
  }
  return {
    pending: [
      ...pending.map((entry) => ({
        eventId: entry.event.eventId,
        type: entry.event.type,
        enqueueSequence: entry.event.enqueueSequence,
        bytes: entry.bytes,
        occurredAt: entry.event.occurredAt,
      })),
      ...legacy,
    ],
    quarantined,
  };
}

export async function releaseHarnessRetry(
  options: {
    home?: string;
    cwd?: string;
    serverUrl?: string;
    apiKey?: string;
    workspaceId?: string;
    transport?: DeliveryTransport;
    timeoutMs?: number;
  } & AtomicWriteOptions = {}
): Promise<{ released: number; bindingChanged: boolean }> {
  const home = resolve(options.home ?? process.env.HOME ?? homedir());
  const binding = await readBinding({ ...options, home });
  const mnemoConfig = readJsonFileSafe(join(home, ".mnemo", "config.json"));

  const configuredUrl =
    options.serverUrl ??
    process.env.MNEMO_URL ??
    (typeof mnemoConfig?.url === "string" ? mnemoConfig.url : undefined);
  const configuredWorkspaceId =
    options.workspaceId ??
    process.env.MNEMO_WORKSPACE_ID ??
    (options.cwd ? findWorkspaceIdFromCwd(options.cwd) : undefined) ??
    (typeof mnemoConfig?.workspaceId === "string" ? mnemoConfig.workspaceId : undefined);
  const configuredKey =
    options.apiKey ??
    process.env.MNEMO_KEY ??
    process.env.MNEMO_API_KEY ??
    (typeof mnemoConfig?.apiKey === "string" ? mnemoConfig.apiKey : undefined);

  if (binding) {
    let normalizedConfiguredUrl: string | undefined;
    if (configuredUrl) {
      try {
        normalizedConfiguredUrl = new URL(configuredUrl).origin;
      } catch {
        normalizedConfiguredUrl = configuredUrl;
      }
    }
    const urlChanged =
      normalizedConfiguredUrl !== undefined && normalizedConfiguredUrl !== binding.serverUrl;
    const workspaceChanged =
      configuredWorkspaceId !== undefined && configuredWorkspaceId !== binding.workspaceId;
    const keyChanged =
      configuredKey !== undefined && keyFingerprint(configuredKey) !== binding.keyFingerprint;
    if (urlChanged || workspaceChanged || keyChanged) {
      return { released: 0, bindingChanged: true };
    }
  }

  const pending = await readPendingEvents({ ...options, home });
  await clearDeliveryBackoff({ ...options, home });
  if (binding && configuredKey) {
    await flushOutbox({
      ...options,
      home,
      binding,
      apiKey: configuredKey,
      transport: options.transport ?? createFetchDeliveryTransport(options.timeoutMs),
    }).catch(() => undefined);
  }
  return { released: pending.length, bindingChanged: false };
}

/**
 * Host an outbox or quarantine file belongs to, or undefined when its bytes do
 * not say. A file that cannot be attributed is never discarded on behalf of a
 * single host: deleting it could destroy another host's undelivered capture.
 */
async function queuedFileHost(file: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readPrivateFile(file)) as { host?: unknown };
    return typeof parsed?.host === "string" ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}

export async function discardHarnessQueue(
  input: { reason: string; home?: string; host?: string } & AtomicWriteOptions
): Promise<{ discarded: number }> {
  const home = resolve(input.home ?? process.env.HOME ?? homedir());
  const paths = await ensureSecureHarnessPaths({ ...input, home });
  return withAdvisoryLock(paths, "global-capacity", async () => {
    const outboxFiles = await listSecureRegularFiles(paths.outbox);
    const quarantineFiles = await listSecureRegularFiles(paths.quarantine);
    let discarded = 0;
    for (const file of [...outboxFiles, ...quarantineFiles]) {
      // Scoped to one host (uninstall): every other host's queue is untouched.
      if (input.host !== undefined && (await queuedFileHost(file)) !== input.host) continue;
      await unlink(file).catch(() => undefined);
      discarded += 1;
    }
    await fsyncDirectory(paths.outbox);
    await fsyncDirectory(paths.quarantine);
    // The legacy spools are written only by the Claude Code plugin.
    if (input.host === undefined || input.host === "claude-code") {
      const legacyPending = await countLegacyPending(paths.state);
      for (const file of await legacySpoolFiles(paths.state)) {
        await unlink(file).catch(() => undefined);
      }
      discarded += legacyPending;
      await fsyncDirectory(paths.state);
    }

    const auditId = `discard-${randomUUID()}`;
    const auditBody = canonicalJson({
      version: 1,
      type: "operator.discard",
      reason: input.reason,
      ...(input.host !== undefined ? { host: input.host } : {}),
      discardedCount: discarded,
      discardedAt: new Date().toISOString(),
    });
    await atomicWritePrivateFile(join(paths.audit, `${auditId}.json`), auditBody, input).catch(
      () => undefined
    );
    await fsyncDirectory(paths.audit);
    await clearDeliveryBackoff({ ...input, home }).catch(() => undefined);
    return { discarded };
  });
}

export async function probeHarnessServer(
  options: {
    home?: string;
    cwd?: string;
    serverUrl?: string;
    apiKey?: string;
    workspaceId?: string;
    transport?: DeliveryTransport;
    timeoutMs?: number;
  } = {}
): Promise<{ available: boolean; workspaceId: string; persisted: boolean; code?: string }> {
  const home = resolve(options.home ?? process.env.HOME ?? homedir());
  const binding = await readBinding({ home });
  const mnemoConfig = readJsonFileSafe(join(home, ".mnemo", "config.json"));
  const serverUrl =
    options.serverUrl ??
    binding?.serverUrl ??
    process.env.MNEMO_URL ??
    (typeof mnemoConfig?.url === "string" ? mnemoConfig.url : undefined);
  const workspaceId =
    options.workspaceId ??
    binding?.workspaceId ??
    process.env.MNEMO_WORKSPACE_ID ??
    (options.cwd ? findWorkspaceIdFromCwd(options.cwd) : undefined) ??
    (typeof mnemoConfig?.workspaceId === "string" ? mnemoConfig.workspaceId : undefined) ??
    "";
  const apiKey =
    options.apiKey ??
    process.env.MNEMO_KEY ??
    process.env.MNEMO_API_KEY ??
    (typeof mnemoConfig?.apiKey === "string" ? mnemoConfig.apiKey : undefined);

  if (!serverUrl || !workspaceId || !apiKey) {
    return { available: false, workspaceId, persisted: false, code: "missing_credentials" };
  }

  let origin: string;
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    return { available: false, workspaceId, persisted: false, code: "invalid_server_url" };
  }

  const transport = options.transport ?? createFetchDeliveryTransport(options.timeoutMs);
  try {
    const response = await transport.post({
      url: `${origin}/harness/v1/probe`,
      apiKey,
      workspaceId,
      body: JSON.stringify({
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        expectedWorkspaceId: workspaceId,
        clientInstanceId: binding?.installationId ?? "probe-client",
      }),
    });
    if (response.status < 200 || response.status >= 300) {
      return { available: false, workspaceId, persisted: false, code: `http_${response.status}` };
    }
    const parsed = JSON.parse(response.text) as {
      protocolVersion?: number;
      workspaceId?: string;
      available?: boolean;
      code?: string;
    };
    if (parsed.protocolVersion !== HARNESS_PROTOCOL_VERSION || parsed.workspaceId !== workspaceId) {
      return { available: false, workspaceId, persisted: false, code: "invalid_probe_response" };
    }
    return {
      available: Boolean(parsed.available),
      workspaceId,
      persisted: false,
      ...(typeof parsed.code === "string" ? { code: parsed.code } : {}),
    };
  } catch {
    return { available: false, workspaceId, persisted: false, code: "network_error" };
  }
}

export async function drainHarnessQueue(
  options: {
    home?: string;
    cwd?: string;
    serverUrl?: string;
    apiKey?: string;
    workspaceId?: string;
    transport?: DeliveryTransport;
    timeoutMs?: number;
  } & AtomicWriteOptions = {}
): Promise<{ remaining: number; delivered: number }> {
  const creds = await resolveHarnessCredentials({ ...options, autoBind: true });
  await clearDeliveryBackoff({ ...options, home: creds.home }).catch(() => undefined);

  let totalDelivered = 0;
  if (creds.binding && creds.apiKey && !creds.destinationMismatch) {
    const transport = options.transport ?? createFetchDeliveryTransport(options.timeoutMs);
    for (let pass = 0; pass < 32; pass += 1) {
      const pendingBefore = await readPendingEvents({ ...options, home: creds.home });
      if (pendingBefore.length === 0) break;
      const res = await flushOutbox({
        ...options,
        home: creds.home,
        binding: creds.binding,
        apiKey: creds.apiKey,
        transport,
      });
      totalDelivered += res.delivered;
      if (res.delivered === 0) break;
    }
  }
  if (creds.serverUrl && creds.apiKey && !creds.destinationMismatch) {
    // The legacy writer's spools refuse to run once capture is disabled, so the
    // drain is the only way their turns ever leave this machine.
    const legacy = await drainLegacySpools({
      home: creds.home,
      url: creds.serverUrl,
      apiKey: creds.apiKey,
      workspaceId: creds.workspaceId,
    }).catch(() => ({ delivered: 0, remaining: 0 }));
    totalDelivered += legacy.delivered;
  }
  const remaining = await readPendingEvents({ ...options, home: creds.home });
  const paths = await ensureSecureHarnessPaths({ ...options, home: creds.home });
  return {
    remaining: remaining.length + (await countLegacyPending(paths.state)),
    delivered: totalDelivered,
  };
}

export async function quiesceHarnessWorkspace(
  options: {
    home?: string;
    cwd?: string;
    serverUrl?: string;
    apiKey?: string;
    workspaceId?: string;
    transport?: DeliveryTransport;
    timeoutMs?: number;
  } & AtomicWriteOptions = {}
): Promise<{ quiesced: boolean; liveLeases: number; inFlight: number }> {
  const creds = await resolveHarnessCredentials({ ...options, autoBind: false });
  if (creds.destinationMismatch || !creds.serverUrl || !creds.workspaceId || !creds.apiKey) {
    return { quiesced: false, liveLeases: 0, inFlight: 0 };
  }
  let origin: string;
  try {
    origin = new URL(creds.serverUrl).origin;
  } catch {
    return { quiesced: false, liveLeases: 0, inFlight: 0 };
  }
  const transport = options.transport ?? createFetchDeliveryTransport(options.timeoutMs);
  try {
    const response = await transport.post({
      url: `${origin}/admin/harness/quiesce`,
      apiKey: creds.apiKey,
      workspaceId: creds.workspaceId,
      body: JSON.stringify({ workspaceId: creds.workspaceId }),
    });
    if (response.status !== 200 && response.status !== 202) {
      return { quiesced: false, liveLeases: 0, inFlight: 0 };
    }
    const parsed = JSON.parse(response.text) as {
      quiesced?: boolean;
      liveLeaseCount?: number;
      inFlightCount?: number;
      pendingCount?: number;
    };
    const quiesced = Boolean(parsed.quiesced);
    const liveLeases = Number(parsed.liveLeaseCount ?? 0);
    const inFlight = Number(parsed.inFlightCount ?? parsed.pendingCount ?? 0);
    if (quiesced) {
      const paths = await ensureSecureHarnessPaths({ ...options, home: creds.home });
      await atomicWritePrivateFile(
        join(paths.state, QUIESCED_STATE_FILE),
        JSON.stringify({
          version: 1,
          workspaceId: creds.workspaceId,
          quiesced: true,
          quiescedAt: new Date().toISOString(),
        }),
        options
      );
      await fsyncDirectory(paths.state);
    }
    return { quiesced, liveLeases, inFlight };
  } catch {
    return { quiesced: false, liveLeases: 0, inFlight: 0 };
  }
}

export async function readHarnessLifecycleState(input: {
  host: string;
  home?: string;
  cwd?: string;
  serverUrl?: string;
  apiKey?: string;
  workspaceId?: string;
  transport?: DeliveryTransport;
}): Promise<{ activated: boolean; queued: number; quiesced: boolean }> {
  const home = resolve(input.home ?? process.env.HOME ?? homedir());
  const paths = await ensureSecureHarnessPaths({ home });
  const knownHosts = new Set(["opencode", "claude-code", "codex"]);
  const activated = knownHosts.has(input.host)
    ? (await readCaptureConsent(input.host as CaptureHost, { home })) !== null
    : false;
  // Only this host's events: another host's backlog must not block (or be
  // discarded by) this host's uninstall.
  const pending = (await readPendingEvents({ home })).filter(
    (entry) => entry.event.host === input.host
  );
  const legacyQueued = input.host === "claude-code" ? await countLegacyPending(paths.state) : 0;

  let quiesced = false;
  try {
    const raw = JSON.parse(await readPrivateFile(join(paths.state, QUIESCED_STATE_FILE))) as {
      quiesced?: boolean;
    };
    if (raw?.quiesced === true) {
      quiesced = true;
    }
  } catch {
    // check probe if not marked locally
  }
  if (!quiesced) {
    const probe = await probeHarnessServer({
      home,
      cwd: input.cwd,
      serverUrl: input.serverUrl,
      apiKey: input.apiKey,
      workspaceId: input.workspaceId,
      transport: input.transport,
    });
    if (probe.code === "harness_workspace_quiesced") {
      quiesced = true;
    }
  }

  return {
    activated,
    queued: pending.length + legacyQueued,
    quiesced,
  };
}

/** Undelivered turns held by the legacy Claude Code writer's spools. */
async function countLegacyPending(stateDir: string): Promise<number> {
  let count = 0;
  for (const file of await legacySpoolFiles(stateDir)) {
    try {
      const parsed = JSON.parse(await readPrivateFile(file)) as { pending?: unknown };
      if (Array.isArray(parsed?.pending)) count += parsed.pending.length;
    } catch {
      // unreadable spool: nothing countable
    }
  }
  return count;
}

async function legacySpoolFiles(stateDir: string): Promise<string[]> {
  try {
    return (await readdir(stateDir))
      .filter((name) => /^legacy-[0-9a-f]{64}\.json$/.test(name))
      .map((name) => join(stateDir, name));
  } catch {
    return [];
  }
}

export async function removeHostHarnessArtifacts(input: {
  host: string;
  home?: string;
}): Promise<{ removed: string[]; preserved: string[] }> {
  const home = resolve(input.home ?? process.env.HOME ?? homedir());
  const removed: string[] = [];
  const preserved: string[] = [];

  if (input.host === "claude-code") {
    const claudeDir = process.env.CLAUDE_CONFIG_DIR
      ? resolve(process.env.CLAUDE_CONFIG_DIR)
      : join(home, ".claude");
    const installedPluginsPath = join(claudeDir, "plugins", "installed_plugins.json");
    if (existsSync(installedPluginsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(installedPluginsPath, "utf8")) as {
          plugins?: Record<string, unknown>;
        };
        if (parsed && typeof parsed.plugins === "object" && parsed.plugins !== null) {
          for (const key of Object.keys(parsed.plugins)) {
            if (key === "mnemosyne@mnemosyne-local" || key.startsWith("mnemosyne@")) {
              delete parsed.plugins[key];
              removed.push(`${installedPluginsPath}#${key}`);
            } else {
              preserved.push(key);
            }
          }
          writeFileSync(installedPluginsPath, `${JSON.stringify(parsed, null, 2)}\n`, {
            mode: 0o600,
          });
        }
      } catch {
        // ignore malformed user file
      }
    }
    const settingsPath = join(claudeDir, "settings.json");
    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
        if (
          typeof settings.enabledPlugins === "object" &&
          settings.enabledPlugins !== null &&
          !Array.isArray(settings.enabledPlugins)
        ) {
          const enabled = settings.enabledPlugins as Record<string, unknown>;
          for (const key of Object.keys(enabled)) {
            if (key === "mnemosyne@mnemosyne-local" || key.startsWith("mnemosyne@")) {
              delete enabled[key];
              removed.push(`${settingsPath}#enabledPlugins.${key}`);
            } else if (!preserved.includes(key)) {
              preserved.push(key);
            }
          }
          writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
        }
      } catch {
        // ignore malformed user file
      }
    }
    // The legacy writer's spools hold raw conversation turns; uninstall runs only
    // once they are empty or the operator chose to discard them.
    const paths = await ensureSecureHarnessPaths({ home });
    for (const file of await legacySpoolFiles(paths.state)) {
      await unlink(file).catch(() => undefined);
      removed.push(file);
    }
    return { removed, preserved };
  }

  if (input.host === "opencode") {
    const opencodeDir = join(home, ".config", "opencode");
    const pluginFile = join(opencodeDir, "plugins", "mnemosyne.ts");
    if (existsSync(pluginFile)) {
      rmSync(pluginFile, { force: true });
      removed.push(pluginFile);
    }
    const pluginsDir = join(opencodeDir, "plugins");
    if (existsSync(pluginsDir)) {
      try {
        for (const entry of await readdir(pluginsDir)) {
          preserved.push(join(pluginsDir, entry));
        }
      } catch {
        // ignore
      }
    }
    const configPath = join(opencodeDir, "opencode.json");
    if (existsSync(configPath)) {
      try {
        const cfg = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
        if (Array.isArray(cfg.plugin)) {
          const kept: unknown[] = [];
          for (const item of cfg.plugin) {
            if (typeof item === "string" && item.includes("mnemosyne")) {
              removed.push(`${configPath}#plugin:${item}`);
            } else {
              kept.push(item);
              if (typeof item === "string") preserved.push(item);
            }
          }
          cfg.plugin = kept;
          writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
        }
      } catch {
        // ignore
      }
    }
    return { removed, preserved };
  }

  if (input.host === "codex") {
    const marketplaceRoot = join(home, ".mnemo", "codex-marketplace");
    if (existsSync(marketplaceRoot)) {
      rmSync(marketplaceRoot, { recursive: true, force: true });
      removed.push(marketplaceRoot);
    }
    const codexConfig = join(home, ".codex", "config.toml");
    if (existsSync(codexConfig)) {
      preserved.push(codexConfig);
    }
    return { removed, preserved };
  }

  return { removed, preserved };
}
