import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { classifyTurnOrigin } from "@mnemo-ai/types/harness-runtime";
import type { TurnOrigin } from "./content-origin.js";
import {
  atomicWritePrivateFile,
  ensureSecureHarnessPaths,
  readPrivateFile,
  withExclusiveFileLock,
} from "./fs-security.js";
import { normalizeVisibleMessage } from "./sanitize.js";

export interface LegacyHookPayload {
  session_id?: string;
  prompt?: string;
  transcript_path?: string;
  source?: string;
  sourceMessageId?: string;
  turnOrigin?: TurnOrigin;
  turnOriginEvidence?: string;
}
interface PendingTurn {
  sourceMessageId: string;
  role: "user" | "assistant";
  content: string;
  turnOrigin: TurnOrigin;
  turnOriginEvidence: string;
}
interface LegacyState {
  version: 1;
  clientInstanceId: string;
  sessionId?: string;
  generation: number;
  predecessorSessionId?: string;
  pending: PendingTurn[];
  assistantIds: string[];
  transcriptInitialized: boolean;
  /** Pre-generation state files stored a bare flag; read as the current generation. */
  closeRequested?: boolean;
  /** The generation the host ended. A close intent never outlives it. */
  closeRequestedGeneration?: number;
  consentStamp?: string;
  /** Where this spool delivers, so a drain can find it without a host hook. */
  destination?: {
    url: string;
    workspaceId: string;
    hostSessionId: string;
    credentialFingerprint?: string;
  };
  deliveryError?: { status?: number; cause: string; at: string };
}
export interface LegacyCaptureOptions {
  home?: string;
  url: string;
  apiKey: string;
  workspaceId?: string;
  request?: typeof fetch;
  budgetMs?: number;
  /** The host's environment: the capture override and CLAUDE_CONFIG_DIR. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Deliver what is already spooled and capture nothing. Turns queued while
   * capture was on stay deliverable after it is turned off, which is when an
   * operator drains before uninstalling.
   */
  drainOnly?: boolean;
}

/** A holder keeps the lock for at most its network budget; waiting longer than
 * this would eat the prompt hook's recall budget for nothing. */
const LEGACY_LOCK_WAIT_MS = 5_000;

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readPrivateFile(path)) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Legacy payloads have their own envelope, but share the harness's locked,
 * fsynced private-file primitives. Only this writer captures legacy events. */
