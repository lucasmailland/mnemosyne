import { describe, it, expect } from "vitest";
import { DEFAULT_SELF_EDIT_POLICY, evaluateSelfEdit, parseTarget } from "../self-edit.js";

describe("parseTarget (spec §13 polymorphic target)", () => {
  it("parses a profile target", () => {
    expect(parseTarget("profile")).toEqual({ kind: "profile" });
  });
  it("parses a strategy target", () => {
    expect(parseTarget("strategy:abc")).toEqual({ kind: "strategy", id: "abc" });
  });
  it("treats anything else as a fact id", () => {
    expect(parseTarget("fact-123")).toEqual({ kind: "fact", id: "fact-123" });
  });
});

describe("evaluateSelfEdit (spec §13 SelfEditPolicy)", () => {
  const p = DEFAULT_SELF_EDIT_POLICY;

  it("allows a normal strengthen within limits", () => {
    expect(evaluateSelfEdit({ action: "strengthen", target: "fact-1", editsThisSession: 0, deletesToday: 0, reason: "useful" }, p).allow).toBe(true);
  });

  it("blocks once maxEditsPerSession is reached", () => {
    const r = evaluateSelfEdit({ action: "append", target: "fact-1", editsThisSession: 5, deletesToday: 0, reason: "test reason" }, p);
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/maxEditsPerSession/);
  });

  it("APP-062: a cooldown refusal carries the real remaining seconds", () => {
    const now = 1_000_000_000;
    const r = evaluateSelfEdit({ action: "strengthen", target: "fact-1", editsThisSession: 0, deletesToday: 0, reason: "again", lastEditAt: now - 40_000, now }, p);
    expect(r.allow).toBe(false);
    expect(r.retryAfterSeconds).toBe(260);
    expect(r.reason).toMatch(/260s remaining/);
  });

  it("forget counts against maxDeletesPerDay", () => {
    const r = evaluateSelfEdit({ action: "forget", target: "fact-1", editsThisSession: 0, deletesToday: 3, reason: "test reason" }, p);
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/maxDeletesPerDay/);
  });

  it("blocks editing a strategy if own_strategies not allowed", () => {
    const restricted = { ...p, allowEdit: ["own_facts"] as const };
    expect(evaluateSelfEdit({ action: "replace", target: "strategy:s1", editsThisSession: 0, deletesToday: 0, reason: "test reason" }, restricted as any).allow).toBe(false);
  });

  it("reflect is always allowed and does not consume the edit budget", () => {
    expect(evaluateSelfEdit({ action: "reflect", target: "profile", editsThisSession: 5, deletesToday: 3 }, p).allow).toBe(true);
  });

  it("defaults match spec §13", () => {
    expect(p.maxEditsPerSession).toBe(5);
    expect(p.maxDeletesPerDay).toBe(3);
    expect(p.requireReason).toBe(true);
    expect(p.editGracePeriod).toBe(300);
  });

  it("blocks when requireReason is true and reason is missing", () => {
    const r = evaluateSelfEdit({ action: "strengthen", target: "fact-1", editsThisSession: 0, deletesToday: 0 }, p);
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/requireReason/);
  });

  it("allows when requireReason is true and reason is provided", () => {
    const r = evaluateSelfEdit({ action: "strengthen", target: "fact-1", editsThisSession: 0, deletesToday: 0, reason: "it was useful" }, p);
    expect(r.allow).toBe(true);
  });
});

describe("RDD-8 anti-gaming caps", () => {
  it("DEFAULT_SELF_EDIT_POLICY.maxStrengthensPerDay === 3", () => {
    expect(DEFAULT_SELF_EDIT_POLICY.maxStrengthensPerDay).toBe(3);
  });

  it("DEFAULT_SELF_EDIT_POLICY.maxWeakensPerDay === 5", () => {
    expect(DEFAULT_SELF_EDIT_POLICY.maxWeakensPerDay).toBe(5);
  });

  it("blocks 4th strengthen/day", () => {
    const result = evaluateSelfEdit(
      { action: "strengthen", target: "fact-1", editsThisSession: 0, deletesToday: 0, strengthensToday: 3, reason: "test" },
      DEFAULT_SELF_EDIT_POLICY
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/maxStrengthensPerDay/);
  });

  it("blocks 6th weaken/day", () => {
    const result = evaluateSelfEdit(
      { action: "weaken", target: "fact-1", editsThisSession: 0, deletesToday: 0, weakensToday: 5, reason: "test" },
      DEFAULT_SELF_EDIT_POLICY
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/maxWeakensPerDay/);
  });

  it("blocks 2nd strengthen of the same fact same day", () => {
    const result = evaluateSelfEdit(
      { action: "strengthen", target: "fact-1", editsThisSession: 0, deletesToday: 0, strengthensToday: 1, strengthensTodayForTarget: 1, reason: "test" },
      DEFAULT_SELF_EDIT_POLICY
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/max 1 strengthen per fact per day/);
  });

  it("allows first strengthen of a fact today", () => {
    const result = evaluateSelfEdit(
      { action: "strengthen", target: "fact-1", editsThisSession: 0, deletesToday: 0, strengthensToday: 0, strengthensTodayForTarget: 0, reason: "test" },
      DEFAULT_SELF_EDIT_POLICY
    );
    expect(result.allow).toBe(true);
  });
});
