import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, HARNESS_MAX_ENQUEUE_SEQUENCE } from "@mnemo-ai/types/harness-runtime";
import { ensureSecureHarnessPaths } from "../fs-security.js";
import {
  acknowledgeEvent as persistAcknowledgement,
  compactTerminalState,
  computeAcknowledgementIdentityHash,
  readSessionState,
  recordEnqueuedSequence,
  repairEnqueuedSequencesUnderLock,
  recoverNextSequence,
  sourceSessionKey,
  writeGenerationMapping,
  type AcknowledgedEvent,
} from "../state.js";
import {
  enqueueVisibleMessage,
  readPendingEvents,
  replaceUnseenWithLoss,
  type HarnessOutboxEvent,
} from "../outbox.js";

const roots: string[] = [];

function temporaryHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mnemo-harness-test-")));
  roots.push(home);
  return home;
}

function acknowledged(event: HarnessOutboxEvent): AcknowledgedEvent {
  if (event.type === "turn.append") {
    const { eventId, enqueueSequence, sourceGeneration, hostMessageId, role, contentHash } = event;
    return {
      type: event.type,
      eventId,
      enqueueSequence,
      sourceGeneration,
      hostMessageId,
      role,
      contentHash,
    };
  }
  if (event.type === "turn.retract") {
    const { eventId, enqueueSequence, sourceGeneration, hostMessageId, reason } = event;
    return { type: event.type, eventId, enqueueSequence, sourceGeneration, hostMessageId, reason };
  }
  if (event.type === "sequence.loss") {
    const {
      eventId,
      enqueueSequence,
      sourceGeneration,
      reason,
      lostEventType,
      lostHostMessageId,
      lostRole,
      lostContentHash,
    } = event;
    return {
      type: event.type,
      eventId,
      enqueueSequence,
      sourceGeneration,
      reason,
      lostEventType,
      lostHostMessageId,
      lostRole,
      lostContentHash,
    };
  }
  if (event.type === "session.start")
    return {
      type: event.type,
      eventId: event.eventId,
      enqueueSequence: event.enqueueSequence,
    };
  if (event.type === "event.cancel") {
    const { eventId, enqueueSequence, sourceGeneration, targetEventId, reason } = event;
    return { type: event.type, eventId, enqueueSequence, sourceGeneration, targetEventId, reason };
  }
  const {
    eventId,
    enqueueSequence,
    sourceGeneration,
    reason,
    finalMessageSetDigest,
    maxEnqueueSequence,
  } = event;
  return {
    type: event.type,
    eventId,
    enqueueSequence,
    sourceGeneration,
    reason,
    finalMessageSetDigest,
    maxEnqueueSequence,
  };
}

async function acknowledgeEvent(
  host: string,
  clientInstanceId: string,
  hostSessionId: string,
  event: AcknowledgedEvent,
  options: { home: string }
) {
  return persistAcknowledgement(host, clientInstanceId, hostSessionId, event, options);
}

async function seedExpectedAcknowledgement(event: AcknowledgedEvent, home: string): Promise<void> {
  const paths = await ensureSecureHarnessPaths({ home });
  await recordEnqueuedSequence(
    "opencode",
    "client-1",
    "session-1",
    event.enqueueSequence,
    computeAcknowledgementIdentityHash(event as unknown as Readonly<Record<string, unknown>>),
    paths
  );
}