export async function captureLegacyHook(
  event: string,
  payload: LegacyHookPayload,
  options: LegacyCaptureOptions
): Promise<{ pending: number; sessionId?: string; serverReached?: boolean }> {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const hostSessionId = payload.session_id;
  if (!hostSessionId || !/^[A-Za-z0-9._-]{1,200}$/.test(hostSessionId)) return { pending: 0 };
  const markerPath = join(home, ".mnemo/harness/capture/claude-code.json");
  let marker:
    | { version?: number; host?: string; mode?: string; writer?: string; consentedAt?: string }
    | undefined;
  try {
    marker = await readJson(markerPath);
  } catch {
    marker = undefined;
  }
  if (marker?.writer === "managed" && !options.drainOnly) return { pending: 0 };
  const consented =
    !!marker &&
    marker.version === 1 &&
    marker.host === "claude-code" &&
    ["full", "user-only"].includes(marker.mode ?? "");
  // MNEMO_HARNESS_V1_ENABLED is the server's feature flag. On the client it is
  // only a kill switch, as in the managed runtime (host-runtime.ts): `false`/`0`
  // stops capture, and `true` is not consent (APP-034c) — the marker is.
  const killed = ["false", "0"].includes((env.MNEMO_HARNESS_V1_ENABLED ?? "").trim().toLowerCase());
  const mode = options.drainOnly ? "drain" : consented && !killed ? marker!.mode : undefined;
  if (!mode) return { pending: 0 };
  const paths = await ensureSecureHarnessPaths({ home });
  const binding = JSON.stringify([
    options.url.replace(/\/$/, ""),
    options.workspaceId ?? "",
    hostSessionId,
  ]);
  const key = createHash("sha256").update(binding).digest("hex");
  const statePath = join(paths.state, `legacy-${key}.json`);
  const credentialFingerprint = createHash("sha256").update(options.apiKey).digest("hex");
  // The CLI ships this writer without the optional native fs-ext module, so the
  // lock is the portable O_EXCL one: every legacy hook takes the same kind.
  const locked = <T>(operation: () => Promise<T>) =>
    withExclusiveFileLock(paths, `legacy-${key}`, operation, { waitMs: LEGACY_LOCK_WAIT_MS });
  return locked(async () => {
    const existing = await readJson<LegacyState>(statePath);
    if (options.drainOnly && !existing) return { pending: 0 };
    // A URL (and even an optional workspace hint) does not prove which workspace
    // a replacement key belongs to. Never rebind queued words on a later hook.
    // Older, unbound spools also require explicit recovery instead of guessing.
    if (existing && existing.destination?.credentialFingerprint !== credentialFingerprint)
      return { pending: existing.pending.length, sessionId: existing.sessionId };
    const state = existing ?? {
      version: 1,
      clientInstanceId: randomUUID(),
      generation: 0,
      pending: [],
      assistantIds: [],
      transcriptInitialized: false,
    };
    if (state.closeRequested) state.closeRequestedGeneration ??= state.generation;
    delete state.closeRequested;
    state.destination = {
      url: options.url.replace(/\/$/, ""),
      workspaceId: options.workspaceId ?? "",
      hostSessionId,
      credentialFingerprint,
    };
    // New host activity supersedes an undelivered SessionEnd, even if this
    // invocation is offline too. Persist that before attempting any delivery.
    if (["SessionStart", "UserPromptSubmit", "PostCompact"].includes(event))
      state.closeRequestedGeneration = undefined;
    if (!options.drainOnly && state.consentStamp !== marker?.consentedAt) {
      state.transcriptInitialized = false;
      state.consentStamp = marker?.consentedAt;
    }
    const save = () => atomicWritePrivateFile(statePath, JSON.stringify(state));
    const capture = (
      role: PendingTurn["role"],
      content: string,
      sourceMessageId: string,
      origin?: { turnOrigin?: TurnOrigin; turnOriginEvidence?: string }
    ) => {
      if (state.pending.some((t) => t.sourceMessageId === sourceMessageId)) return;
      const normalized = normalizeVisibleMessage({ role, content });
      if (!normalized.content) return;
      state.pending.push({
        sourceMessageId,
        role,
        content: normalized.content,
        ...classifyTurnOrigin(role, content, origin),
      });
    };
    // On first use, exclude historical assistant messages before the current
    // user entry. Later reconciliation uses native UUIDs, including after compact.
    if (mode === "full" && payload.transcript_path) {
      const entries = await readAssistantTranscript(home, payload.transcript_path, env);
      if (entries) {
        let lastUser = -1;
        entries.forEach((entry, index) => {
          if (entry.role === "user") lastUser = index;
        });
        const start = state.transcriptInitialized
          ? 0
          : event === "SessionStart"
            ? entries.length
            : Math.max(0, lastUser + 1);
        for (const entry of entries.slice(start)) {
          if (entry.role !== "assistant" || state.assistantIds.includes(entry.id)) continue;
          capture("assistant", entry.content, `transcript:${entry.id}`);
          state.assistantIds.push(entry.id);
        }
        // Remember excluded history so compaction cannot make it look new.
        if (!state.transcriptInitialized)
          state.assistantIds.push(
            ...entries
              .slice(0, start)
              .filter((e) => e.role === "assistant")
              .map((e) => e.id)
          );
        state.transcriptInitialized = true;
      }
    }
    if (mode !== "drain" && event === "UserPromptSubmit" && payload.prompt) {
      // Without a native occurrence id, allocate once at durable enqueue. Equal
      // prompts on successive hook invocations remain distinct occurrences.
      const origin = classifyTurnOrigin("user", payload.prompt, payload);
      if (!payload.turnOrigin && origin.turnOrigin === "unknown" && !/[<&]/.test(payload.prompt)) {
        origin.turnOrigin = "human";
        origin.turnOriginEvidence = "host:UserPromptSubmit";
      }
      capture("user", payload.prompt, payload.sourceMessageId ?? randomUUID(), origin);
    }
    if (mode !== "drain" && event === "SessionEnd")
      state.closeRequestedGeneration = state.generation;
    // Persistence precedes every network call, including initial session start.
    await save();
    const request = options.request ?? fetch;
    const deadline = Date.now() + (options.budgetMs ?? 2500);
    const headers = {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
      ...(options.workspaceId ? { "X-Workspace-Id": options.workspaceId } : {}),
    };
    let serverReached = false;
    const send = async (path: string, body?: unknown) => {
      const response = await request(`${options.url.replace(/\/$/, "")}${path}`, {
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        headers,
        signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))),
      });
      serverReached = true;
      return response;
    };
    const publishMapping = async () => {
      const dir = join(paths.mnemoRoot, "sessions");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await atomicWritePrivateFile(
        join(dir, `${hostSessionId}.json`),
        JSON.stringify({
          mnemoSessionId: state.sessionId,
          workspaceId: options.workspaceId ?? "",
          serverUrl: options.url.replace(/\/$/, ""),
          sourceGeneration: state.generation,
          sourceClientInstanceId: state.clientInstanceId,
          createdAt: new Date().toISOString(),
        })
      );
    };
    const open = async () => {
      const res = await send("/session/start", {
        sourceSessionId: hostSessionId,
        sourceClientInstanceId: state.clientInstanceId,
        sourceGeneration: state.generation,
        ...(state.predecessorSessionId ? { predecessorSessionId: state.predecessorSessionId } : {}),
        label: `claude-session-${hostSessionId}`,
      });
      if (!res.ok) {
        state.deliveryError = {
          status: res.status,
          cause: "session_start_rejected",
          at: new Date().toISOString(),
        };
        await save();
        return false;
      }
      const data = (await res.json()) as { id?: string };
      if (!data.id) return false;
      state.sessionId = data.id;
      await save();
      await publishMapping();
      return true;
    };
    // A successor exists because its predecessor is terminal, which is all a
    // close intent for that predecessor asked for. Only turns carried over from
    // the ended generation, inside the SessionEnd that ended it, carry its intent
    // with them; any later event means the host resumed.
    const successor = async (carryClose = false) => {
      if (state.closeRequestedGeneration === state.generation && carryClose)
        state.closeRequestedGeneration = state.generation + 1;
      else if (
        state.closeRequestedGeneration !== undefined &&
        state.closeRequestedGeneration <= state.generation
      )
        state.closeRequestedGeneration = undefined;
      state.predecessorSessionId = state.sessionId;
      state.sessionId = undefined;
      state.generation++;
      await save(); // retry after timeout uses the exact same successor key
      return open();
    };
    try {
      if (!state.sessionId && !(await open()))
        return { pending: state.pending.length, serverReached };
      if (
        (event === "SessionStart" || event === "PostCompact") &&
        state.sessionId &&
        Date.now() < deadline
      ) {
        const current = await send(`/session/${state.sessionId}`);
        if (current.ok) {
          const data = (await current.json()) as { status: string };
          if (["collapsed", "archived"].includes(data.status) && !(await successor()))
            return { pending: state.pending.length, serverReached };
        }
      }
      let redirects = 0;
      while (state.pending.length && Date.now() < deadline) {
        const turn = state.pending[0]!;
        const res = await send(`/session/${state.sessionId}/turn`, {
          ...turn,
          sourceGeneration: state.generation,
        });
        if (res.ok) {
          state.pending.shift();
          state.deliveryError = undefined;
          await save();
          continue;
        }
        if (res.status === 409 && redirects < 8) {
          const data = (await res.json()) as {
            error?: { code?: string; details?: { cause?: string } };
          };
          const cause = data.error?.details?.cause ?? data.error?.code;
          state.deliveryError = {
            status: 409,
            cause: cause ?? "unclassified_conflict",
            at: new Date().toISOString(),
          };
          await save();
          if (cause === "SESSION_TERMINAL" || cause === "LEGACY_SESSION_CLOSED") {
            redirects++;
            if (await successor(event === "SessionEnd")) continue;
          }
        }
        if (res.status !== 409) {
          state.deliveryError = {
            status: res.status,
            cause: "turn_rejected",
            at: new Date().toISOString(),
          };
          await save();
        }
        break; // auth, binding and managed fencing preserve the spool
      }
      if (
        state.closeRequestedGeneration === state.generation &&
        !state.pending.length &&
        Date.now() < deadline
      ) {
        const res = await send(`/session/${state.sessionId}/collapse`, { strategy: "auto" });
        if (res.ok) {
          state.closeRequestedGeneration = undefined;
          await save();
        }
      }
      if (state.sessionId) await publishMapping();
    } catch {
      state.deliveryError = { cause: "transport_unavailable", at: new Date().toISOString() };
      await save();
    }
    return { pending: state.pending.length, sessionId: state.sessionId, serverReached };
  });
}

