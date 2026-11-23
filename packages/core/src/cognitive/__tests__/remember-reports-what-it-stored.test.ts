/**
 * P121 — `remember()` reports what it STORED, not what it was asked to store.
 *
 * The two are not the same, on purpose: the CORE-1 gate redacts PII before
 * embedding and before insert, so a statement carrying a phone number is
 * written with `[REDACTED-phone]` in its place. That part is correct and stays.
 *
 * What was wrong is that nobody was told. `POST /remember` rebuilt its response
 * from the REQUEST — `statement: effectiveStatement`, the caller's own input —
 * so the write appeared to confirm text that the database never held. The row
 * recorded the redaction in `metadata.pii` the whole time; the signal existed
 * and simply never left the database.
 *
 * The consequence is worse for an agent than for a person. A person writes a
 * phone number, sees a redaction, and understands. An agent writes a fact,
 * recalls it two turns later, gets DIFFERENT TEXT than it wrote, and has no
 * evidence that a transformation happened — the only available conclusion is
 * that the memory is unreliable. And the original is kept nowhere, so nothing
 * can reconcile the two afterwards.
 */
import { describe, it, expect, vi } from "vitest";

import { remember } from "../remember.js";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { CoreContext } from "../../types.js";

function makeCtx(): CoreContext {
  const storage = new InMemoryStorageAdapter();
  return {
    storage,
    embed: {
      id: "test-embedder",
      model: "test-model",
      dimensions: 1536,
      semantic: false,
      embedSingle: async () => new Float32Array(1536).fill(0.01),
      embedBatch: async (xs: string[]) => xs.map(() => new Float32Array(1536).fill(0.01)),
    },
    vector: {
      search: async () => [],
      upsert: async () => undefined,
      remove: async () => undefined,
    },
    cache: undefined,
    llm: undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    telemetry: {
      startSpan: () => ({ end: vi.fn(), setAttribute: vi.fn(), recordException: vi.fn() }),
    },
    config: { surpriseThreshold: 0.15 },
  } as unknown as CoreContext;
}

const AUTH = { workspaceId: "ws_1", actorId: "key:k1", actorType: "agent", userId: null } as never;

async function write(content: string) {
  return remember(
    makeCtx(),
    { workspaceId: "ws_1", kind: "fact", subject: "workspace", content } as never,
    AUTH
  );
}

describe("P121 — the write reports the text it actually wrote", () => {
  it("returns the REDACTED text, not the caller's input", async () => {
    const res = await write("llamame al +54 911 2345 6789");

    expect(res.storedContent).toBe("llamame al [REDACTED-phone]");
    // The assertion that would have caught the original bug on its own: the
    // response must not repeat what was sent when what was kept differs.
    expect(res.storedContent).not.toContain("2345");
  });

  it("names the categories it redacted, so the caller can say WHY the text changed", async () => {
    const res = await write("llamame al +54 911 2345 6789");

    expect(res.redactedCategories).toEqual(["phone"]);
  });

  it("omits redactedCategories entirely when nothing was redacted", async () => {
    // Presence IS the signal. An always-present empty array would make every
    // caller check `.length`, and most would forget — the field would be
    // technically available and practically ignored.
    const res = await write("procesamos 1786644306016 filas");

    expect(res.storedContent).toBe("procesamos 1786644306016 filas");
    expect("redactedCategories" in res).toBe(false);
  });

  it("storedContent equals the input when nothing was redacted", async () => {
    // The boring half, and it needs pinning too: a caller must be able to use
    // `storedContent` unconditionally rather than branching on whether a
    // redaction happened.
    const text = "el cache corre sobre valkey desde septiembre";
    const res = await write(text);

    expect(res.storedContent).toBe(text);
  });

  it("reports every category when more than one kind of PII is present", async () => {
    const res = await write("escribime a ana@example.com o llamame al 415-555-0132");

    expect(res.storedContent).not.toContain("ana@example.com");
    expect(res.storedContent).not.toContain("415-555-0132");
    expect(res.redactedCategories).toEqual(expect.arrayContaining(["email", "phone"]));
  });

  it("what it reports is what the row holds", async () => {
    // The claim that matters end to end. Reporting a redacted string that
    // differs from the stored one would be a new lie in place of the old one.
    const ctx = makeCtx();
    const res = await remember(
      ctx,
      {
        workspaceId: "ws_1",
        kind: "fact",
        subject: "workspace",
        content: "mi cel es 415-555-0132",
      } as never,
      AUTH
    );

    const row = await ctx.storage.getFact(res.id, "ws_1");
    expect(row?.statement).toBe(res.storedContent);
  });
});

describe("P122 — the row's own values, not values invented at response time", () => {
  it("reports the row's timestamps, pinned, confidence and sensitivity", async () => {
    const ctx = makeCtx();
    const res = await remember(
      ctx,
      {
        workspaceId: "ws_1",
        kind: "fact",
        subject: "workspace",
        content: "el cache corre sobre valkey",
      } as never,
      AUTH
    );

    const row = await ctx.storage.getFact(res.id, "ws_1");
    expect(row).toBeTruthy();
    expect(res.stored).toBeDefined();

    // Compared against the ROW, not against a literal. A test asserting fixed
    // values would pass just as happily against a response that invents them
    // consistently — which is precisely the bug.
    expect(res.stored!.validFrom).toBe(row!.validFrom.toISOString());
    expect(res.stored!.createdAt).toBe(row!.createdAt.toISOString());
    expect(res.stored!.pinned).toBe(row!.pinned);
    expect(res.stored!.confidence).toBe(row!.confidence);
    expect(res.stored!.sensitivity).toBe(row!.sensitivity);
  });

  it("reports an OPEN interval as null, not as absent", async () => {
    const res = await write("un hecho recien escrito");

    expect(res.stored!.validTo).toBeNull();
  });

  it("carries the caller's sensitivity through instead of the default", async () => {
    // The hardcoded `DEFAULT_SENSITIVITY` in the route was the loudest of the
    // five: a caller writing something confidential was told it was internal.
    const ctx = makeCtx();
    const res = await remember(
      ctx,
      {
        workspaceId: "ws_1",
        kind: "fact",
        subject: "workspace",
        content: "algo delicado",
        sensitivity: "confidential",
      } as never,
      AUTH
    );

    const row = await ctx.storage.getFact(res.id, "ws_1");
    expect(res.stored!.sensitivity).toBe("confidential");
    expect(res.stored!.sensitivity).toBe(row!.sensitivity);
  });
});