async function acknowledgeTerminal(home: string, terminalDigest: string): Promise<void> {
  vi.useFakeTimers();
  vi.setSystemTime("2000-01-01T00:00:00.000Z");
  const terminal: AcknowledgedEvent = {
    type: "session.end",
    eventId: `terminal-${terminalDigest[0]}`,
    enqueueSequence: 2,
    sourceGeneration: 0,
    reason: "host_end",
    finalMessageSetDigest: terminalDigest,
    maxEnqueueSequence: 1,
  };
  await seedExpectedAcknowledgement(terminal, home);
  await persistAcknowledgement("opencode", "client-1", "session-1", terminal, { home });
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable harness state", () => {
  it("atomically retains acknowledgement watermark and generation mapping", async () => {
    const home = temporaryHome();
    const enqueued = await enqueueVisibleMessage(
      {
        host: "opencode",
        hostSessionId: "session-1",
        clientInstanceId: "client-1",
        sourceGeneration: 0,
        hostMessageId: "message-1",
        role: "user",
        content: "one",
        occurredAt: "2000-01-01T00:00:00.000Z",
      },
      { home }
    );
    await writeGenerationMapping("opencode", "client-1", "session-1", 0, 4, { home });
    await acknowledgeEvent("opencode", "client-1", "session-1", acknowledged(enqueued.event), {
      home,
    });
    const state = await readSessionState("opencode", "client-1", "session-1", { home });

    expect(state.acknowledgedWatermark).toBe(1);
    expect(state.generationMappings).toEqual({ "0": 4 });
    expect(state.acknowledgedMessages["0:message-1"]).toMatchObject({
      type: "M",
      role: "user",
      retracted: false,
    });
    expect(statSync(state.path).mode & 0o777).toBe(0o600);
  });

  it("recovers sequence counters from final files and acknowledged watermark", async () => {
    const home = temporaryHome();
    const original = await enqueueVisibleMessage(
      {
        host: "opencode",
        hostSessionId: "session-1",
        clientInstanceId: "client-1",
        sourceGeneration: 0,
        hostMessageId: "lost-1",
        role: "user",
        content: "one",
        occurredAt: "2000-01-01T00:00:00.000Z",
      },
      { home }
    );
    const replacement = await replaceUnseenWithLoss(original.event.eventId, "capacity", { home });
    await acknowledgeEvent("opencode", "client-1", "session-1", acknowledged(replacement.event), {
      home,
    });
    const enqueued = await enqueueVisibleMessage(
      {
        host: "opencode",
        hostSessionId: "session-1",
        clientInstanceId: "client-1",
        sourceGeneration: 0,
        hostMessageId: "message-10",
        role: "assistant",
        content: "ten",
        occurredAt: "2000-01-01T00:00:00.000Z",
      },
      { home }
    );

    await expect(recoverNextSequence("opencode", "client-1", "session-1", { home })).resolves.toBe(
      3
    );
  });

  it("compacts terminal state only after retention while preserving reconciliation identity", async () => {
    const home = temporaryHome();
    const enqueued = await enqueueVisibleMessage(
      {
        host: "opencode",
        hostSessionId: "session-1",
        clientInstanceId: "client-1",
        sourceGeneration: 0,
        hostMessageId: "message-1",
        role: "assistant",
        content: "one",
        occurredAt: "2000-01-01T00:00:00.000Z",
      },
      { home }
    );
    await acknowledgeEvent("opencode", "client-1", "session-1", acknowledged(enqueued.event), {
      home,
    });
    await acknowledgeTerminal(home, "c".repeat(64));
    vi.setSystemTime("2000-01-03T00:00:00.000Z");
    await compactTerminalState(
      "opencode",
      "client-1",
      "session-1",
      {
        sourceGeneration: 0,
        terminalDigest: "c".repeat(64),
        terminalAcknowledgedAt: "2000-01-01T00:00:00.000Z",
        retainUntil: "2000-01-02T00:00:00.000Z",
        now: "2000-01-03T00:00:00.000Z",
      },
      { home }
    );
    const state = await readSessionState("opencode", "client-1", "session-1", { home });

    expect(state.acknowledgedMessages).toEqual({});
    expect(state.messageTombstones["0:message-1"]).toMatchObject({
      type: "M",
      role: "assistant",
      contentHash: enqueued.event.type === "turn.append" ? enqueued.event.contentHash : "",
    });
    expect(state.terminalDigests["0"]).toBe("c".repeat(64));
    expect(state.acknowledgedEvents).toEqual({});
    expect(readFileSync(state.path, "utf8")).not.toContain('"content":');
    // Acknowledgement is durable before delivery unlinks the pending file.
    const pending = await readPendingEvents({ home });
    expect(pending).toHaveLength(1);
    await expect(
      persistAcknowledgement("opencode", "client-1", "session-1", acknowledged(enqueued.event), {
        home,
      })
    ).resolves.toMatchObject({ acknowledgedWatermark: 2 });
    await unlink(pending[0]!.path);
    await expect(
      compactTerminalState(
        "opencode",
        "client-1",
        "session-1",
        {
          sourceGeneration: 0,
          terminalDigest: "c".repeat(64),
          terminalAcknowledgedAt: "2000-01-01T00:00:00.000Z",
          retainUntil: "2000-01-02T00:00:00.000Z",
          now: "2000-01-03T00:00:00.000Z",
        },
        { home }
      )
    ).resolves.toMatchObject({ sequenceTombstones: {} });
  });

  it("preserves other generations' terminal proof when compacting a later prefix", async () => {
    const home = temporaryHome();
    vi.useFakeTimers();
    vi.setSystemTime("2000-01-01T00:00:00.000Z");
    const start: AcknowledgedEvent = {
      type: "session.start",
      eventId: "session-start",
      enqueueSequence: 1,
    };
    const terminals: AcknowledgedEvent[] = [0, 1].map((generation) => ({
      type: "session.end",
      eventId: `terminal-${generation}`,
      enqueueSequence: generation + 2,
      sourceGeneration: generation,
      reason: "host_end",
      finalMessageSetDigest: String(generation).repeat(64),
      maxEnqueueSequence: generation + 1,
    }));
    for (const event of [start, ...terminals]) {
      await seedExpectedAcknowledgement(event, home);
      await persistAcknowledgement("opencode", "client-1", "session-1", event, { home });
    }
    vi.setSystemTime("2000-01-03T00:00:00.000Z");
    for (const generation of [1, 0]) {
      await expect(
        compactTerminalState(
          "opencode",
          "client-1",
          "session-1",
          {
            sourceGeneration: generation,
            terminalDigest: String(generation).repeat(64),
            terminalAcknowledgedAt: "2000-01-01T00:00:00.000Z",
            retainUntil: "2000-01-02T00:00:00.000Z",
            now: "2000-01-03T00:00:00.000Z",
          },
          { home }
        )
      ).resolves.toMatchObject({ acknowledgedWatermark: 3 });
    }
    for (const event of terminals)
      await expect(
        persistAcknowledgement("opencode", "client-1", "session-1", event, { home })
      ).resolves.toMatchObject({ acknowledgedWatermark: 3 });
    const state = await readSessionState("opencode", "client-1", "session-1", { home });
    expect(Object.keys(state.compactedTerminalAcknowledgementHashes)).toHaveLength(2);
    expect(state.acknowledgedEvents).toEqual({});
  });

  it("does not compact before the retention boundary", async () => {
    const home = temporaryHome();
    const enqueued = await enqueueVisibleMessage(
      {
        host: "opencode",
        hostSessionId: "session-1",
        clientInstanceId: "client-1",
        sourceGeneration: 0,
        hostMessageId: "message-1",
        role: "user",
        content: "one",
        occurredAt: "2000-01-01T00:00:00.000Z",
      },
      { home }
    );
    await acknowledgeEvent("opencode", "client-1", "session-1", acknowledged(enqueued.event), {
      home,
    });
    await acknowledgeTerminal(home, "e".repeat(64));
    vi.setSystemTime("2000-01-02T00:00:00.000Z");
    await compactTerminalState(
      "opencode",
      "client-1",
      "session-1",
      {
        sourceGeneration: 0,
        terminalDigest: "e".repeat(64),
        terminalAcknowledgedAt: "2000-01-01T00:00:00.000Z",
        retainUntil: "2000-01-03T00:00:00.000Z",
        now: "2000-01-02T00:00:00.000Z",
      },
      { home }
    );

    expect(
      (await readSessionState("opencode", "client-1", "session-1", { home })).acknowledgedMessages
    ).toHaveProperty("0:message-1");
  });

  it("rejects invalid or inverted terminal retention dates", async () => {
    const home = temporaryHome();
    await expect(
      compactTerminalState(
        "opencode",
        "client-1",
        "session-1",
        {
          sourceGeneration: 0,
          terminalDigest: "e".repeat(64),
          terminalAcknowledgedAt: "not-a-date",
          retainUntil: "2000-01-03T00:00:00.000Z",
          now: "2000-01-04T00:00:00.000Z",
        },
        { home }
      )
    ).rejects.toThrow(/date/i);

    await expect(
      compactTerminalState(
        "opencode",
        "client-1",
        "session-1",
        {
          sourceGeneration: -1,
          terminalDigest: "not-a-digest",
          terminalAcknowledgedAt: "2000-01-01T00:00:00.000Z",
          retainUntil: "2000-01-03T00:00:00.000Z",
          now: "2000-01-04T00:00:00.000Z",
        },
        { home }
      )
    ).rejects.toThrow(/generation|digest/i);
  });

  it("keeps temporary state files private", async () => {
    const home = temporaryHome();
    const enqueued = await enqueueVisibleMessage(
      {
        host: "opencode",
        hostSessionId: "session-1",
        clientInstanceId: "client-1",
        sourceGeneration: 0,
        hostMessageId: "message-1",
        role: "user",
        content: "one",
        occurredAt: "2000-01-01T00:00:00.000Z",
      },
      { home }
    );
    await acknowledgeEvent("opencode", "client-1", "session-1", acknowledged(enqueued.event), {
      home,
    });
    const state = await readSessionState("opencode", "client-1", "session-1", { home });
    expect(readFileSync(state.path, "utf8")).toContain("acknowledgedWatermark");
  });

  it("advances the watermark only through contiguous acknowledged sequences", async () => {
    const home = temporaryHome();
    const enqueued = [];
    for (const [hostMessageId, role] of [
      ["message-1", "user"],
      ["message-2", "assistant"],
    ] as const) {
      enqueued.push(
        await enqueueVisibleMessage(
          {
            host: "opencode",
            hostSessionId: "session-1",
            clientInstanceId: "client-1",
            sourceGeneration: 0,
            hostMessageId,
            role,
            content: hostMessageId,
            occurredAt: "2000-01-01T00:00:00.000Z",
          },
          { home }
        )
      );
    }

    let state = await acknowledgeEvent(
      "opencode",
      "client-1",
      "session-1",
      acknowledged(enqueued[1]!.event),
      { home }
    );
    expect(state.acknowledgedWatermark).toBe(0);

    state = await acknowledgeEvent(
      "opencode",
      "client-1",
      "session-1",
      acknowledged(enqueued[0]!.event),
      { home }
    );
    expect(state.acknowledgedWatermark).toBe(2);
  });

  it("rejects holes beyond the enqueued range and keys identities by generation", async () => {
    const home = temporaryHome();
    const generationZero = await enqueueVisibleMessage(
      {
        host: "opencode",
        hostSessionId: "session-1",
        clientInstanceId: "client-1",
        sourceGeneration: 0,
        hostMessageId: "same",
        role: "user",
        content: "zero",
        occurredAt: "2000-01-01T00:00:00.000Z",
      },
      { home }
    );

    await expect(
      persistAcknowledgement(
        "opencode",
        "client-1",
        "session-1",
        {
          type: "turn.append",
          eventId: "future",
          enqueueSequence: 2,
          sourceGeneration: 0,
          hostMessageId: "same",
          role: "user",
          contentHash: "a".repeat(64),
        },
        { home }
      )
    ).rejects.toThrow(/not enqueued/i);

    await acknowledgeEvent(
      "opencode",
      "client-1",
      "session-1",
      acknowledged(generationZero.event),
      { home }
    );
    const generationOne = await enqueueVisibleMessage(
      {
        host: "opencode",
        hostSessionId: "session-1",
        clientInstanceId: "client-1",
        sourceGeneration: 1,
        hostMessageId: "same",
        role: "assistant",
        content: "one",
        occurredAt: "2000-01-01T00:00:00.000Z",
      },
      { home }
    );
    const generationOneLoss = await replaceUnseenWithLoss(
      generationOne.event.eventId,
      "permanent_rejection",
      { home }
    );
    const state = await acknowledgeEvent(
      "opencode",
      "client-1",
      "session-1",
      acknowledged(generationOneLoss.event),
      { home }
    );

    expect(state.acknowledgedMessages["0:same"]).toMatchObject({ type: "M", role: "user" });
    expect(state.acknowledgedMessages["1:same"]).toMatchObject({
      type: "L",
      role: "assistant",
      lossReason: "permanent_rejection",
    });
  });

  it("rejects acknowledgements that do not match the event recorded at that sequence", async () => {
    const home = temporaryHome();
    const enqueued = await enqueueVisibleMessage(
      {
        host: "opencode",
        hostSessionId: "session-1",
        clientInstanceId: "client-1",
        sourceGeneration: 0,
        hostMessageId: "message-1",
        role: "user",
        content: "one",
      },
      { home }
    );
    const event = acknowledged(enqueued.event);

    await expect(
      persistAcknowledgement(
        "opencode",
        "client-1",
        "session-1",
        { ...event, eventId: "invented-event" },
        { home }
      )
    ).rejects.toThrow(/does not match/i);
  });

  it("binds control acknowledgements to their complete enqueued identity", async () => {
    const home = temporaryHome();
    const event: AcknowledgedEvent = {
      type: "event.cancel",
      eventId: "cancel-1",
      enqueueSequence: 1,
      sourceGeneration: 2,
      targetEventId: "target-1",
      reason: "generation_redirect",
    };
    const paths = await ensureSecureHarnessPaths({ home });
    await recordEnqueuedSequence(
      "opencode",
      "client-1",
      "session-1",
      1,
      computeAcknowledgementIdentityHash(event as unknown as Readonly<Record<string, unknown>>),
      paths
    );

    await expect(
      persistAcknowledgement(
        "opencode",
        "client-1",
        "session-1",
        { ...event, sourceGeneration: 3 },
        { home }
      )
    ).rejects.toThrow(/does not match/i);
  });

  it("requires a matching acknowledged terminal event before compaction", async () => {
    const home = temporaryHome();
    await expect(
      compactTerminalState(
        "opencode",
        "client-1",
        "session-1",
        {
          sourceGeneration: 0,
          terminalDigest: "a".repeat(64),
          terminalAcknowledgedAt: "2000-01-01T00:00:00.000Z",
          retainUntil: "2000-01-02T00:00:00.000Z",
          now: "2000-01-03T00:00:00.000Z",
        },
        { home }
      )
    ).rejects.toThrow(/terminal acknowledgement/i);
  });

  it("refuses terminal compaction while its sequence is beyond the contiguous watermark", async () => {
    const home = temporaryHome();
    const terminal: AcknowledgedEvent = {
      type: "session.end",
      eventId: "terminal-gap",
      enqueueSequence: 3,
      sourceGeneration: 0,
      reason: "host_end",
      finalMessageSetDigest: "d".repeat(64),
      maxEnqueueSequence: 2,
    };
    const paths = await ensureSecureHarnessPaths({ home });
    await recordEnqueuedSequence(
      "opencode",
      "client-1",
      "session-1",
      terminal.enqueueSequence,
      computeAcknowledgementIdentityHash(terminal as unknown as Readonly<Record<string, unknown>>),
      paths
    );
    vi.useFakeTimers();
    vi.setSystemTime("2000-01-01T00:00:00.000Z");
    await persistAcknowledgement("opencode", "client-1", "session-1", terminal, { home });
    vi.setSystemTime("2000-01-03T00:00:00.000Z");

    await expect(
      compactTerminalState(
        "opencode",
        "client-1",
        "session-1",
        {
          sourceGeneration: 0,
          terminalDigest: terminal.finalMessageSetDigest,
          terminalAcknowledgedAt: "2000-01-01T00:00:00.000Z",
          retainUntil: "2000-01-02T00:00:00.000Z",
          now: "2000-01-03T00:00:00.000Z",
        },
        { home }
      )
    ).rejects.toThrow(/contiguous|watermark/i);
  });

  it("advances through retained sequence tombstones when a preceding gap is acknowledged", async () => {
    const home = temporaryHome();
    const paths = await ensureSecureHarnessPaths({ home });
    const key = sourceSessionKey("opencode", "client-1", "session-1");
    const first: AcknowledgedEvent = {
      type: "session.start",
      eventId: "first",
      enqueueSequence: 1,
    };
    const firstHash = computeAcknowledgementIdentityHash(
      first as unknown as Readonly<Record<string, unknown>>
    );
    writeFileSync(
      join(paths.state, `${key}.json`),
      canonicalJson({
        version: 1,
        acknowledgedWatermark: 0,
        lastEnqueuedSequence: 3,
        acknowledgedEvents: {
          third: {
            enqueueSequence: 3,
            type: "session.start",
            acknowledgementHash: "c".repeat(64),
          },
        },
        acknowledgedMessages: {},
        messageTombstones: {},
        sequenceTombstones: { "2": "b".repeat(64) },
        enqueuedAcknowledgementHashes: { "1": firstHash },
        generationMappings: {},
        terminalDigests: {},
      }),
      { mode: 0o600 }
    );

    const state = await persistAcknowledgement("opencode", "client-1", "session-1", first, {
      home,
    });
    expect(state.acknowledgedWatermark).toBe(3);
  });

  // 66 secure writes, each fsyncing its file and every directory up the
  // harness tree: ~1.4 s idle, past the 5 s default under load.
  it("compacts per-event acknowledgement state into a bounded terminal prefix", async () => {
    const home = temporaryHome();
    const paths = await ensureSecureHarnessPaths({ home });
    for (let sequence = 1; sequence <= 32; sequence += 1) {
      const event: AcknowledgedEvent = {
        type: "session.start",
        eventId: `start-${sequence}`,
        enqueueSequence: sequence,
      };
      await recordEnqueuedSequence(
        "opencode",
        "client-1",
        "session-1",
        sequence,
        computeAcknowledgementIdentityHash(event as unknown as Readonly<Record<string, unknown>>),
        paths
      );
      await persistAcknowledgement("opencode", "client-1", "session-1", event, { home });
    }
    const terminal: AcknowledgedEvent = {
      type: "session.end",
      eventId: "terminal-33",
      enqueueSequence: 33,
      sourceGeneration: 0,
      reason: "host_end",
      finalMessageSetDigest: "f".repeat(64),
      maxEnqueueSequence: 32,
    };
    await recordEnqueuedSequence(
      "opencode",
      "client-1",
      "session-1",
      terminal.enqueueSequence,
      computeAcknowledgementIdentityHash(terminal as unknown as Readonly<Record<string, unknown>>),
      paths
    );
    vi.useFakeTimers();
    vi.setSystemTime("2000-01-01T00:00:00.000Z");
    await persistAcknowledgement("opencode", "client-1", "session-1", terminal, { home });
    vi.setSystemTime("2000-01-03T00:00:00.000Z");

    const compacted = await compactTerminalState(
      "opencode",
      "client-1",
      "session-1",
      {
        sourceGeneration: 0,
        terminalDigest: terminal.finalMessageSetDigest,
        terminalAcknowledgedAt: "2000-01-01T00:00:00.000Z",
        retainUntil: "2000-01-02T00:00:00.000Z",
        now: "2000-01-03T00:00:00.000Z",
      },
      { home }
    );
    expect(compacted).toMatchObject({
      compactedAcknowledgementWatermark: 33,
      acknowledgedEvents: {},
      enqueuedAcknowledgementHashes: {},
      sequenceTombstones: {},
    });
    expect(compacted).toMatchObject({
      compactedTerminalAcknowledgementHashes: { "0": expect.any(String) },
    });

    await expect(
      compactTerminalState(
        "opencode",
        "client-1",
        "session-1",
        {
          sourceGeneration: 0,
          terminalDigest: terminal.finalMessageSetDigest,
          terminalAcknowledgedAt: "2000-01-01T00:00:00.000Z",
          retainUntil: "2000-01-02T00:00:00.000Z",
          now: "2000-01-03T00:00:00.000Z",
        },
        { home }
      )
    ).resolves.toMatchObject({
      compactedAcknowledgementWatermark: 33,
      enqueuedAcknowledgementHashes: {},
      sequenceTombstones: {},
    });
  }, 30_000);

  it("compacts every terminal generation in the acknowledged prefix regardless of request order", async () => {
    const home = temporaryHome();
    const acknowledgedAt = "2030-01-01T00:00:00.000Z";
    const compactedAt = "2030-01-03T00:00:00.000Z";
    vi.useFakeTimers();
    vi.setSystemTime(acknowledgedAt);
    const events: AcknowledgedEvent[] = [
      {
        type: "turn.append",
        eventId: "generation-0-message",
        enqueueSequence: 1,
        sourceGeneration: 0,
        hostMessageId: "message-0",
        role: "user",
        contentHash: "a".repeat(64),
      },
      {
        type: "session.end",
        eventId: "generation-0-terminal",
        enqueueSequence: 2,
        sourceGeneration: 0,
        reason: "host_end",
        finalMessageSetDigest: "b".repeat(64),
        maxEnqueueSequence: 1,
      },
      {
        type: "turn.append",
        eventId: "generation-1-message",
        enqueueSequence: 3,
        sourceGeneration: 1,
        hostMessageId: "message-1",
        role: "assistant",
        contentHash: "c".repeat(64),
      },
      {
        type: "session.end",
        eventId: "generation-1-terminal",
        enqueueSequence: 4,
        sourceGeneration: 1,
        reason: "host_end",
        finalMessageSetDigest: "d".repeat(64),
        maxEnqueueSequence: 3,
      },
    ];
    for (const event of events) {
      await seedExpectedAcknowledgement(event, home);
      await persistAcknowledgement("opencode", "client-1", "session-1", event, { home });
    }
    for (const [sourceGeneration, terminalDigest] of [
      [0, "b".repeat(64)],
      [1, "d".repeat(64)],
    ] as const) {
      await compactTerminalState(
        "opencode",
        "client-1",
        "session-1",
        {
          sourceGeneration,
          terminalDigest,
          terminalAcknowledgedAt: acknowledgedAt,
          retainUntil: "2030-01-02T00:00:00.000Z",
          now: acknowledgedAt,
        },
        { home }
      );
    }
    vi.setSystemTime(compactedAt);

    const compacted = await compactTerminalState(
      "opencode",
      "client-1",
      "session-1",
      {
        sourceGeneration: 1,
        terminalDigest: "d".repeat(64),
        terminalAcknowledgedAt: acknowledgedAt,
        retainUntil: "2030-01-02T00:00:00.000Z",
        now: compactedAt,
      },
      { home }
    );
    expect(compacted.acknowledgedEvents).toEqual({});
    expect(compacted.acknowledgedMessages).toEqual({});
    expect(compacted.messageTombstones).toHaveProperty("0:message-0");
    expect(compacted.messageTombstones).toHaveProperty("1:message-1");
    expect(compacted.compactedTerminalAcknowledgementHashes).toEqual({
      "0": expect.any(String),
      "1": expect.any(String),
    });

    await expect(
      compactTerminalState(
        "opencode",
        "client-1",
        "session-1",
        {
          sourceGeneration: 0,
          terminalDigest: "b".repeat(64),
          terminalAcknowledgedAt: acknowledgedAt,
          retainUntil: "2030-01-02T00:00:00.000Z",
          now: compactedAt,
        },
        { home }
      )
    ).resolves.toMatchObject({ acknowledgedEvents: {}, acknowledgedMessages: {} });
  });

  it("preserves replay identity for an interleaved live generation", async () => {
    const home = temporaryHome();
    const acknowledgedAt = "2030-01-01T00:00:00.000Z";
    vi.useFakeTimers();
    vi.setSystemTime(acknowledgedAt);
    const completedMessage: AcknowledgedEvent = {
      type: "turn.append",
      eventId: "generation-0-message",
      enqueueSequence: 1,
      sourceGeneration: 0,
      hostMessageId: "message-0",
      role: "user",
      contentHash: "a".repeat(64),
    };
    const liveMessage: AcknowledgedEvent = {
      type: "turn.append",
      eventId: "generation-1-message",
      enqueueSequence: 2,
      sourceGeneration: 1,
      hostMessageId: "message-1",
      role: "assistant",
      contentHash: "b".repeat(64),
    };
    const completedTerminal: AcknowledgedEvent = {
      type: "session.end",
      eventId: "generation-0-terminal",
      enqueueSequence: 3,
      sourceGeneration: 0,
      reason: "host_end",
      finalMessageSetDigest: "c".repeat(64),
      maxEnqueueSequence: 2,
    };
    for (const event of [completedMessage, liveMessage, completedTerminal]) {
      await seedExpectedAcknowledgement(event, home);
      await persistAcknowledgement("opencode", "client-1", "session-1", event, { home });
    }
    const paths = await ensureSecureHarnessPaths({ home });
    const pendingTerminal = join(paths.outbox, "generation-0-terminal.json");
    writeFileSync(
      pendingTerminal,
      canonicalJson({
        ...completedTerminal,
        host: "opencode",
        clientInstanceId: "client-1",
        hostSessionId: "session-1",
      }),
      { mode: 0o600 }
    );
    vi.setSystemTime("2030-01-03T00:00:00.000Z");

    const compacted = await compactTerminalState(
      "opencode",
      "client-1",
      "session-1",
      {
        sourceGeneration: 0,
        terminalDigest: completedTerminal.finalMessageSetDigest,
        terminalAcknowledgedAt: acknowledgedAt,
        retainUntil: "2030-01-02T00:00:00.000Z",
        now: "2030-01-03T00:00:00.000Z",
      },
      { home }
    );

    expect(compacted.compactedAcknowledgementWatermark).toBe(1);
    expect(compacted.acknowledgedEvents).toEqual({
      "generation-1-message": expect.objectContaining({ enqueueSequence: 2 }),
    });
    expect(compacted.enqueuedAcknowledgementHashes).toEqual({
      "2": computeAcknowledgementIdentityHash(
        liveMessage as unknown as Readonly<Record<string, unknown>>
      ),
    });
    expect(compacted.sequenceTombstones).toEqual({
      "3": computeAcknowledgementIdentityHash(
        completedTerminal as unknown as Readonly<Record<string, unknown>>
      ),
    });
    expect(compacted.acknowledgedMessages).toHaveProperty("1:message-1");
    await expect(
      persistAcknowledgement("opencode", "client-1", "session-1", liveMessage, { home })
    ).resolves.toMatchObject({ acknowledgedEvents: compacted.acknowledgedEvents });
    await expect(
      persistAcknowledgement("opencode", "client-1", "session-1", completedTerminal, { home })
    ).resolves.toMatchObject({ sequenceTombstones: compacted.sequenceTombstones });
    await unlink(pendingTerminal);
    await expect(
      compactTerminalState(
        "opencode",
        "client-1",
        "session-1",
        {
          sourceGeneration: 0,
          terminalDigest: completedTerminal.finalMessageSetDigest,
          terminalAcknowledgedAt: acknowledgedAt,
          retainUntil: "2030-01-02T00:00:00.000Z",
          now: "2030-01-03T00:00:00.000Z",
        },
        { home }
      )
    ).resolves.toMatchObject({ sequenceTombstones: {} });
  });

  it("honors each completed generation's own acknowledgement retention window", async () => {
    const home = temporaryHome();
    const start: AcknowledgedEvent = {
      type: "session.start",
      eventId: "retention-start",
      enqueueSequence: 1,
    };
    const earlierTerminal: AcknowledgedEvent = {
      type: "session.end",
      eventId: "generation-0-terminal-late-ack",
      enqueueSequence: 2,
      sourceGeneration: 0,
      reason: "host_end",
      finalMessageSetDigest: "d".repeat(64),
      maxEnqueueSequence: 1,
    };
    const requestedTerminal: AcknowledgedEvent = {
      type: "session.end",
      eventId: "generation-1-terminal-early-ack",
      enqueueSequence: 3,
      sourceGeneration: 1,
      reason: "host_end",
      finalMessageSetDigest: "e".repeat(64),
      maxEnqueueSequence: 2,
    };
    for (const event of [start, earlierTerminal, requestedTerminal])
      await seedExpectedAcknowledgement(event, home);
    vi.useFakeTimers();
    vi.setSystemTime("2030-01-01T00:00:00.000Z");
    await persistAcknowledgement("opencode", "client-1", "session-1", start, { home });
    await persistAcknowledgement("opencode", "client-1", "session-1", requestedTerminal, { home });
    vi.setSystemTime("2030-01-02T00:00:00.000Z");
    await persistAcknowledgement("opencode", "client-1", "session-1", earlierTerminal, { home });
    vi.setSystemTime("2030-01-02T12:00:00.000Z");

    const compacted = await compactTerminalState(
      "opencode",
      "client-1",
      "session-1",
      {
        sourceGeneration: 1,
        terminalDigest: requestedTerminal.finalMessageSetDigest,
        terminalAcknowledgedAt: "2030-01-01T00:00:00.000Z",
        retainUntil: "2030-01-02T00:00:00.000Z",
        now: "2030-01-02T12:00:00.000Z",
      },
      { home }
    );

    expect(compacted.acknowledgedEvents).toHaveProperty(earlierTerminal.eventId);
    expect(compacted.compactedTerminalAcknowledgementHashes).not.toHaveProperty("0");
    expect(compacted.compactedTerminalAcknowledgementHashes).toHaveProperty("1");
  });

  it("does not shorten a generation's retention window on a later compaction", async () => {
    const home = temporaryHome();
    const acknowledgedAt = "2030-01-01T00:00:00.000Z";
    const events: AcknowledgedEvent[] = [
      {
        type: "session.start",
        eventId: "retention-policy-start",
        enqueueSequence: 1,
      },
      {
        type: "session.end",
        eventId: "retention-policy-generation-0",
        enqueueSequence: 2,
        sourceGeneration: 0,
        reason: "host_end",
        finalMessageSetDigest: "a".repeat(64),
        maxEnqueueSequence: 1,
      },
      {
        type: "session.end",
        eventId: "retention-policy-generation-1",
        enqueueSequence: 3,
        sourceGeneration: 1,
        reason: "host_end",
        finalMessageSetDigest: "b".repeat(64),
        maxEnqueueSequence: 2,
      },
    ];
    vi.useFakeTimers();
    vi.setSystemTime(acknowledgedAt);
    for (const event of events) {
      await seedExpectedAcknowledgement(event, home);
      await persistAcknowledgement("opencode", "client-1", "session-1", event, { home });
    }

    vi.setSystemTime("2030-01-02T00:00:00.000Z");
    await compactTerminalState(
      "opencode",
      "client-1",
      "session-1",
      {
        sourceGeneration: 0,
        terminalDigest: "a".repeat(64),
        terminalAcknowledgedAt: acknowledgedAt,
        retainUntil: "2030-01-31T00:00:00.000Z",
        now: "2030-01-02T00:00:00.000Z",
      },
      { home }
    );

    vi.setSystemTime("2030-01-03T00:00:00.000Z");
    const state = await compactTerminalState(
      "opencode",
      "client-1",
      "session-1",
      {
        sourceGeneration: 1,
        terminalDigest: "b".repeat(64),
        terminalAcknowledgedAt: acknowledgedAt,
        retainUntil: "2030-01-02T00:00:00.000Z",
        now: "2030-01-03T00:00:00.000Z",
      },
      { home }
    );

    expect(state.acknowledgedEvents).toHaveProperty("retention-policy-generation-0");
    expect(state.compactedTerminalAcknowledgementHashes).not.toHaveProperty("0");
    expect(state.compactedTerminalAcknowledgementHashes).toHaveProperty("1");
  });

  it("does not infer another generation's retention deadline", async () => {
    const home = temporaryHome();
    const acknowledgedAt = "2030-01-01T00:00:00.000Z";
    const start: AcknowledgedEvent = {
      type: "session.start",
      eventId: "independent-retention-start",
      enqueueSequence: 1,
    };
    const terminals: AcknowledgedEvent[] = [0, 1].map((sourceGeneration) => ({
      type: "session.end",
      eventId: `independent-retention-${sourceGeneration}`,
      enqueueSequence: sourceGeneration + 2,
      sourceGeneration,
      reason: "host_end",
      finalMessageSetDigest: String(sourceGeneration).repeat(64),
      maxEnqueueSequence: sourceGeneration + 1,
    }));
    vi.useFakeTimers();
    vi.setSystemTime(acknowledgedAt);
    for (const event of [start, ...terminals]) {
      await seedExpectedAcknowledgement(event, home);
      await persistAcknowledgement("opencode", "client-1", "session-1", event, { home });
    }
    vi.setSystemTime("2030-01-03T00:00:00.000Z");

    const state = await compactTerminalState(
      "opencode",
      "client-1",
      "session-1",
      {
        sourceGeneration: 1,
        terminalDigest: "1".repeat(64),
        terminalAcknowledgedAt: acknowledgedAt,
        retainUntil: "2030-01-02T00:00:00.000Z",
        now: "2030-01-03T00:00:00.000Z",
      },
      { home }
    );

    expect(state.acknowledgedEvents).toHaveProperty("independent-retention-0");
    expect(state.compactedTerminalAcknowledgementHashes).not.toHaveProperty("0");
    expect(state.compactedTerminalAcknowledgementHashes).toHaveProperty("1");
  });

  it("rejects a retention deadline before the durably recorded terminal acknowledgement", async () => {
    const home = temporaryHome();
    const terminal: AcknowledgedEvent = {
      type: "session.end",
      eventId: "terminal-retention",
      enqueueSequence: 2,
      sourceGeneration: 0,
      reason: "host_end",
      finalMessageSetDigest: "e".repeat(64),
      maxEnqueueSequence: 1,
    };
    const start: AcknowledgedEvent = {
      type: "session.start",
      eventId: "start-retention",
      enqueueSequence: 1,
    };
    vi.useFakeTimers();
    vi.setSystemTime("2030-01-10T00:00:00.000Z");
    for (const event of [start, terminal]) {
      await seedExpectedAcknowledgement(event, home);
      await persistAcknowledgement("opencode", "client-1", "session-1", event, { home });
    }
    vi.setSystemTime("2030-01-11T00:00:00.000Z");

    await expect(
      compactTerminalState(
        "opencode",
        "client-1",
        "session-1",
        {
          sourceGeneration: 0,
          terminalDigest: terminal.finalMessageSetDigest,
          terminalAcknowledgedAt: "2000-01-01T00:00:00.000Z",
          retainUntil: "2000-01-02T00:00:00.000Z",
          now: "9999-01-01T00:00:00.000Z",
        },
        { home }
      )
    ).rejects.toThrow(/recorded terminal acknowledgement|retention/i);
  });

  it("uses the local clock instead of caller-provided now for retention", async () => {
    const home = temporaryHome();
    const terminal: AcknowledgedEvent = {
      type: "session.end",
      eventId: "terminal-clock",
      enqueueSequence: 2,
      sourceGeneration: 0,
      reason: "host_end",
      finalMessageSetDigest: "f".repeat(64),
      maxEnqueueSequence: 1,
    };
    const start: AcknowledgedEvent = {
      type: "session.start",
      eventId: "start-clock",
      enqueueSequence: 1,
    };
    vi.useFakeTimers();
    vi.setSystemTime("2030-01-10T00:00:00.000Z");
    for (const event of [start, terminal]) {
      await seedExpectedAcknowledgement(event, home);
      await persistAcknowledgement("opencode", "client-1", "session-1", event, { home });
    }
    vi.setSystemTime("2030-01-11T00:00:00.000Z");

    const retained = await compactTerminalState(
      "opencode",
      "client-1",
      "session-1",
      {
        sourceGeneration: 0,
        terminalDigest: terminal.finalMessageSetDigest,
        terminalAcknowledgedAt: "2030-01-10T00:00:00.000Z",
        retainUntil: "2030-01-20T00:00:00.000Z",
        now: "9999-01-01T00:00:00.000Z",
      },
      { home }
    );
    expect(retained.acknowledgedEvents).toHaveProperty(terminal.eventId);
  });

  it("never allows expected acknowledgement identity to be overwritten", async () => {
    const home = temporaryHome();
    const paths = await ensureSecureHarnessPaths({ home });
    await recordEnqueuedSequence("opencode", "client-1", "session-1", 1, "a".repeat(64), paths);
    await expect(
      recordEnqueuedSequence("opencode", "client-1", "session-1", 1, "b".repeat(64), paths)
    ).rejects.toThrow(/identity changed/i);
  });

  it("rejects recovered identities for an already-used sequence after tombstone pruning", async () => {
    const home = temporaryHome();
    const paths = await ensureSecureHarnessPaths({ home });
    const key = sourceSessionKey("opencode", "client-1", "session-1");
    writeFileSync(
      join(paths.state, `${key}.json`),
      canonicalJson({
        version: 1,
        acknowledgedWatermark: 3,
        compactedAcknowledgementWatermark: 1,
        lastEnqueuedSequence: 3,
        acknowledgedEvents: {
          live: {
            enqueueSequence: 2,
            sourceGeneration: 1,
            type: "turn.append",
            acknowledgementHash: "b".repeat(64),
          },
        },
        acknowledgedMessages: {},
        messageTombstones: {},
        sequenceTombstones: {},
        compactedTerminalAcknowledgementHashes: { "0": "c".repeat(64) },
        enqueuedAcknowledgementHashes: { "2": "b".repeat(64) },
        generationMappings: {},
        terminalDigests: { "0": "d".repeat(64) },
      }),
      { mode: 0o600 }
    );

    await expect(
      repairEnqueuedSequencesUnderLock(
        "opencode",
        "client-1",
        "session-1",
        [{ enqueueSequence: 3, acknowledgementHash: "e".repeat(64) }],
        paths
      )
    ).rejects.toThrow(/already-used|identity/i);
  });

  it("rejects invalid acknowledgement discriminants and enum values at runtime", async () => {
    const home = temporaryHome();
    const base = { eventId: "event-1", enqueueSequence: 1, sourceGeneration: 0 };
    await expect(
      persistAcknowledgement(
        "opencode",
        "client-1",
        "session-1",
        {
          ...base,
          type: "turn.append",
          hostMessageId: "m1",
          role: "system",
          contentHash: "a".repeat(64),
        } as never,
        { home }
      )
    ).rejects.toThrow(/role/i);
    await expect(
      persistAcknowledgement(
        "opencode",
        "client-1",
        "session-1",
        {
          ...base,
          type: "sequence.loss",
          reason: "other",
          lostEventType: "unknown",
          lostHostMessageId: "m1",
          lostRole: "user",
          lostContentHash: "a".repeat(64),
        } as never,
        { home }
      )
    ).rejects.toThrow(/loss reason/i);
  });

  it("records retractions as durable tombstones", async () => {
    const home = temporaryHome();
    const append: AcknowledgedEvent = {
      type: "turn.append",
      eventId: "append",
      enqueueSequence: 1,
      sourceGeneration: 0,
      hostMessageId: "message-1",
      role: "user",
      contentHash: "a".repeat(64),
    };
    const retract: AcknowledgedEvent = {
      type: "turn.retract",
      eventId: "retract",
      enqueueSequence: 2,
      sourceGeneration: 0,
      hostMessageId: "message-1",
      reason: "branch_removed",
    };
    await seedExpectedAcknowledgement(append, home);
    await seedExpectedAcknowledgement(retract, home);
    await acknowledgeEvent("opencode", "client-1", "session-1", append, { home });
    const state = await acknowledgeEvent("opencode", "client-1", "session-1", retract, { home });

    expect(state.acknowledgedMessages["0:message-1"]).toMatchObject({ retracted: true });
    expect(state.messageTombstones["0:message-1"]).toMatchObject({ retracted: true });
  });

  it("rejects conflicting acknowledgement and generation mapping rewrites", async () => {
    const home = temporaryHome();
    const enqueued = await enqueueVisibleMessage(
      {
        host: "opencode",
        hostSessionId: "session-1",
        clientInstanceId: "client-1",
        sourceGeneration: 0,
        hostMessageId: "message-1",
        role: "user",
        content: "one",
        occurredAt: "2000-01-01T00:00:00.000Z",
      },
      { home }
    );
    await acknowledgeEvent("opencode", "client-1", "session-1", acknowledged(enqueued.event), {
      home,
    });

    await expect(
      persistAcknowledgement(
        "opencode",
        "client-1",
        "session-1",
        {
          type: "turn.append",
          eventId: enqueued.event.eventId,
          enqueueSequence: 1,
          sourceGeneration: 0,
          hostMessageId: "message-1",
          role: "assistant",
          contentHash: "b".repeat(64),
        },
        { home }
      )
    ).rejects.toThrow(/does not match|identity changed/i);

    await writeGenerationMapping("opencode", "client-1", "session-1", 0, 1, { home });
    await expect(
      writeGenerationMapping("opencode", "client-1", "session-1", 0, 2, { home })
    ).rejects.toThrow(/mapped differently/i);
  });

  it("keeps loss acknowledgement identity immutable and tombstones lost retractions", async () => {
    const home = temporaryHome();
    const append: AcknowledgedEvent = {
      type: "turn.append",
      eventId: "append",
      enqueueSequence: 1,
      sourceGeneration: 0,
      hostMessageId: "message-1",
      role: "user",
      contentHash: "a".repeat(64),
    };
    await seedExpectedAcknowledgement(append, home);
    await acknowledgeEvent("opencode", "client-1", "session-1", append, { home });
    const loss = {
      type: "sequence.loss" as const,
      eventId: "loss",
      enqueueSequence: 2,
      sourceGeneration: 0,
      reason: "permanent_rejection" as const,
      lostEventType: "turn.retract" as const,
      lostHostMessageId: "message-1",
      lostRole: "user" as const,
      lostContentHash: "a".repeat(64),
    };
    await seedExpectedAcknowledgement(loss, home);
    const state = await acknowledgeEvent("opencode", "client-1", "session-1", loss, { home });

    expect(state.acknowledgedMessages["0:message-1"]).toMatchObject({
      type: "L",
      retracted: true,
      lostEventType: "turn.retract",
    });
    expect(state.messageTombstones).toHaveProperty("0:message-1");
    await expect(
      persistAcknowledgement(
        "opencode",
        "client-1",
        "session-1",
        { ...loss, lostHostMessageId: "message-2" },
        { home }
      )
    ).rejects.toThrow(/does not match|identity changed/i);
  });

  it("rejects sequence exhaustion recovered from durable state", async () => {
    const home = temporaryHome();
    const paths = await ensureSecureHarnessPaths({ home });
    const key = sourceSessionKey("opencode", "client-1", "session-1");
    writeFileSync(
      join(paths.state, `${key}.json`),
      canonicalJson({
        version: 1,
        acknowledgedWatermark: 0,
        lastEnqueuedSequence: HARNESS_MAX_ENQUEUE_SEQUENCE,
        acknowledgedEvents: {},
        acknowledgedMessages: {},
        messageTombstones: {},
        sequenceTombstones: {},
        enqueuedAcknowledgementHashes: {},
        generationMappings: {},
        terminalDigests: {},
      }),
      { mode: 0o600 }
    );

    await expect(
      recoverNextSequence("opencode", "client-1", "session-1", { home })
    ).rejects.toThrow(/exhausted/i);
  });

  it("rejects persisted acknowledgement holes with duplicate sequence owners", async () => {
    const home = temporaryHome();
    const paths = await ensureSecureHarnessPaths({ home });
    const key = sourceSessionKey("opencode", "client-1", "session-1");
    writeFileSync(
      join(paths.state, `${key}.json`),
      canonicalJson({
        version: 1,
        acknowledgedWatermark: 0,
        lastEnqueuedSequence: 2,
        acknowledgedEvents: {
          a: {
            enqueueSequence: 2,
            sourceGeneration: 0,
            type: "session.start",
            acknowledgementHash: "a".repeat(64),
          },
          b: {
            enqueueSequence: 2,
            sourceGeneration: 0,
            type: "session.start",
            acknowledgementHash: "b".repeat(64),
          },
        },
        acknowledgedMessages: {},
        messageTombstones: {},
        sequenceTombstones: {},
        generationMappings: {},
        terminalDigests: {},
      }),
      { mode: 0o600 }
    );

    await expect(readSessionState("opencode", "client-1", "session-1", { home })).rejects.toThrow(
      /duplicate acknowledged sequence/i
    );
  });

  it("does not recover another session's temporary state under the wrong lock", async () => {
    const home = temporaryHome();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let tempWritten!: () => void;
    const atTempWrite = new Promise<void>((resolve) => {
      tempWritten = resolve;
    });
    const first = writeGenerationMapping("opencode", "client-1", "session-a", 0, 1, {
      home,
      boundary: async (boundary, path) => {
        if (boundary === "temp-write" && path.includes("/state/")) {
          tempWritten();
          await blocked;
        }
      },
    });
    await atTempWrite;

    await writeGenerationMapping("opencode", "client-1", "session-b", 0, 2, { home });
    release();

    await expect(first).resolves.toMatchObject({ generationMappings: { "0": 1 } });
  });

  it("retains compact sequence ownership and rejects a conflicting late acknowledgement", async () => {
    const home = temporaryHome();
    const enqueued = await enqueueVisibleMessage(
      {
        host: "opencode",
        hostSessionId: "session-1",
        clientInstanceId: "client-1",
        sourceGeneration: 0,
        hostMessageId: "message-1",
        role: "user",
        content: "one",
        occurredAt: "2000-01-01T00:00:00.000Z",
      },
      { home }
    );
    await acknowledgeEvent("opencode", "client-1", "session-1", acknowledged(enqueued.event), {
      home,
    });
    await acknowledgeTerminal(home, "c".repeat(64));
    vi.setSystemTime("2000-01-03T00:00:00.000Z");
    await compactTerminalState(
      "opencode",
      "client-1",
      "session-1",
      {
        sourceGeneration: 0,
        terminalDigest: "c".repeat(64),
        terminalAcknowledgedAt: "2000-01-01T00:00:00.000Z",
        retainUntil: "2000-01-02T00:00:00.000Z",
        now: "2000-01-03T00:00:00.000Z",
      },
      { home }
    );

    await expect(
      acknowledgeEvent(
        "opencode",
        "client-1",
        "session-1",
        {
          type: "session.start",
          eventId: "different-event",
          enqueueSequence: 1,
          sourceGeneration: 0,
        },
        { home }
      )
    ).rejects.toThrow(/compacted sequence|identity changed/i);
  });
});
