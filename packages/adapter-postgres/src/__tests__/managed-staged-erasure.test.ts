import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ManagedSessionRepository } from "../repositories/ManagedSessionRepository.js";

describe("managed transcript erasure with only staged fragments", () => {
  it.each(["retention", "forget"])(
    "includes fragments in %s and leaves content-free identity",
    async (mode) => {
      const workspaceId = "11111111-1111-4111-8111-111111111111";
      let fragments = [
        {
          id: "22222222-2222-4222-8222-222222222222",
          session_id: "session",
          source_message_id: "message",
          content_hash: "message-hash",
          source_host: "claude-code",
          source_client_instance_id: "client",
          source_session_id: "host-session",
          source_generation: 0,
          event_id: "fragment-event",
          payload_hash: "payload-hash",
          acknowledgement: {
            eventId: "fragment-event",
            status: "accepted",
            effectiveGeneration: 0,
          },
        },
      ];
      const tombstones: unknown[][] = [];
      const audits: unknown[][] = [];
      const dialect = new PgDialect();
      const execute = vi.fn(async (query: SQL) => {
        const { sql, params } = dialect.sqlToQuery(query);
        if (sql.includes("pg_has_role")) return [{ m: true }];
        if (sql.includes("SELECT source_conversation_id"))
          return [{ source_conversation_id: "session" }];
        if (sql.includes("FROM mnemosyne.mnemo_harness_message_chunk AS chunk"))
          return [...fragments];
        if (sql.includes("INSERT INTO mnemosyne.mnemo_harness_message_tombstone"))
          tombstones.push(params);
        if (sql.includes("INSERT INTO mnemosyne.mnemo_deletion_log")) audits.push(params);
        if (sql.includes("DELETE FROM mnemosyne.mnemo_harness_message_chunk")) {
          const removed = fragments;
          fragments = [];
          return removed;
        }
        return [];
      });
      const repository = new ManagedSessionRepository(
        {
          transaction: (operation: (tx: { execute: typeof execute }) => unknown) =>
            operation({ execute }),
        } as never,
        { listManagedCollapseTurns: vi.fn() }
      );
      const erase = async () =>
        mode === "retention"
          ? repository.purgeManagedTurns({
              workspaceId,
              terminalBefore: new Date("2026-06-01"),
              limit: 1,
            })
          : (
              await repository.forgetManagedTranscriptForEpisode({
                workspaceId,
                episodeId: "episode",
                actorId: "user:eraser",
              })
            ).turnsRemoved;

      expect(await erase()).toBe(1);
      expect(fragments).toEqual([]);
      expect(tombstones).toHaveLength(1);
      expect(tombstones[0]).toEqual(
        expect.arrayContaining([workspaceId, "message", "fragment-event", "message-hash"])
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toContain("harness_message_chunk");
      expect(await erase()).toBe(0);
    }
  );
});
