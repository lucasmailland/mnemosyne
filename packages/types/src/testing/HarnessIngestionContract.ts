import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  computeTerminalDigestV1,
  sha256Hex,
  type HarnessEvent,
  type HarnessEventAck,
  type HarnessIngestionPort,
  type ManagedSessionProvenance,
} from "../index.js";

export interface HarnessContractSnapshot {
  sessions: Array<{
    id: string;
    clientInstanceId: string;
    generation: number;
    status: string;
    closeKind: string | null;
    turnCount: number;
    tokenCount: number;
    lastActivityAt: Date | null;
    closeGraceDeadline: Date | null;
    sensitivity: string;
    captureIncomplete: boolean;
    predecessorSessionId: string | null;
    terminalMessageSetDigest: string | null;
    terminalMaxEnqueueSequence: number | null;
    leased: boolean;
  }>;
  turns: Array<{
    sessionId: string;
    turnIndex: number;
    sourceMessageId: string;
    supersedesSourceMessageId: string | null;
    role: string;
    content: string;
    contentHash: string;
    retracted: boolean;
  }>;
  ledger: Array<{
    eventId: string;
    state: string;
    payloadHash: string;
    actorId?: string;
    actorType?: string;
    userId?: string | null;
    sensitivityCeiling?: string;
    acknowledgement: HarnessEventAck | null;
  }>;
  losses: Array<{
    sessionId: string;
    sourceMessageId: string;
    role: string;
    contentHash: string;
  }>;
  retractions: Array<{
    sessionId: string;
    sourceMessageId: string;
    predecessorSessionId: string | null;
  }>;
}

export interface HarnessContractFixture {
  workspaceId: string;
  port: HarnessIngestionPort;
  inspect(): Promise<HarnessContractSnapshot>;
  getSessionStatus(id: string): Promise<string | null>;
  setSessionLifecycle(input: {
    generation: number;
    status: "active" | "collapse_pending" | "collapsed" | "archived";
    leased?: boolean;
    closeKind?: "authoritative" | "provisional" | null;
    closeGraceDeadline?: Date | null;
    terminalMaxEnqueueSequence?: number | null;
    terminalMessageSetDigest?: string | null;
  }): Promise<void>;
  seedManagedTurn(input: {
    generation: number;
    sourceMessageId: string;
    role: "user" | "assistant";
    content: string;
    contentHash: string;
  }): Promise<void>;
}

export type HarnessContractFixtureFactory = () => Promise<HarnessContractFixture>;

const provenance: ManagedSessionProvenance = {
  actorId: "key:harness-contract",
  actorType: "agent",
  userId: null,
  sensitivityCeiling: "internal",
};

const PUBLIC_PROVENANCE: ManagedSessionProvenance = {
  ...provenance,
  sensitivityCeiling: "public",
};

const SOURCE = {
  host: "opencode",
  hostSessionId: "host-session",
  clientInstanceId: "client-a",
  normalizationVersion: 1,
  occurredAt: "2000-01-01T00:00:00.000Z",
} as const;

type EventBody = HarnessEvent extends infer E
  ? E extends HarnessEvent
    ? Omit<E, "payloadHash">
    : never
  : never;

function event<T extends EventBody>(body: T): T & { payloadHash: string } {
  return { ...body, payloadHash: sha256Hex(canonicalJson(body)) };
}

function start(
  eventId = "start-1",
  enqueueSequence = 1,
  overrides: Partial<Extract<EventBody, { type: "session.start" }>> = {}
): HarnessEvent {
  return event({
    ...SOURCE,
    eventId,
    enqueueSequence,
    type: "session.start",
    ...overrides,
  } as Extract<EventBody, { type: "session.start" }>);
}

function append(
  eventId: string,
  enqueueSequence: number,
  hostMessageId: string,
  content: string,
  sourceGeneration = 0,
  overrides: Partial<Extract<EventBody, { type: "turn.append" }>> = {}
): HarnessEvent {
  return event({
    ...SOURCE,
    eventId,
    enqueueSequence,
    type: "turn.append",
    sourceGeneration,
    hostMessageId,
    role: "user",
    content,
    contentHash: sha256Hex(content),
    ...overrides,
  } as Extract<EventBody, { type: "turn.append" }>);
}

function end(
  eventId: string,
  enqueueSequence: number,
  maxEnqueueSequence: number,
  members: Parameters<typeof computeTerminalDigestV1>[0],
  sourceGeneration = 0
): HarnessEvent {
  return event({
    ...SOURCE,
    eventId,
    enqueueSequence,
    type: "session.end",
    sourceGeneration,
    reason: "host_end",
    finalMessageSetDigest: computeTerminalDigestV1(members),
    maxEnqueueSequence,
  });
}

async function ingest(
  fixture: HarnessContractFixture,
  harnessEvent: HarnessEvent,
  inputProvenance = provenance,
  receivedAt = new Date("2026-09-08T12:00:00.000Z")
): Promise<HarnessEventAck> {
  return fixture.port.ingestHarnessEvent({
    workspaceId: fixture.workspaceId,
    provenance: inputProvenance,
    event: harnessEvent,
    receivedAt,
  });
}

