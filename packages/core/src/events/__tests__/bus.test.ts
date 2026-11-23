import { describe, it, expect, vi } from "vitest";
import { createEventBus, channelMatches } from "../bus.js";
import type { MnemoBusEvent } from "@mnemo-ai/types";

function makeEvent(channel: string, type: MnemoBusEvent["type"] = "fact.created"): MnemoBusEvent {
  return {
    channel,
    type,
    payload: { test: true },
    timestamp: new Date().toISOString(), // determinism-ok: throwaway fixture date, not asserted
    traceId: "trace-test",
  };
}

describe("channelMatches", () => {
  it("matches exact channel", () => {
    expect(channelMatches("fact.created", "fact.created")).toBe(true);
    expect(channelMatches("fact.created", "fact.updated")).toBe(false);
  });

  it("facts.* glob matches any fact.* event", () => {
    expect(channelMatches("facts.*", "fact.created")).toBe(true);
    expect(channelMatches("facts.*", "fact.updated")).toBe(true);
    expect(channelMatches("facts.*", "fact.archived")).toBe(true);
  });

  it("tasks.* does NOT match a fact event", () => {
    expect(channelMatches("tasks.*", "fact.created")).toBe(false);
    expect(channelMatches("tasks.*", "task.created")).toBe(true);
  });

  it("session.abc matches session.abc but not session.xyz", () => {
    expect(channelMatches("session.abc", "session.abc")).toBe(true);
    expect(channelMatches("session.abc", "session.xyz")).toBe(false);
  });

  it("* match-all receives every channel", () => {
    expect(channelMatches("*", "fact.created")).toBe(true);
    expect(channelMatches("*", "task.completed")).toBe(true);
    expect(channelMatches("*", "session.abc123")).toBe(true);
    expect(channelMatches("*", "health")).toBe(true);
  });
});

describe("createEventBus", () => {
  it("exact channel match — listener receives the event", () => {
    const bus = createEventBus();
    const listener = vi.fn();
    bus.subscribe("fact.created", listener);
    const event = makeEvent("fact.created");
    bus.emit(event);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });

  it("facts.* glob — listener receives any fact.* event", () => {
    const bus = createEventBus();
    const listener = vi.fn();
    bus.subscribe("facts.*", listener);
    bus.emit(makeEvent("fact.created"));
    bus.emit(makeEvent("fact.updated", "fact.updated"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("tasks.* does NOT receive a fact event", () => {
    const bus = createEventBus();
    const taskListener = vi.fn();
    const factListener = vi.fn();
    bus.subscribe("tasks.*", taskListener);
    bus.subscribe("facts.*", factListener);
    bus.emit(makeEvent("fact.created"));
    expect(taskListener).not.toHaveBeenCalled();
    expect(factListener).toHaveBeenCalledOnce();
  });

  it("* match-all receives every event", () => {
    const bus = createEventBus();
    const listener = vi.fn();
    bus.subscribe("*", listener);
    bus.emit(makeEvent("fact.created"));
    bus.emit(makeEvent("task.created", "task.created"));
    bus.emit(makeEvent("session.xyz", "session.collapsed"));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("unsubscribe stops delivery", () => {
    const bus = createEventBus();
    const listener = vi.fn();
    const unsub = bus.subscribe("fact.created", listener);
    bus.emit(makeEvent("fact.created"));
    expect(listener).toHaveBeenCalledOnce();
    unsub();
    bus.emit(makeEvent("fact.created"));
    expect(listener).toHaveBeenCalledOnce(); // still only 1
  });

  it("throwing subscriber does not break other subscribers", () => {
    const bus = createEventBus();
    const thrower = vi.fn(() => { throw new Error("boom"); });
    const safe = vi.fn();
    bus.subscribe("fact.created", thrower);
    bus.subscribe("fact.created", safe);
    expect(() => bus.emit(makeEvent("fact.created"))).not.toThrow();
    expect(thrower).toHaveBeenCalledOnce();
    expect(safe).toHaveBeenCalledOnce();
  });

  it("facts.* and fact.created both fire on a fact.created emit", () => {
    const bus = createEventBus();
    const globListener = vi.fn();
    const exactListener = vi.fn();
    bus.subscribe("facts.*", globListener);
    bus.subscribe("fact.created", exactListener);
    bus.emit(makeEvent("fact.created"));
    expect(globListener).toHaveBeenCalledOnce();
    expect(exactListener).toHaveBeenCalledOnce();
  });
});
