import { describe, it, expect } from "vitest";
import {
  resolveDecision, dedupDecision, lifecycleTransition,
  RESOLVE_COSINE, DEDUP_COSINE,
  type ReasoningCandidate,
} from "../reasoning.js";

function cand(over: Partial<ReasoningCandidate> = {}): ReasoningCandidate {
  return { id: "r1", cosine: 0.9, worth: 0.8, successCount: 9, failureCount: 1, status: "active", ...over };
}

describe("resolveDecision (spec §8c gate: cosine≥0.88 ∧ worth>0.5 ∧ confidence>0.3)", () => {
  it("HITS on a strong, well-evidenced, similar candidate", () => {
    const d = resolveDecision([cand()]);
    expect(d.action).toBe("hit");
    expect(d.reasoningId).toBe("r1");
    expect(d.suggestedModel).toBe("haiku");
  });
  it("MISSES when cosine below 0.88", () => {
    expect(resolveDecision([cand({ cosine: 0.87 })]).action).toBe("execute");
  });
  it("MISSES when worth <= 0.5", () => {
    expect(resolveDecision([cand({ worth: 0.5, successCount: 1, failureCount: 1 })]).action).toBe("execute");
  });
  it("MISSES a low-evidence chain whose Wilson confidence < 0.3", () => {
    expect(resolveDecision([cand({ worth: 0.6, successCount: 1, failureCount: 0 })]).action).toBe("execute");
  });
  it("NEVER hits a quarantined candidate", () => {
    expect(resolveDecision([cand({ status: "quarantined" })]).action).toBe("execute");
  });
  it("returns up to 3 similar_attempts on a miss", () => {
    const d = resolveDecision([cand({ cosine: 0.5 }), cand({ id: "r2", cosine: 0.4 })]);
    expect(d.action).toBe("execute");
    expect(d.similarAttempts.length).toBe(2);
  });
  it("RESOLVE_COSINE is 0.88", () => expect(RESOLVE_COSINE).toBe(0.88));
});

describe("dedupDecision (spec §8 RECORD step b — upsert at cosine≥0.95)", () => {
  it("UPSERTS when top match >= 0.95", () => {
    const d = dedupDecision([cand({ cosine: 0.96 })]);
    expect(d.action).toBe("upsert");
    expect(d.reasoningId).toBe("r1");
  });
  it("INSERTS when top match < 0.95", () => {
    expect(dedupDecision([cand({ cosine: 0.94 })]).action).toBe("insert");
  });
  it("INSERTS on empty candidate set", () => {
    expect(dedupDecision([]).action).toBe("insert");
  });
  it("DEDUP_COSINE is 0.95", () => expect(DEDUP_COSINE).toBe(0.95));
});

describe("lifecycleTransition (spec §8 FEEDBACK — quarantine/golden)", () => {
  it("quarantines when worth < 0.3", () => {
    expect(lifecycleTransition({ worth: 0.2, usageCount: 5, status: "active" })).toBe("quarantined");
  });
  it("promotes to golden when worth > 0.8 and usage >= 50", () => {
    expect(lifecycleTransition({ worth: 0.9, usageCount: 50, status: "active" })).toBe("golden");
  });
  it("does not promote to golden before 50 uses", () => {
    expect(lifecycleTransition({ worth: 0.9, usageCount: 49, status: "active" })).toBeNull();
  });
  it("keeps a healthy mid-range chain unchanged (returns null)", () => {
    expect(lifecycleTransition({ worth: 0.6, usageCount: 10, status: "active" })).toBeNull();
  });
  it("can recover a quarantined chain to active when worth climbs back over 0.3", () => {
    expect(lifecycleTransition({ worth: 0.5, usageCount: 10, status: "quarantined" })).toBe("active");
  });
});
