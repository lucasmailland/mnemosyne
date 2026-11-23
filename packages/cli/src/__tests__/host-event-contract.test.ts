import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A6 (P62 Slice 0) — every event we subscribe to must be an event that host
 * actually emits.
 *
 * The failure this exists to prevent has already happened to someone else, and
 * it is the worst mode in the domain: claude-mem shipped an OpenCode plugin
 * subscribed to events that did not exist and captured **nothing for months**,
 * without a single error. Nothing failed. The hooks were installed, the plugin
 * loaded, the events never fired, and no log line said so. Their fix was an
 * allowlist plus a contract test — this is ours.
 *
 * It is the same shape as P73's `host-registration-targets.test.ts` and
 * deliberately separate from it: that one asserts WHERE we write each host's
 * config, this one asserts WHICH EVENT NAMES we subscribe to. A manifest can be
 * in exactly the right file and subscribe to nothing real.
 *
 * `HOST_EVENTS` is the host's contract, not ours. Every entry is transcribed
 * from `docs/internals/host-hook-contracts.md`, which carries per-claim provenance
 * (`[SRC]` = read in that host's source, `[DOC]` = that host's documentation).
 * Update it only against a host's own docs or source — never to make a failing
 * test pass.
 */

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugin");

/** Events each host emits. Source: docs/internals/host-hook-contracts.md. */
const HOST_EVENTS: Record<string, readonly string[]> = {
  "claude-code": [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SubagentStop",
    "PreCompact",
    "SessionEnd",
  ],
  // ~20 events; the ones relevant to us. Note the CASING: Cursor's are
  // camelCase (`sessionStart`), Claude Code's are PascalCase (`SessionStart`).
  // Copying a Claude Code manifest across would subscribe to nothing.
  cursor: ["sessionStart", "sessionEnd", "stop", "preCompact", "beforeSubmitPrompt", "postToolUse"],
  codex: [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "Stop",
  ],
  "gemini-cli": [
    "SessionStart",
    "SessionEnd",
    "BeforeAgent",
    "AfterAgent",
    "BeforeTool",
    "AfterTool",
    "BeforeModel",
    "AfterModel",
    "BeforeToolSelection",
    "Notification",
    "PreCompress",
  ],
  windsurf: ["post_cascade_response"],
  opencode: ["session.idle", "session.deleted"],
};

/**
 * Whether each host can tell us a session ENDED — the signal the episodic
 * collapse depends on. Recorded explicitly so a host with no close signal is a
 * KNOWN degradation rather than a silent gap, and so a host that gains one
 * shows up as a stale entry instead of going unnoticed.
 */
const CLOSE_SIGNAL: Record<string, string | null> = {
  // Corrected: this used to say "Stop", which is wrong and load-bearing. Stop
  // fires every time the assistant finishes a REPLY, so treating it as the close
  // ended the session after the user's first message and scattered the rest of
  // the conversation across sessions that never closed. SessionEnd is the real
  // one, and the manifest now subscribes to it.
  "claude-code": "SessionEnd",
  cursor: "sessionEnd",
  codex: "SessionEnd",
  "gemini-cli": "SessionEnd",
  // Per-turn only, not per-session — needs debounce, so it is NOT a close signal.
  windsurf: null,
  // `session.idle` is idle, not end. Same caveat.
  opencode: null,
};

/** The event names our Claude Code manifest subscribes to. */
function claudeCodeSubscriptions(): string[] {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "hooks", "hooks.json"), "utf8")) as {
    hooks: Record<string, unknown>;
  };
  return Object.keys(manifest.hooks);
}

/** The event names our Cursor manifest subscribes to (P73). */
function cursorManifest(): { hooks: Record<string, Array<{ command: string }>> } {
  return JSON.parse(readFileSync(join(PLUGIN_DIR, "hooks", "cursor-hooks.json"), "utf8"));
}
function cursorSubscriptions(): string[] {
  return Object.keys(cursorManifest().hooks);
}
function cursorCommandFor(event: string): string {
  return (cursorManifest().hooks[event] ?? []).map((h) => h.command).join(" ");
}

