/**
 * Mnemosyne capture plugin for OpenCode.
 *
 * Deliberately thin. Everything that could go wrong in a durable way — ordering,
 * hashing, locking, retries, HTTP — lives in `@mnemo-ai/harness`. This file
 * translates OpenCode's shapes into that package's calls and gets out of the way.
 *
 * Three rules govern everything here, because this code runs inside somebody's
 * editor:
 *
 *   1. Never throw. A hook that rejects can interrupt a turn. Every handler
 *      swallows its own failures; the harness records them locally instead.
 *   2. Never block. Capture is best-effort by design; a slow or dead server must
 *      not add latency to a keystroke.
 *   3. Never hold a credential. The API key is read from the environment at call
 *      time and never written into plugin source or config.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildManagedMarker,
  enqueueVisibleMessage,
  OPENCODE_CHANNELS,
  OPENCODE_SESSION_EVENTS,
  readCaptureConsent,
  readHostVersion,
  readSessionState,
  resolveHostCaptureMode,
  toVisibleMessage,
} from "@mnemo-ai/harness";

type Hooks = Record<string, unknown>;

/** Stable per-process identity, so events from one run share a client instance. */
const CLIENT_INSTANCE_ID = `opencode-${process.pid}-${Date.now().toString(36)}`;

/** Never throw out of a hook: a rejected hook can interrupt the user's turn. */
async function safely(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch {
    /* The harness owns durable error reporting; a plugin must stay silent. */
  }
}

export default async function mnemosyne(): Promise<Hooks> {
  // Capture is gated on a qualification record for THIS host build. An
  // unqualified or partially qualified install degrades instead of guessing.
  // One reader of the version string, shared with the qualifier that WROTE it.
  // The record is matched on string equality, so reading it here by hand was a
  // second normalisation rule waiting to drift out of step with the first —
  // and drift here does not error, it just stops matching and pins to mcp-only.
  const version = readHostVersion("opencode");
  const capture = resolveHostCaptureMode({
    host: "opencode",
    hostVersion: "version" in version ? version.version : "",
    // A location, not a hash. The digest is computed from these bytes at call
    // time; a value passed in here would be a credential this artifact issues to
    // itself. This file lives at <root>/opencode/mnemosyne.ts.
    artifactRoot: dirname(dirname(fileURLToPath(import.meta.url))),
  });
  // Two independent questions, AND'd. The mode says how much of this host we
  // are ABLE to capture; the marker says whether the user ever agreed to it.
  // A qualified host with no consent captures nothing — installing the plugin
  // is not the act of turning it on.
  const consented = (await readCaptureConsent("opencode")) !== null;
  const enabled = consented && (capture.mode === "full" || capture.mode === "user-only");

  return {
    /** User messages: the one channel every capture mode is allowed to use. */
    [OPENCODE_CHANNELS.userMessage]: async (input: unknown) => {
      if (!enabled) return;
      await safely(async () => {
        const message = toVisibleMessage(input as never, {
          clientInstanceId: CLIENT_INSTANCE_ID,
        });
        // A payload without a stable identity is dropped rather than guessed at.
        if (message) await enqueueVisibleMessage(message);
      });
    },

    /**
     * Tell the model this session is already captured.
     *
     * This channel reaches the model every turn and survives compaction, which is
     * exactly what a suppression marker needs. The marker is generated from local
     * acknowledgement state — never from anything the model said — so a model
     * cannot forge one to silence its own bookkeeping.
     *
     * Appended to the LAST existing system entry rather than pushed as a new one:
     * several chat templates reject multiple system messages outright.
     */
    [OPENCODE_CHANNELS.systemPrompt]: async (
      input: { sessionID?: string },
      output: { system: string[] }
    ) => {
      if (!enabled || !input?.sessionID) return;
      await safely(async () => {
        const state = await readSessionState("opencode", CLIENT_INSTANCE_ID, input.sessionID!);
        const marker = buildManagedMarker({ sessionId: input.sessionID!, state });
        if (output.system.length === 0) output.system.push(marker);
        else output.system[output.system.length - 1] += `\n\n${marker}`;
      });
    },

    /**
     * Session lifecycle.
     *
     * OpenCode has no true session end. `session.idle` plus the server's own
     * inactivity window is the practical close, and `session.deleted` is the only
     * unambiguous one — but acting on deletion needs a qualification proof this
     * install may not have, so it is gated rather than assumed.
     */
    event: async ({ event }: { event: { type?: string } }) => {
      if (!enabled) return;
      await safely(async () => {
        const type = event?.type;
        if (type === OPENCODE_SESSION_EVENTS.idle) {
          // Reconciliation and close are the server's job once capture stops; the
          // plugin only needs to have delivered what it saw.
          return;
        }
        if (type === OPENCODE_SESSION_EVENTS.deleted && capture.mode !== "full") {
          // Deletion handling is only correct when the deletion proof passed.
          return;
        }
      });
    },
  };
}