export function runHarnessIngestionContractTests(makeFixture: HarnessContractFixtureFactory): void {
  describe("HarnessIngestionPort contract", () => {
    let fixture: HarnessContractFixture;

    beforeEach(async () => {
      fixture = await makeFixture();
    });

    it("converges concurrent duplicate starts on one session", async () => {
      const input = start();
      const acknowledgements = await Promise.all(
        Array.from({ length: 8 }, () => ingest(fixture, input))
      );

      expect(new Set(acknowledgements.map((ack) => ack.sessionId)).size).toBe(1);
      expect(acknowledgements.every((ack) => !ack.retryable)).toBe(true);
      expect((await fixture.inspect()).sessions).toHaveLength(1);
    });

    it("isolates identical host session IDs by client instance", async () => {
      const first = await ingest(fixture, start("start-a"));
      const second = await ingest(fixture, start("start-b", 1, { clientInstanceId: "client-b" }));

      expect(second.sessionId).not.toBe(first.sessionId);
      expect((await fixture.inspect()).sessions).toHaveLength(2);
    });

    it("serializes a workspace-wide event ID reused by different logical sources", async () => {
      const first = start("shared-event-id");
      const second = start("shared-event-id", 1, { clientInstanceId: "client-b" });
      const acknowledgements = await Promise.all([ingest(fixture, first), ingest(fixture, second)]);

      expect(acknowledgements.filter((ack) => ack.status === "accepted")).toHaveLength(1);
      expect(acknowledgements.filter((ack) => ack.code === "payload_hash_mismatch")).toHaveLength(
        1
      );
      expect((await fixture.inspect()).sessions).toHaveLength(1);
    });

    it("re-evaluates a retryable missing start and freezes the final acknowledgement", async () => {
      const turn = append("turn-before-start", 2, "message-1", "hello");
      expect(await ingest(fixture, turn)).toMatchObject({
        status: "rejected",
        retryable: true,
        code: "missing_session_start",
      });
      expect((await fixture.inspect()).turns).toHaveLength(0);

      await ingest(fixture, start());
      const accepted = await ingest(fixture, turn);
      expect(accepted).toMatchObject({ status: "accepted", retryable: false });
      const duplicate = await ingest(fixture, turn);
      expect(duplicate).toEqual(accepted);

      const storedAcknowledgement = { ...accepted };
      accepted.code = "caller_mutation";
      expect(await ingest(fixture, turn)).toEqual(storedAcknowledgement);

      const snapshot = await fixture.inspect();
      expect(snapshot.turns).toHaveLength(1);
      expect(snapshot.ledger.filter((row) => row.eventId === "turn-before-start")).toHaveLength(1);
      expect(snapshot.ledger.find((row) => row.eventId === "turn-before-start")?.state).toBe(
        "accepted"
      );
    });

    it("permanently rejects first-delivery semantic hashes before any write", async () => {
      const badPayload = { ...start(), payloadHash: sha256Hex("wrong") };
      expect(await ingest(fixture, badPayload)).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "payload_hash_mismatch",
      });

      const badContent = {
        ...append("bad-content", 2, "message-bad", "hello"),
        contentHash: sha256Hex("wrong"),
      };
      const { payloadHash: _oldHash, ...badContentBody } = badContent;
      expect(await ingest(fixture, event(badContentBody))).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "content_hash_mismatch",
      });

      expect(await fixture.inspect()).toMatchObject({ sessions: [], turns: [], ledger: [] });
    });

    it("rejects replay payload and source-content conflicts without mutating accepted state", async () => {
      await ingest(fixture, start());
      const original = append("turn-1", 2, "message-1", "original");
      await ingest(fixture, original);
      const before = await fixture.inspect();

      const changedReplay = append("turn-1", 2, "message-1", "changed");
      expect(await ingest(fixture, changedReplay)).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "payload_hash_mismatch",
      });
      expect(await ingest(fixture, append("turn-2", 3, "message-1", "changed"))).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "content_hash_mismatch",
      });

      const after = await fixture.inspect();
      expect(after.sessions).toEqual(before.sessions);
      expect(after.turns).toEqual(before.turns);
      expect(after.ledger.filter((row) => row.eventId === "turn-2")).toHaveLength(0);
    });

    it("makes append idempotent and allocates distinct concurrent turn indices", async () => {
      await ingest(fixture, start());
      const first = append("turn-1", 2, "message-1", "one");
      await Promise.all([ingest(fixture, first), ingest(fixture, first)]);
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          ingest(
            fixture,
            append(`turn-${index + 2}`, index + 3, `message-${index + 2}`, `content-${index}`)
          )
        )
      );

      const snapshot = await fixture.inspect();
      expect(snapshot.turns).toHaveLength(9);
      expect(new Set(snapshot.turns.map((turn) => turn.turnIndex)).size).toBe(9);
      expect(snapshot.sessions[0]?.turnCount).toBe(9);
      expect(snapshot.sessions[0]?.tokenCount).toBeGreaterThan(0);
    });

    it("rejects attempts to rebind immutable session provenance or sensitivity", async () => {
      await ingest(fixture, start("public-start", 1, { sensitivity: "public" }), PUBLIC_PROVENANCE);

      expect(await ingest(fixture, start("rebind", 2))).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "session_binding_mismatch",
      });
      expect(
        await ingest(fixture, append("rebound-turn", 3, "rebound-message", "secret"))
      ).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "session_binding_mismatch",
      });
      expect((await fixture.inspect()).sessions[0]).toMatchObject({
        sensitivity: "public",
        turnCount: 0,
        tokenCount: 0,
      });
    });

    it("validates persisted event provenance before returning any replay acknowledgement", async () => {
      const acceptedEvent = start("bound-start");
      const accepted = await ingest(fixture, acceptedEvent);
      const changedProvenance = { ...provenance, actorId: "key:other-actor" as const };

      expect(await ingest(fixture, acceptedEvent, changedProvenance)).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "event_binding_mismatch",
      });
      expect(await ingest(fixture, acceptedEvent)).toEqual(accepted);
      expect((await fixture.inspect()).ledger[0]).toMatchObject({
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        userId: provenance.userId,
        sensitivityCeiling: provenance.sensitivityCeiling,
      });
    });

    it("persists session provenance by value instead of retaining the caller object", async () => {
      const callerOwnedProvenance = { ...provenance };
      await ingest(fixture, start("mutable-provenance-start"), callerOwnedProvenance);
      callerOwnedProvenance.actorId = "key:mutated-after-ingestion";

      expect(
        await ingest(
          fixture,
          append("after-provenance-mutation", 2, "message-after-mutation", "still bound")
        )
      ).toMatchObject({ status: "accepted", retryable: false, effectiveGeneration: 0 });
    });

    it("snapshots caller provenance before waiting for asynchronous ingestion", async () => {
      const callerOwnedProvenance = { ...provenance };
      const pendingStart = ingest(
        fixture,
        start("async-mutable-provenance-start"),
        callerOwnedProvenance
      );
      callerOwnedProvenance.actorId = "key:mutated-before-lock-resume";

      expect(await pendingStart).toMatchObject({ status: "accepted", retryable: false });
      expect(
        await ingest(
          fixture,
          append("after-async-provenance-mutation", 2, "message-after-async-mutation", "bound")
        )
      ).toMatchObject({ status: "accepted", retryable: false, effectiveGeneration: 0 });
      expect(
        (await fixture.inspect()).ledger.find(
          (row) => row.eventId === "async-mutable-provenance-start"
        )
      ).toMatchObject({ actorId: provenance.actorId });
    });

    it("requires end sequence to be exactly one greater than its watermark", async () => {
      await ingest(fixture, start());
      expect(await ingest(fixture, end("bad-end-sequence", 3, 1, []))).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "terminal_sequence_mismatch",
      });
      expect((await fixture.inspect()).ledger.map((row) => row.eventId)).not.toContain(
        "bad-end-sequence"
      );
    });

    it("holds a sequence gap until the contiguous finalized prefix reaches it", async () => {
      await ingest(fixture, start());
      const third = append("turn-3", 3, "message-3", "three");
      expect(await ingest(fixture, third)).toMatchObject({
        status: "rejected",
        retryable: true,
        code: "source_sequence_gap",
      });
      expect((await fixture.inspect()).turns).toHaveLength(0);

      await ingest(fixture, append("turn-2", 2, "message-2", "two"));
      expect(await ingest(fixture, third)).toMatchObject({ status: "accepted", retryable: false });
      expect((await fixture.inspect()).turns.map((turn) => turn.sourceMessageId)).toEqual([
        "message-2",
        "message-3",
      ]);
    });

    it("keeps a terminal event retryable until all lower sequences exist and match the digest", async () => {
      await ingest(fixture, start());
      const member = {
        type: "M" as const,
        hostMessageId: "message-1",
        role: "user" as const,
        contentHash: sha256Hex("hello"),
      };
      const terminal = end("end-1", 3, 2, [member]);

      expect(await ingest(fixture, terminal)).toMatchObject({
        status: "rejected",
        retryable: true,
        code: "incomplete_terminal_barrier",
      });
      await ingest(fixture, append("turn-1", 2, "message-1", "hello"));
      expect(await ingest(fixture, terminal)).toMatchObject({
        status: "accepted",
        retryable: false,
      });
      expect((await fixture.inspect()).sessions[0]?.status).toBe("collapse_pending");
    });

    it.each(["collapsed", "archived"] as const)(
      "does not reopen a %s generation with a later terminal event",
      async (status) => {
        await ingest(fixture, start());
        await ingest(fixture, end("end-1", 2, 1, []));
        await fixture.setSessionLifecycle({ generation: 0, status });

        expect(await ingest(fixture, end("end-2", 3, 2, []))).toMatchObject({
          status: "rejected",
          retryable: false,
          code: "terminal_state_conflict",
        });
        expect((await fixture.inspect()).sessions[0]?.status).toBe(status);
      }
    );

    it("keeps an identical pending barrier idempotent without altering its lease", async () => {
      await ingest(fixture, start());
      const terminal = end("end-idempotent", 2, 1, []);
      const accepted = await ingest(fixture, terminal);
      await fixture.setSessionLifecycle({
        generation: 0,
        status: "collapse_pending",
        leased: true,
      });

      expect(await ingest(fixture, terminal)).toEqual(accepted);
      expect((await fixture.inspect()).sessions[0]).toMatchObject({
        status: "collapse_pending",
        closeKind: "authoritative",
        terminalMaxEnqueueSequence: 1,
        leased: true,
      });
    });

    it("accepts an identical pending barrier carried by a new event ID", async () => {
      const digest = computeTerminalDigestV1([]);
      await ingest(fixture, start());
      await fixture.setSessionLifecycle({
        generation: 0,
        status: "collapse_pending",
        leased: true,
        closeKind: "authoritative",
        closeGraceDeadline: new Date("2026-09-08T12:01:00.000Z"),
        terminalMaxEnqueueSequence: 1,
        terminalMessageSetDigest: digest,
      });

      expect(await ingest(fixture, end("new-identical-end", 2, 1, []))).toMatchObject({
        status: "accepted",
        retryable: false,
        effectiveGeneration: 0,
      });
    });

    it("does not overwrite a conflicting pending barrier or alter its lease", async () => {
      await ingest(fixture, start());
      await ingest(fixture, end("end-original", 2, 1, []));
      await fixture.setSessionLifecycle({
        generation: 0,
        status: "collapse_pending",
        leased: true,
      });
      const before = (await fixture.inspect()).sessions[0];

      expect(await ingest(fixture, end("end-conflict", 3, 2, []))).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "terminal_barrier_conflict",
      });
      expect((await fixture.inspect()).sessions[0]).toEqual(before);
    });

    it("records identity-complete loss and marks capture incomplete", async () => {
      await ingest(fixture, start());
      const loss = event({
        ...SOURCE,
        eventId: "loss-1",
        enqueueSequence: 2,
        type: "sequence.loss",
        sourceGeneration: 0,
        reason: "capacity",
        lostEventType: "turn.append",
        lostHostMessageId: "missing-message",
        lostRole: "assistant",
        lostContentHash: sha256Hex("missing"),
      });
      expect(await ingest(fixture, loss)).toMatchObject({ status: "accepted", retryable: false });

      const snapshot = await fixture.inspect();
      expect(snapshot.sessions[0]?.captureIncomplete).toBe(true);
      expect(snapshot.losses).toEqual([
        expect.objectContaining({
          sourceMessageId: "missing-message",
          role: "assistant",
          contentHash: sha256Hex("missing"),
        }),
      ]);
    });

    it("rejects a loss marker whose known message identity is inconsistent", async () => {
      await ingest(fixture, start());
      await ingest(fixture, append("turn-1", 2, "message-1", "hello"));
      const loss = event({
        ...SOURCE,
        eventId: "loss-bad",
        enqueueSequence: 3,
        type: "sequence.loss",
        sourceGeneration: 0,
        reason: "permanent_rejection",
        lostEventType: "turn.retract",
        lostHostMessageId: "message-1",
        lostRole: "assistant",
        lostContentHash: sha256Hex("different"),
      });

      expect(await ingest(fixture, loss)).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "loss_identity_mismatch",
      });
      expect((await fixture.inspect()).turns[0]?.retracted).toBe(false);
    });

    it("rejects a lost append that contradicts an existing source message without writing", async () => {
      await ingest(fixture, start());
      await ingest(fixture, append("turn-1", 2, "message-1", "hello"));
      const contradictoryLoss = event({
        ...SOURCE,
        eventId: "loss-existing-append",
        enqueueSequence: 3,
        type: "sequence.loss",
        sourceGeneration: 0,
        reason: "capacity",
        lostEventType: "turn.append",
        lostHostMessageId: "message-1",
        lostRole: "user",
        lostContentHash: sha256Hex("hello"),
      });

      expect(await ingest(fixture, contradictoryLoss)).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "loss_identity_conflict",
      });
      expect((await fixture.inspect()).ledger.map((row) => row.eventId)).not.toContain(
        "loss-existing-append"
      );
    });

    it("rejects duplicate loss identity deterministically and keeps terminal digest computable", async () => {
      await ingest(fixture, start());
      const firstLoss = event({
        ...SOURCE,
        eventId: "loss-1",
        enqueueSequence: 2,
        type: "sequence.loss",
        sourceGeneration: 0,
        reason: "capacity",
        lostEventType: "turn.append",
        lostHostMessageId: "missing-message",
        lostRole: "assistant",
        lostContentHash: sha256Hex("missing"),
      });
      const duplicateLoss = event({
        ...firstLoss,
        eventId: "loss-duplicate",
        enqueueSequence: 3,
      });
      const { payloadHash: _payloadHash, ...duplicateLossBody } = duplicateLoss;
      await ingest(fixture, firstLoss);

      expect(await ingest(fixture, event(duplicateLossBody))).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "loss_identity_conflict",
      });
      const member = {
        type: "L" as const,
        hostMessageId: "missing-message",
        role: "assistant" as const,
        contentHash: sha256Hex("missing"),
      };
      expect(await ingest(fixture, end("end-after-loss", 3, 2, [member]))).toMatchObject({
        status: "accepted",
      });
    });

    it("rejects an append that contradicts an existing loss identity without writing", async () => {
      await ingest(fixture, start());
      const loss = event({
        ...SOURCE,
        eventId: "loss-before-append",
        enqueueSequence: 2,
        type: "sequence.loss",
        sourceGeneration: 0,
        reason: "capacity",
        lostEventType: "turn.append",
        lostHostMessageId: "lost-message",
        lostRole: "user",
        lostContentHash: sha256Hex("lost"),
      });
      await ingest(fixture, loss);

      expect(
        await ingest(fixture, append("append-after-loss", 3, "lost-message", "lost"))
      ).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "loss_identity_conflict",
      });
      expect((await fixture.inspect()).ledger.map((row) => row.eventId)).not.toContain(
        "append-after-loss"
      );
    });

    it("applies an identity-complete lost retraction and records incomplete capture", async () => {
      await ingest(fixture, start());
      await ingest(fixture, append("turn-1", 2, "message-1", "hello"));
      const loss = event({
        ...SOURCE,
        eventId: "loss-retract",
        enqueueSequence: 3,
        type: "sequence.loss",
        sourceGeneration: 0,
        reason: "capacity",
        lostEventType: "turn.retract",
        lostHostMessageId: "message-1",
        lostRole: "user",
        lostContentHash: sha256Hex("hello"),
      });

      expect(await ingest(fixture, loss)).toMatchObject({ status: "accepted", retryable: false });
      const snapshot = await fixture.inspect();
      expect(snapshot.turns[0]?.retracted).toBe(true);
      expect(snapshot.sessions[0]?.captureIncomplete).toBe(true);
      expect(snapshot.losses).toHaveLength(1);
    });

    it("lets a targeted cancel overtake only its retryable target", async () => {
      const target = append("target", 1, "message-target", "hello");
      await ingest(fixture, target);
      const cancel = event({
        ...SOURCE,
        eventId: "cancel-1",
        enqueueSequence: 2,
        type: "event.cancel",
        sourceGeneration: 0,
        targetEventId: "target",
        reason: "terminal_rebuild",
      });
      expect(await ingest(fixture, cancel)).toMatchObject({ status: "accepted", retryable: false });
      expect(await ingest(fixture, target)).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "event_cancelled",
      });

      const unrelated = event({
        ...cancel,
        eventId: "cancel-unrelated",
        enqueueSequence: 3,
        targetEventId: "not-a-target",
      });
      const { payloadHash: _payloadHash, ...unrelatedBody } = unrelated;
      const missingTarget = await ingest(fixture, event(unrelatedBody));
      expect(missingTarget).toMatchObject({
        status: "rejected",
        retryable: true,
        code: "cancel_target_not_retryable",
      });
      expect(await ingest(fixture, event(unrelatedBody))).toEqual(missingTarget);
      expect(await ingest(fixture, start("after-missing-target", 4))).toMatchObject({
        status: "rejected",
        retryable: true,
        code: "lower_sequence_pending",
      });
    });

    it("permanently rejects cancellation of a target bound to different provenance", async () => {
      const targetProvenance = {
        ...provenance,
        actorId: "key:different-target-actor" as const,
      };
      const target = append("different-provenance-target", 1, "target-message", "target");
      await ingest(fixture, target, targetProvenance);
      const cancel = event({
        ...SOURCE,
        eventId: "different-provenance-cancel",
        enqueueSequence: 2,
        type: "event.cancel",
        sourceGeneration: 0,
        targetEventId: target.eventId,
        reason: "terminal_rebuild",
      });

      const mismatch = await ingest(fixture, cancel);
      expect(mismatch).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "cancel_target_not_retryable",
      });
      expect(await ingest(fixture, cancel)).toEqual(mismatch);
      expect(
        (await fixture.inspect()).ledger.find((row) => row.eventId === target.eventId)?.state
      ).toBe("retryable");
      expect(await ingest(fixture, start("after-provenance-mismatch", 3))).toMatchObject({
        status: "rejected",
        retryable: true,
        code: "lower_sequence_pending",
      });
    });

    it("permanently rejects cancellation of a finalized target and advances ordering", async () => {
      const acceptedStart = start("accepted-cancel-target");
      await ingest(fixture, acceptedStart);
      const cancel = event({
        ...SOURCE,
        eventId: "cancel-accepted-target",
        enqueueSequence: 2,
        type: "event.cancel",
        sourceGeneration: 0,
        targetEventId: acceptedStart.eventId,
        reason: "generation_redirect",
      });

      const mismatch = await ingest(fixture, cancel);
      expect(mismatch).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "cancel_target_not_retryable",
      });
      expect(await ingest(fixture, cancel)).toEqual(mismatch);
      expect(
        await ingest(fixture, append("after-state-mismatch", 3, "message-3", "three"))
      ).toMatchObject({
        status: "accepted",
        retryable: false,
      });
    });

    it("cancels a retryable cancellation whose own target never appeared", async () => {
      const target = event({
        ...SOURCE,
        eventId: "retryable-cancel-target",
        enqueueSequence: 1,
        type: "event.cancel",
        sourceGeneration: 0,
        targetEventId: "absent-original-target",
        reason: "generation_redirect",
      });
      expect(await ingest(fixture, target)).toMatchObject({
        status: "rejected",
        retryable: true,
        code: "cancel_target_not_retryable",
      });
      const cancel = event({
        ...SOURCE,
        eventId: "nested-cancel",
        enqueueSequence: 2,
        type: "event.cancel",
        sourceGeneration: 0,
        targetEventId: target.eventId,
        reason: "generation_redirect",
      });

      const accepted = await ingest(fixture, cancel);
      expect(accepted).toMatchObject({
        status: "accepted",
        retryable: false,
      });
      expect(await ingest(fixture, cancel)).toEqual(accepted);
      expect(await ingest(fixture, target)).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "event_cancelled",
      });
      expect(
        (await fixture.inspect()).ledger.find((row) => row.eventId === target.eventId)?.state
      ).toBe("cancelled");
      expect(await ingest(fixture, start("after-nested-cancel", 3))).toMatchObject({
        status: "accepted",
        retryable: false,
      });
    });

    it("permanently rejects cancellation whose sequence does not follow its target", async () => {
      const target = append("later-cancel-target", 2, "later-message", "later");
      await ingest(fixture, target);
      const cancel = event({
        ...SOURCE,
        eventId: "earlier-cancel",
        enqueueSequence: 1,
        type: "event.cancel",
        sourceGeneration: 0,
        targetEventId: target.eventId,
        reason: "generation_redirect",
      });

      const mismatch = await ingest(fixture, cancel);
      expect(mismatch).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "cancel_target_not_retryable",
      });
      expect(await ingest(fixture, cancel)).toEqual(mismatch);
      expect(await ingest(fixture, start("after-order-mismatch", 3))).toMatchObject({
        status: "rejected",
        retryable: true,
        code: "lower_sequence_pending",
      });
    });

    it("does not let cancellation overtake an unrelated lower retryable event", async () => {
      await ingest(fixture, append("first-retryable", 1, "message-1", "one"));
      await ingest(fixture, append("second-retryable", 2, "message-2", "two"));
      const cancel = event({
        ...SOURCE,
        eventId: "cancel-second",
        enqueueSequence: 3,
        type: "event.cancel",
        sourceGeneration: 0,
        targetEventId: "second-retryable",
        reason: "terminal_rebuild",
      });

      expect(await ingest(fixture, cancel)).toMatchObject({
        status: "rejected",
        retryable: true,
        code: "lower_sequence_pending",
      });
      expect(
        (await fixture.inspect()).ledger.find((row) => row.eventId === "second-retryable")?.state
      ).toBe("retryable");
    });

    it("does not let a data event overtake a known lower retryable event", async () => {
      await ingest(fixture, start());
      const missingRetraction = event({
        ...SOURCE,
        eventId: "missing-retraction",
        enqueueSequence: 2,
        type: "turn.retract",
        sourceGeneration: 0,
        hostMessageId: "not-yet-known",
        reason: "branch_removed",
      });
      await ingest(fixture, missingRetraction);

      expect(
        await ingest(fixture, append("blocked-append", 3, "message-3", "three"))
      ).toMatchObject({
        status: "rejected",
        retryable: true,
        code: "lower_sequence_pending",
      });
      expect((await fixture.inspect()).turns).toHaveLength(0);
    });

    it("does not let cancellation finalize across missing lower source sequences", async () => {
      const target = append("gap-target", 3, "gap-message", "gap");
      await ingest(fixture, target);
      const cancel = event({
        ...SOURCE,
        eventId: "gap-cancel",
        enqueueSequence: 4,
        type: "event.cancel",
        sourceGeneration: 0,
        targetEventId: target.eventId,
        reason: "terminal_rebuild",
      });

      expect(await ingest(fixture, cancel)).toMatchObject({
        status: "rejected",
        retryable: true,
        code: "source_sequence_gap",
      });
      expect(
        (await fixture.inspect()).ledger.find((row) => row.eventId === target.eventId)?.state
      ).toBe("retryable");
    });

    it("exempts only the cancellation target while requiring every other lower sequence", async () => {
      const target = append("early-gap-target", 1, "early-gap-message", "gap");
      await ingest(fixture, target);
      const cancel = event({
        ...SOURCE,
        eventId: "late-gap-cancel",
        enqueueSequence: 4,
        type: "event.cancel",
        sourceGeneration: 0,
        targetEventId: target.eventId,
        reason: "terminal_rebuild",
      });

      expect(await ingest(fixture, cancel)).toMatchObject({
        status: "rejected",
        retryable: true,
        code: "source_sequence_gap",
      });
      expect(
        (await fixture.inspect()).ledger.find((row) => row.eventId === target.eventId)?.state
      ).toBe("retryable");
    });

    it("cannot cancel a retryable event belonging to another client instance", async () => {
      await ingest(fixture, append("other-client-target", 1, "message-1", "one"));
      const cancel = event({
        ...SOURCE,
        clientInstanceId: "client-b",
        eventId: "cross-client-cancel",
        enqueueSequence: 2,
        type: "event.cancel",
        sourceGeneration: 0,
        targetEventId: "other-client-target",
        reason: "terminal_rebuild",
      });

      const mismatch = await ingest(fixture, cancel);
      expect(mismatch).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "cancel_target_not_retryable",
      });
      expect(await ingest(fixture, cancel)).toEqual(mismatch);
      expect(
        (await fixture.inspect()).ledger.find((row) => row.eventId === "other-client-target")?.state
      ).toBe("retryable");
      expect(
        await ingest(fixture, start("after-source-mismatch", 3, { clientInstanceId: "client-b" }))
      ).toMatchObject({
        status: "rejected",
        retryable: true,
        code: "source_sequence_gap",
      });
    });

    it("allocates one successor generation for concurrent continuations", async () => {
      await ingest(fixture, start());
      await fixture.setSessionLifecycle({ generation: 0, status: "collapsed" });

      const acknowledgements = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          ingest(fixture, append(`turn-${index}`, index + 2, `message-${index}`, `c-${index}`))
        )
      );
      expect(new Set(acknowledgements.map((ack) => ack.effectiveGeneration))).toEqual(new Set([1]));

      const snapshot = await fixture.inspect();
      expect(snapshot.sessions.map((session) => session.generation).sort()).toEqual([0, 1]);
      expect(
        snapshot.sessions.find((session) => session.generation === 1)?.predecessorSessionId
      ).toBe(snapshot.sessions.find((session) => session.generation === 0)?.id);
    });

    it("walks past terminal successors and creates exactly one latest writable generation", async () => {
      await ingest(fixture, start());
      await fixture.setSessionLifecycle({ generation: 0, status: "collapsed" });
      await ingest(fixture, append("turn-generation-1", 2, "message-1", "one"));
      await fixture.setSessionLifecycle({ generation: 1, status: "archived" });

      const acknowledgements = await Promise.all([
        ingest(fixture, append("turn-generation-2a", 3, "message-2a", "two-a")),
        ingest(fixture, append("turn-generation-2b", 4, "message-2b", "two-b")),
      ]);
      expect(new Set(acknowledgements.map((ack) => ack.effectiveGeneration))).toEqual(new Set([2]));
      expect((await fixture.inspect()).sessions.map((session) => session.generation)).toEqual([
        0, 1, 2,
      ]);
    });

    it("creates only generation zero for a new source and treats requested generation as a hint", async () => {
      const first = await ingest(fixture, start("start-hint", 1, { requestedGeneration: 42 }));
      expect(first).toMatchObject({ status: "accepted", effectiveGeneration: 0 });

      const recovery = await ingest(
        fixture,
        start("start-recovery", 2, { requestedGeneration: 99 })
      );
      expect(recovery).toMatchObject({ status: "accepted", effectiveGeneration: 0 });
      expect((await fixture.inspect()).sessions.map((session) => session.generation)).toEqual([0]);
    });

    it("keeps an obsolete terminal retryable after its generation is redirected", async () => {
      await ingest(fixture, start());
      await fixture.setSessionLifecycle({ generation: 0, status: "collapsed" });
      await ingest(fixture, append("continued", 2, "continued-message", "continued"));
      const obsoleteEnd = end("obsolete-end", 3, 2, [], 0);

      expect(await ingest(fixture, obsoleteEnd)).toMatchObject({
        status: "rejected",
        retryable: true,
        code: "generation_changed",
      });
      expect(
        (await fixture.inspect()).sessions.find((session) => session.generation === 0)?.status
      ).toBe("collapsed");
    });

    it("records a non-zero grace window for an authoritative close", async () => {
      await ingest(fixture, start());
      const receivedAt = new Date("2026-09-08T12:00:00.000Z");
      await ingest(fixture, end("end-empty", 2, 1, []), provenance, receivedAt);

      expect((await fixture.inspect()).sessions[0]?.closeGraceDeadline?.getTime()).toBeGreaterThan(
        receivedAt.getTime()
      );
    });

    it("does not redirect an obsolete loss marker into another generation", async () => {
      await ingest(fixture, start());
      await fixture.setSessionLifecycle({ generation: 0, status: "collapsed" });
      await ingest(fixture, append("continued", 2, "continued-message", "continued"));
      const obsoleteLoss = event({
        ...SOURCE,
        eventId: "obsolete-loss",
        enqueueSequence: 3,
        type: "sequence.loss",
        sourceGeneration: 0,
        reason: "capacity",
        lostEventType: "turn.retract",
        lostHostMessageId: "continued-message",
        lostRole: "user",
        lostContentHash: sha256Hex("continued"),
      });

      expect(await ingest(fixture, obsoleteLoss)).toMatchObject({
        status: "rejected",
        retryable: true,
        code: "generation_changed",
      });
      expect((await fixture.inspect()).losses).toHaveLength(0);
    });

    it("routes retractions by permanent source identity instead of stale generation", async () => {
      await ingest(fixture, start());
      await fixture.setSessionLifecycle({ generation: 0, status: "collapsed" });
      await ingest(fixture, append("turn-successor", 2, "message-successor", "hello"));
      const retract = event({
        ...SOURCE,
        eventId: "retract-1",
        enqueueSequence: 3,
        type: "turn.retract",
        sourceGeneration: 0,
        hostMessageId: "message-successor",
        reason: "branch_removed",
      });

      expect(await ingest(fixture, retract)).toMatchObject({
        status: "accepted",
        effectiveGeneration: 1,
      });
      expect((await fixture.inspect()).turns[0]?.retracted).toBe(true);
    });

    it("creates a content-free correction generation for a post-terminal retraction", async () => {
      await ingest(fixture, start());
      await ingest(fixture, append("turn-1", 2, "message-1", "sensitive text"));
      await fixture.setSessionLifecycle({ generation: 0, status: "collapsed" });
      const retract = event({
        ...SOURCE,
        eventId: "retract-late",
        enqueueSequence: 3,
        type: "turn.retract",
        sourceGeneration: 0,
        hostMessageId: "message-1",
        reason: "branch_removed",
      });
      expect(await ingest(fixture, retract)).toMatchObject({
        status: "accepted",
        effectiveGeneration: 1,
      });

      const snapshot = await fixture.inspect();
      const correction = snapshot.sessions.find((session) => session.generation === 1)!;
      expect(snapshot.turns.filter((turn) => turn.sessionId === correction.id)).toHaveLength(0);
      expect(snapshot.retractions).toContainEqual(
        expect.objectContaining({
          sessionId: correction.id,
          sourceMessageId: "message-1",
          predecessorSessionId: snapshot.sessions.find((session) => session.generation === 0)?.id,
        })
      );
      expect(snapshot.turns.find((turn) => turn.sourceMessageId === "message-1")?.retracted).toBe(
        false
      );
    });

    it("routes a stale terminal retraction into an existing latest writable generation", async () => {
      await ingest(fixture, start());
      await ingest(fixture, append("turn-old", 2, "message-old", "old"));
      await fixture.setSessionLifecycle({ generation: 0, status: "collapsed" });
      await ingest(fixture, append("turn-current", 3, "message-current", "current"));

      const retract = event({
        ...SOURCE,
        eventId: "retract-old",
        enqueueSequence: 4,
        type: "turn.retract",
        sourceGeneration: 0,
        hostMessageId: "message-old",
        reason: "branch_removed",
      });
      expect(await ingest(fixture, retract)).toMatchObject({
        status: "accepted",
        effectiveGeneration: 1,
      });
      expect((await fixture.inspect()).sessions.map((candidate) => candidate.generation)).toEqual([
        0, 1,
      ]);
    });

    it("atomically retracts an active predecessor named by supersedesSourceMessageId", async () => {
      await ingest(fixture, start());
      await ingest(fixture, append("turn-old", 2, "message-old", "old"));
      await ingest(
        fixture,
        append("turn-new", 3, "message-new", "new", 0, {
          supersedesSourceMessageId: "message-old",
        })
      );

      const turns = (await fixture.inspect()).turns;
      expect(turns.find((turn) => turn.sourceMessageId === "message-old")?.retracted).toBe(true);
      expect(turns.find((turn) => turn.sourceMessageId === "message-new")).toMatchObject({
        retracted: false,
        supersedesSourceMessageId: "message-old",
      });
    });

    it.each(["supersession", "retraction"] as const)(
      "routes an authoritative pending %s after grace into a successor correction",
      async (correctionKind) => {
        await ingest(fixture, start());
        await ingest(fixture, append("turn-old", 2, "message-old", "old"));
        await fixture.setSessionLifecycle({
          generation: 0,
          status: "collapse_pending",
          closeKind: "authoritative",
          closeGraceDeadline: new Date("2026-09-08T11:59:59.999Z"),
          terminalMaxEnqueueSequence: 3,
        });

        const correction =
          correctionKind === "supersession"
            ? append("turn-new", 3, "message-new", "new", 0, {
                supersedesSourceMessageId: "message-old",
              })
            : event({
                ...SOURCE,
                eventId: "retract-old",
                enqueueSequence: 3,
                type: "turn.retract",
                sourceGeneration: 0,
                hostMessageId: "message-old",
                reason: "branch_removed",
              });

        expect(await ingest(fixture, correction)).toMatchObject({
          status: "accepted",
          effectiveGeneration: 1,
        });
        const snapshot = await fixture.inspect();
        const predecessor = snapshot.sessions.find((candidate) => candidate.generation === 0)!;
        const successor = snapshot.sessions.find((candidate) => candidate.generation === 1)!;
        expect(
          snapshot.turns.find((turn) => turn.sourceMessageId === "message-old")?.retracted
        ).toBe(false);
        expect(snapshot.retractions).toContainEqual(
          expect.objectContaining({
            sessionId: successor.id,
            sourceMessageId: "message-old",
            predecessorSessionId: predecessor.id,
          })
        );
      }
    );

    it.each(["supersession", "retraction"] as const)(
      "applies an authoritative pending %s at the inclusive grace and watermark boundary",
      async (correctionKind) => {
        await ingest(fixture, start());
        await ingest(fixture, append("turn-old", 2, "message-old", "old"));
        await fixture.setSessionLifecycle({
          generation: 0,
          status: "collapse_pending",
          closeKind: "authoritative",
          closeGraceDeadline: new Date("2026-09-08T12:00:00.000Z"),
          terminalMaxEnqueueSequence: 3,
        });

        const correction =
          correctionKind === "supersession"
            ? append("turn-new", 3, "message-new", "new", 0, {
                supersedesSourceMessageId: "message-old",
              })
            : event({
                ...SOURCE,
                eventId: "retract-old",
                enqueueSequence: 3,
                type: "turn.retract",
                sourceGeneration: 0,
                hostMessageId: "message-old",
                reason: "branch_removed",
              });

        expect(await ingest(fixture, correction)).toMatchObject({
          status: "accepted",
          effectiveGeneration: 0,
        });
        const snapshot = await fixture.inspect();
        expect(snapshot.sessions).toHaveLength(1);
        expect(
          snapshot.turns.find((turn) => turn.sourceMessageId === "message-old")?.retracted
        ).toBe(true);
        expect(snapshot.retractions[0]?.predecessorSessionId).toBeNull();
      }
    );

    it("converges concurrent corrections outside an authoritative watermark on one successor", async () => {
      await ingest(fixture, start());
      await ingest(fixture, append("turn-old-a", 2, "message-old-a", "old-a"));
      await ingest(fixture, append("turn-old-b", 3, "message-old-b", "old-b"));
      await fixture.setSessionLifecycle({
        generation: 0,
        status: "collapse_pending",
        closeKind: "authoritative",
        closeGraceDeadline: new Date("2026-09-08T12:01:00.000Z"),
        terminalMaxEnqueueSequence: 3,
      });

      const acknowledgements = await Promise.all([
        ingest(
          fixture,
          append("turn-new-a", 4, "message-new-a", "new-a", 0, {
            supersedesSourceMessageId: "message-old-a",
          })
        ),
        ingest(
          fixture,
          event({
            ...SOURCE,
            eventId: "retract-old-b",
            enqueueSequence: 5,
            type: "turn.retract",
            sourceGeneration: 0,
            hostMessageId: "message-old-b",
            reason: "branch_removed",
          })
        ),
      ]);

      expect(new Set(acknowledgements.map((ack) => ack.effectiveGeneration))).toEqual(new Set([1]));
      const snapshot = await fixture.inspect();
      expect(snapshot.sessions.map((candidate) => candidate.generation)).toEqual([0, 1]);
      expect(
        snapshot.turns
          .filter((turn) => ["message-old-a", "message-old-b"].includes(turn.sourceMessageId))
          .every((turn) => !turn.retracted)
      ).toBe(true);
      expect(snapshot.retractions.every((row) => row.predecessorSessionId !== null)).toBe(true);
    });

    it.each(["supersession", "retraction"] as const)(
      "keeps an unleased provisional pending %s in its current generation",
      async (correctionKind) => {
        await ingest(fixture, start());
        await ingest(fixture, append("turn-old", 2, "message-old", "old"));
        await fixture.setSessionLifecycle({
          generation: 0,
          status: "collapse_pending",
          closeKind: "provisional",
          closeGraceDeadline: new Date("2026-09-08T12:01:00.000Z"),
          terminalMaxEnqueueSequence: 3,
          terminalMessageSetDigest: sha256Hex("stale-provisional-barrier"),
        });

        const correction =
          correctionKind === "supersession"
            ? append("turn-new", 3, "message-new", "new", 0, {
                supersedesSourceMessageId: "message-old",
              })
            : event({
                ...SOURCE,
                eventId: "retract-old",
                enqueueSequence: 3,
                type: "turn.retract",
                sourceGeneration: 0,
                hostMessageId: "message-old",
                reason: "branch_removed",
              });

        expect(await ingest(fixture, correction)).toMatchObject({
          status: "accepted",
          effectiveGeneration: 0,
        });
        const snapshot = await fixture.inspect();
        expect(snapshot.sessions).toHaveLength(1);
        expect(snapshot.sessions[0]).toMatchObject(
          correctionKind === "supersession"
            ? {
                status: "active",
                closeKind: null,
                closeGraceDeadline: null,
                terminalMaxEnqueueSequence: null,
                terminalMessageSetDigest: null,
              }
            : {
                status: "collapse_pending",
                closeKind: "provisional",
                closeGraceDeadline: new Date("2026-09-08T12:01:00.000Z"),
                terminalMaxEnqueueSequence: 3,
                terminalMessageSetDigest: sha256Hex("stale-provisional-barrier"),
              }
        );
        expect(await fixture.getSessionStatus(snapshot.sessions[0]!.id)).toBe(
          correctionKind === "supersession" ? "active" : "collapse_pending"
        );
        expect(
          snapshot.turns.find((turn) => turn.sourceMessageId === "message-old")?.retracted
        ).toBe(true);
        expect(snapshot.retractions[0]?.predecessorSessionId).toBeNull();
      }
    );

    it.each([
      { status: "collapsed" as const, leased: false },
      { status: "collapse_pending" as const, leased: true },
    ])("records correction behavior when superseding a $status predecessor", async (lifecycle) => {
      await ingest(fixture, start());
      await ingest(fixture, append("turn-old", 2, "message-old", "old"));
      await fixture.setSessionLifecycle({ generation: 0, ...lifecycle });

      expect(
        await ingest(
          fixture,
          append("turn-new", 3, "message-new", "new", 0, {
            supersedesSourceMessageId: "message-old",
          })
        )
      ).toMatchObject({ status: "accepted", effectiveGeneration: 1 });
      const snapshot = await fixture.inspect();
      expect(snapshot.turns.find((turn) => turn.sourceMessageId === "message-old")?.retracted).toBe(
        false
      );
      expect(snapshot.retractions).toContainEqual(
        expect.objectContaining({
          sourceMessageId: "message-old",
          predecessorSessionId: snapshot.sessions.find((session) => session.generation === 0)?.id,
        })
      );
    });

    it("rejects an invalid supersedes identity without consuming its source sequence", async () => {
      await ingest(fixture, start());
      expect(
        await ingest(
          fixture,
          append("invalid-supersedes", 2, "message-new", "new", 0, {
            supersedesSourceMessageId: "missing-message",
          })
        )
      ).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "missing_superseded_source_message",
      });
      expect((await fixture.inspect()).ledger.map((row) => row.eventId)).not.toContain(
        "invalid-supersedes"
      );
      expect(
        await ingest(fixture, append("replacement", 2, "message-valid", "valid"))
      ).toMatchObject({ status: "accepted" });
    });

    it("compares role as well as content hash for an existing source identity", async () => {
      await ingest(fixture, start());
      await ingest(fixture, append("turn-user", 2, "message-1", "same"));

      expect(
        await ingest(
          fixture,
          append("turn-assistant", 3, "message-1", "same", 0, { role: "assistant" })
        )
      ).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "source_message_identity_mismatch",
      });
      expect((await fixture.inspect()).ledger.map((row) => row.eventId)).not.toContain(
        "turn-assistant"
      );
    });

    it("finalizes a retryable replay that later discovers a source identity conflict", async () => {
      const pending = append("pending-conflict", 2, "message-conflict", "original");
      await ingest(fixture, pending);
      await ingest(fixture, start());
      await fixture.seedManagedTurn({
        generation: 0,
        sourceMessageId: "message-conflict",
        role: "assistant",
        content: "other",
        contentHash: sha256Hex("other"),
      });

      expect(await ingest(fixture, pending)).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "source_message_identity_mismatch",
      });
      expect(
        (await fixture.inspect()).ledger.find((row) => row.eventId === "pending-conflict")?.state
      ).toBe("rejected");
      expect(
        await ingest(fixture, append("sequence-owner", 2, "other-message", "other"))
      ).toMatchObject({ status: "rejected", retryable: false, code: "source_sequence_conflict" });
    });

    it("accepts stale provenance timestamps but uses monotonic server receipt time for activity", async () => {
      await ingest(fixture, start(), provenance, new Date("2026-09-08T12:00:00.000Z"));
      await ingest(
        fixture,
        append("turn-1", 2, "message-1", "hello", 0, {
          occurredAt: "1990-01-01T00:00:00.000Z",
        }),
        provenance,
        new Date("2026-09-08T11:00:00.000Z")
      );
      expect((await fixture.inspect()).sessions[0]?.lastActivityAt?.toISOString()).toBe(
        "2026-09-08T12:00:00.000Z"
      );
    });

    it("rejects timestamps more than 24 hours ahead before writing", async () => {
      const future = start("future", 1, { occurredAt: "2026-09-09T12:00:00.001Z" });
      expect(await ingest(fixture, future)).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "future_timestamp",
      });
      expect(await fixture.inspect()).toMatchObject({ sessions: [], ledger: [] });
    });

    it("applies sensitivity defaults and numeric ceilings without silently lowering", async () => {
      expect(await ingest(fixture, start())).toMatchObject({ status: "accepted" });
      expect((await fixture.inspect()).sessions[0]?.sensitivity).toBe("internal");

      const publicClient = { ...SOURCE, clientInstanceId: "client-public" };
      expect(
        await ingest(fixture, start("public-default", 1, publicClient), PUBLIC_PROVENANCE)
      ).toMatchObject({
        status: "rejected",
        retryable: false,
        code: "sensitivity_ceiling_exceeded",
      });
      expect(
        await ingest(
          fixture,
          start("public-explicit", 2, { ...publicClient, sensitivity: "public" }),
          PUBLIC_PROVENANCE
        )
      ).toMatchObject({ status: "accepted" });
    });
  });
}