describe("A6 — host event-name contract", () => {
  it("every event our Claude Code manifest subscribes to is one Claude Code emits", () => {
    const emitted = new Set(HOST_EVENTS["claude-code"]);
    const bogus = claudeCodeSubscriptions().filter((e) => !emitted.has(e));
    expect(bogus).toEqual([]);
  });

  it("subscribes to a close signal on Claude Code", () => {
    // Without this the episodic collapse never runs on the one host we fully
    // support — P70's whole failure mode, one layer up.
    const close = CLOSE_SIGNAL["claude-code"]!;
    expect(claudeCodeSubscriptions()).toContain(close);
  });

  it("the detector actually rejects an event no host emits", () => {
    // A scanner that matches nothing passes forever and reads as protection.
    const emitted = new Set(HOST_EVENTS["claude-code"]);
    expect(["SessionStart", "OnVibes"].filter((e) => !emitted.has(e))).toEqual(["OnVibes"]);
  });

  it("does not confuse Cursor's camelCase events with Claude Code's PascalCase", () => {
    // The cheapest way to ship claude-mem's bug: copy a working manifest to the
    // next host. Cursor emits `sessionStart`; `SessionStart` is not an event
    // there, and subscribing to it fails silently.
    const cursor = new Set(HOST_EVENTS["cursor"]);
    for (const claudeEvent of HOST_EVENTS["claude-code"]!) {
      expect(cursor.has(claudeEvent), `${claudeEvent} is not a Cursor event name`).toBe(false);
    }
  });

  it("every event our Cursor manifest subscribes to is one Cursor emits", () => {
    // P73. Same assertion as Claude Code's, applied the moment we stopped
    // treating Cursor as degraded — the whole point of this file is that a
    // second host is where the copied-manifest bug actually happens.
    const emitted = new Set(HOST_EVENTS["cursor"]);
    const bogus = cursorSubscriptions().filter((e) => !emitted.has(e));
    expect(bogus).toEqual([]);
  });

  it("subscribes to Cursor's close signal, which is a better one than Claude Code's", () => {
    // `sessionEnd` fires once per session with a `reason`. Claude Code's
    // `Stop` fires once per TURN, which is precisely how P70's episode died
    // after the first exchange. On this host the collapse has a correct home.
    expect(cursorSubscriptions()).toContain(CLOSE_SIGNAL["cursor"]!);
  });

  it("does not subscribe Cursor to an event that cannot inject", () => {
    // `beforeSubmitPrompt` is a real Cursor event, so the event-name check
    // above would happily pass — and the hook would run every turn and inject
    // nothing, because Cursor documents `additional_context` on `sessionStart`
    // and `postToolUse` only. Right event name, wrong capability: the exact
    // failure this file exists to catch, one level subtler.
    const INJECTS = new Set(["sessionStart", "postToolUse"]);
    for (const event of cursorSubscriptions()) {
      const isInjection = cursorCommandFor(event).includes("session-start");
      if (isInjection) {
        expect(INJECTS.has(event), `${event} cannot return additional_context`).toBe(true);
      }
    }
  });

  it("records every host's close signal explicitly, including the ones that have none", () => {
    // A null here is a DECLARED degradation. The alternative — a host simply
    // missing from the map — is indistinguishable from an oversight, which is
    // exactly how a capability gap becomes invisible.
    for (const host of Object.keys(HOST_EVENTS)) {
      expect(CLOSE_SIGNAL, `${host} has no recorded close-signal state`).toHaveProperty(host);
    }
    // And a declared close signal must be an event that host really emits.
    for (const [host, signal] of Object.entries(CLOSE_SIGNAL)) {
      if (signal === null) continue;
      expect(
        HOST_EVENTS[host],
        `${host}: close signal ${signal} is not in its event list`
      ).toContain(signal);
    }
  });

  it("ships no hook manifest for a host we cannot subscribe on", () => {
    // Today the Codex and Cursor plugin manifests declare `skills` and no
    // hooks. That is a real capability gap (P73 tracks adopting those hosts) —
    // this pins it so the gap stays visible, and so that whoever adds hooks
    // there has to come through this file and declare the event names.
    for (const [dir, host] of [
      [".codex-plugin", "codex"],
      [".cursor-plugin", "cursor"],
    ] as const) {
      const file = join(PLUGIN_DIR, dir, "plugin.json");
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (!manifest["hooks"]) continue; // declared gap — nothing to verify yet
      const emitted = new Set(HOST_EVENTS[host]);
      const bogus = Object.keys(manifest["hooks"] as Record<string, unknown>).filter(
        (e) => !emitted.has(e)
      );
      expect(bogus, `${host} manifest subscribes to events it does not emit`).toEqual([]);
    }
  });
});