async function readAssistantTranscript(
  home: string,
  suppliedPath: string,
  env: Readonly<Record<string, string | undefined>>
): Promise<Array<{ id: string; role: string; content: string }> | undefined> {
  try {
    // Claude Code keeps transcripts under CLAUDE_CONFIG_DIR when it is set.
    const configured = env.CLAUDE_CONFIG_DIR?.trim();
    const root = await realpath(configured ? resolve(home, configured) : join(home, ".claude"));
    const target = resolve(suppliedPath);
    if (!target.startsWith(`${root}${sep}`) || !target.endsWith(".jsonl")) return undefined;
    for (let current = target; current !== root; current = dirname(current)) {
      if ((await lstat(current)).isSymbolicLink()) return undefined;
    }
    if ((await realpath(target)) !== target || (await lstat(target)).size > 100 * 1024 * 1024)
      return undefined;
    // Transcript files are host-owned and may be 0644; content is never copied
    // until normalized, and private spool/state files always use 0600.
    const { open } = await import("node:fs/promises");
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: string;
    try {
      const opened = await file.stat();
      if (
        !opened.isFile() ||
        opened.size > 100 * 1024 * 1024 ||
        (await realpath(target)) !== target
      )
        return undefined;
      bytes = await file.readFile("utf8");
    } finally {
      await file.close();
    }
    return bytes.split("\n").flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        const role = entry.message?.role;
        if ((role !== "user" && role !== "assistant") || typeof entry.uuid !== "string") return [];
        const blocks = entry.message.content;
        const content =
          typeof blocks === "string"
            ? blocks
            : Array.isArray(blocks)
              ? blocks
                  .filter((b) => b?.type === "text" && typeof b.text === "string")
                  .map((b) => b.text)
                  .join("")
              : "";
        return content ? [{ id: entry.uuid, role, content }] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return undefined;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Deliver every legacy spool bound to this destination, capturing nothing.
 *
 * A spool written for another server or workspace is left alone: sending its
 * turns with this destination's key is the leak the binding check exists for.
 */
export async function drainLegacySpools(
  options: Omit<LegacyCaptureOptions, "drainOnly" | "env">
): Promise<{ delivered: number; remaining: number }> {
  const home = options.home ?? homedir();
  const paths = await ensureSecureHarnessPaths({ home });
  const url = options.url.replace(/\/$/, "");
  const workspaceId = options.workspaceId ?? "";
  let delivered = 0;
  let remaining = 0;
  let names: string[] = [];
  try {
    names = (await readdir(paths.state)).filter((n) => /^legacy-[0-9a-f]{64}\.json$/.test(n));
  } catch {
    names = [];
  }
  for (const name of names) {
    let state: LegacyState | undefined;
    try {
      state = await readJson<LegacyState>(join(paths.state, name));
    } catch {
      state = undefined;
    }
    const before = state?.pending?.length ?? 0;
    if (!state || before === 0) continue;
    const destination = state.destination;
    if (
      !destination ||
      destination.credentialFingerprint !==
        createHash("sha256").update(options.apiKey).digest("hex") ||
      originOf(destination.url) !== originOf(url) ||
      (destination.workspaceId !== "" && destination.workspaceId !== workspaceId)
    ) {
      remaining += before;
      continue;
    }
    try {
      // The spool's own destination, so the call resolves to this very file.
      const result = await captureLegacyHook(
        "Drain",
        { session_id: destination.hostSessionId },
        {
          ...options,
          home,
          url: destination.url,
          workspaceId: destination.workspaceId || undefined,
          budgetMs: options.budgetMs ?? 30_000,
          drainOnly: true,
        }
      );
      delivered += Math.max(0, before - result.pending);
      remaining += result.pending;
    } catch {
      remaining += before;
    }
  }
  return { delivered, remaining };
}
