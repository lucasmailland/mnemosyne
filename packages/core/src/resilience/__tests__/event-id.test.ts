import { describe, it, expect } from "vitest";
import { EventIdGenerator, parseEventId, wsBufferKey } from "../event-id.js";

describe("§35 monotonic event ids evt_{wsShort}_{ts}_{seq}", () => {
  it("formats evt_{wsShort}_{ts}_{seq} with zero-padded seq", () => {
    const g = new EventIdGenerator(() => 1_717_500_000_000);
    expect(g.next("ws_12abcdef")).toMatch(/^evt_ws12abcd_1717500000000_0000$/);
  });
  it("increments seq within the same ms, resets across ms", () => {
    let t = 1000;
    const g = new EventIdGenerator(() => t);
    expect(parseEventId(g.next("wsX")).seq).toBe(0);
    expect(parseEventId(g.next("wsX")).seq).toBe(1);
    t = 1001;
    expect(parseEventId(g.next("wsX")).seq).toBe(0);
  });
  it("seq is per-workspace, independent", () => {
    const g = new EventIdGenerator(() => 5);
    g.next("a");
    expect(parseEventId(g.next("b")).seq).toBe(0);
    expect(parseEventId(g.next("a")).seq).toBe(1);
  });
  it("ids sort lexically in monotonic order within a workspace", () => {
    let t = 100;
    const g = new EventIdGenerator(() => t);
    const ids = [g.next("w"), g.next("w"), g.next("w")];
    t = 101;
    ids.push(g.next("w"));
    expect([...ids].sort()).toEqual(ids);
  });
  it("wsBufferKey builds the per-workspace Redis list key", () => {
    expect(wsBufferKey("ws1")).toBe("mnemo:ws1:ws_buffer");
  });
});
