/**
 * RSN-1 — A/B session measurement + procedural transition tests.
 * spec §14 — verifies decideProceduralTransition uses computeCandidateAbScore
 * to make real data-driven decisions rather than relying on stored avgScoreAfter.
 */
import { describe, it, expect, vi } from "vitest";
import { decideProceduralTransition, MIN_SAMPLE_SESSIONS } from "../procedural.js";
import type { StorageAdapter } from "@mnemo-ai/types";

// Minimal scored trajectory shape matching the port contract
type ScoredTraj = {
  sessionId: string;
  score: number;
  promptVersionId: string | null;
  createdAt: Date;
};

function makeStorage(opts: {
  candidateId: string | null;
  candidateStatus?: "candidate" | "testing" | "active" | "rolled_back";
  avgScoreBefore?: number;
  trajectories?: ScoredTraj[];
  computeScoreResult?: number | null;
  hasComputeCandidateAbScore?: boolean;
  hasTransitionPromptVersion?: boolean;
}) {
  const {
    candidateId,
    candidateStatus = "candidate",
    avgScoreBefore = 0,
    trajectories = [],
    computeScoreResult = null,
    hasComputeCandidateAbScore = true,
    hasTransitionPromptVersion = true,
  } = opts;

  const transitionPromptVersion = vi.fn(async () => {});

  const storage = {
    getActivePromptVersion: vi.fn(async () => {
      if (!candidateId) return null;
      return {
        id: candidateId,
        status: candidateStatus,
        trajectoriesUsed: trajectories.length,
        avgScoreBefore: avgScoreBefore,
        avgScoreAfter: null,
      };
    }),
    listScoredTrajectories: vi.fn(async () => trajectories),
    ...(hasComputeCandidateAbScore
      ? { computeCandidateAbScore: vi.fn(async () => computeScoreResult) }
      : {}),
    ...(hasTransitionPromptVersion
      ? { transitionPromptVersion }
      : {}),
  } as unknown as StorageAdapter;

  return { storage, transitionPromptVersion };
}

describe("decideProceduralTransition — RSN-1 A/B gate", () => {
  it("activates when candidate beats champion by > 5%", async () => {
    // Use MIN_SAMPLE_SESSIONS (10) trajectories to pass the sample gate
    const trajectories: ScoredTraj[] = Array.from({ length: 10 }, (_, i) => ({
      sessionId: `s${i}`,
      score: 0.7,
      promptVersionId: "v-candidate",
      createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    }));

    const { storage, transitionPromptVersion } = makeStorage({
      candidateId: "v-candidate",
      candidateStatus: "candidate",
      avgScoreBefore: 0.6,
      trajectories,
      computeScoreResult: 0.7,
    });

    const result = await decideProceduralTransition(storage, "ws1", "a1");
    expect(result.action).toBe("activated");
    expect(transitionPromptVersion).toHaveBeenCalledWith("ws1", "v-candidate", "active", 0.7);
  });

  it("rolls back when improvement is below 5% threshold", async () => {
    // Use MIN_SAMPLE_SESSIONS (10) trajectories to pass the sample gate
    const trajectories: ScoredTraj[] = Array.from({ length: 10 }, (_, i) => ({
      sessionId: `s${i}`,
      score: 0.63,
      promptVersionId: "v-candidate",
      createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    }));

    const { storage, transitionPromptVersion } = makeStorage({
      candidateId: "v-candidate",
      candidateStatus: "candidate",
      avgScoreBefore: 0.6,
      trajectories,
      computeScoreResult: 0.63,
    });

    const result = await decideProceduralTransition(storage, "ws1", "a1");
    expect(result.action).toBe("rolled_back");
    expect(transitionPromptVersion).toHaveBeenCalledWith("ws1", "v-candidate", "rolled_back", 0.63);
  });

  it("returns noop when there is no candidate version", async () => {
    const { storage, transitionPromptVersion } = makeStorage({ candidateId: null });

    const result = await decideProceduralTransition(storage, "ws1", "a1");
    expect(result.action).toBe("noop");
    expect(result.reason).toBe("no_candidate_version");
    expect(transitionPromptVersion).not.toHaveBeenCalled();
  });

  it("returns noop when candidate has no scored trajectories yet", async () => {
    const { storage, transitionPromptVersion } = makeStorage({
      candidateId: "v-candidate",
      candidateStatus: "candidate",
      trajectories: [],
      computeScoreResult: null,
    });

    const result = await decideProceduralTransition(storage, "ws1", "a1");
    expect(result.action).toBe("noop");
    expect(result.reason).toMatch(/waiting_for_ab_data/);
    expect(transitionPromptVersion).not.toHaveBeenCalled();
  });

  it("returns noop when fewer than MIN_SAMPLE_SESSIONS (10) trajectories exist for version", async () => {
    // Only 3 trajectories with this promptVersionId — below the 10-session gate
    const trajectories: ScoredTraj[] = Array.from({ length: 3 }, (_, i) => ({
      sessionId: `s${i}`,
      score: 0.9,
      promptVersionId: "v-candidate",
      createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    }));

    const { storage, transitionPromptVersion } = makeStorage({
      candidateId: "v-candidate",
      candidateStatus: "candidate",
      avgScoreBefore: 0.5,
      trajectories,
      computeScoreResult: 0.9,  // high score but not enough samples
    });

    const result = await decideProceduralTransition(storage, "ws1", "a1");
    expect(result.action).toBe("noop");
    expect(result.reason).toMatch(/waiting_for_ab_data_sessions=3_of_10/);
    // transitions candidate → testing when below sample gate
    expect(transitionPromptVersion).toHaveBeenCalledWith("ws1", "v-candidate", "testing", 0.9);
  });

  it("returns noop when getActivePromptVersion is not implemented", async () => {
    const storage = {} as unknown as StorageAdapter;
    const result = await decideProceduralTransition(storage, "ws1", "a1");
    expect(result.action).toBe("noop");
    expect(result.reason).toBe("getActivePromptVersion_not_implemented");
  });

  it("returns noop when computeCandidateAbScore is not implemented", async () => {
    const { storage, transitionPromptVersion } = makeStorage({
      candidateId: "v-candidate",
      candidateStatus: "candidate",
      trajectories: Array.from({ length: 10 }, (_, i) => ({
        sessionId: `s${i}`,
        score: 0.8,
        promptVersionId: "v-candidate",
        createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
      })),
      hasComputeCandidateAbScore: false,
    });

    const result = await decideProceduralTransition(storage, "ws1", "a1");
    expect(result.action).toBe("noop");
    expect(result.reason).toBe("computeCandidateAbScore_not_implemented");
    expect(transitionPromptVersion).not.toHaveBeenCalled();
  });

  it("rolls back (not activates) when scoreAfter is worse than before", async () => {
    // Use MIN_SAMPLE_SESSIONS (10) trajectories to pass the sample gate
    const trajectories: ScoredTraj[] = Array.from({ length: 10 }, (_, i) => ({
      sessionId: `s${i}`,
      score: 0.3,
      promptVersionId: "v-bad",
      createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    }));

    const { storage, transitionPromptVersion } = makeStorage({
      candidateId: "v-bad",
      candidateStatus: "candidate",
      avgScoreBefore: 0.7,
      trajectories,
      computeScoreResult: 0.3,
    });

    const result = await decideProceduralTransition(storage, "ws1", "a1");
    expect(result.action).toBe("rolled_back");
    expect(transitionPromptVersion).toHaveBeenCalledWith("ws1", "v-bad", "rolled_back", 0.3);
  });

  it("skips non-candidate/non-testing versions (noop for 'active' status)", async () => {
    const { storage, transitionPromptVersion } = makeStorage({
      candidateId: "v-already-active",
      candidateStatus: "active",
    });

    const result = await decideProceduralTransition(storage, "ws1", "a1");
    expect(result.action).toBe("noop");
    expect(result.reason).toBe("no_candidate_version");
    expect(transitionPromptVersion).not.toHaveBeenCalled();
  });

  it("transitions candidate to testing when below sample gate and has transitionPromptVersion", async () => {
    // 5 sessions — not yet at MIN_SAMPLE_SESSIONS (10)
    const trajectories: ScoredTraj[] = Array.from({ length: 5 }, (_, i) => ({
      sessionId: `s${i}`,
      score: 0.75,
      promptVersionId: "v-candidate",
      createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    }));

    const { storage, transitionPromptVersion } = makeStorage({
      candidateId: "v-candidate",
      candidateStatus: "candidate",
      avgScoreBefore: 0.5,
      trajectories,
      computeScoreResult: 0.75,
    });

    const result = await decideProceduralTransition(storage, "ws1", "a1");
    expect(result.action).toBe("noop");
    expect(result.reason).toMatch(/waiting_for_ab_data_sessions=5_of_10/);
    // The candidate should have been transitioned to 'testing'
    expect(transitionPromptVersion).toHaveBeenCalledWith("ws1", "v-candidate", "testing", 0.75);
  });

  it("a testing row with >= MIN_SAMPLE_SESSIONS winning sessions transitions to active", async () => {
    // 10 sessions for a version already in 'testing' status
    const trajectories: ScoredTraj[] = Array.from({ length: 10 }, (_, i) => ({
      sessionId: `s${i}`,
      score: 0.85,
      promptVersionId: "v-testing",
      createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    }));

    const { storage, transitionPromptVersion } = makeStorage({
      candidateId: "v-testing",
      candidateStatus: "testing",
      avgScoreBefore: 0.6,
      trajectories,
      computeScoreResult: 0.85,
    });

    const result = await decideProceduralTransition(storage, "ws1", "a1");
    expect(result.action).toBe("activated");
    expect(transitionPromptVersion).toHaveBeenCalledWith("ws1", "v-testing", "active", 0.85);
  });

  it("does not call transitionPromptVersion when below sample gate and transitionPromptVersion is absent", async () => {
    const trajectories: ScoredTraj[] = Array.from({ length: 3 }, (_, i) => ({
      sessionId: `s${i}`,
      score: 0.9,
      promptVersionId: "v-candidate",
      createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    }));

    const { storage, transitionPromptVersion } = makeStorage({
      candidateId: "v-candidate",
      candidateStatus: "candidate",
      avgScoreBefore: 0.5,
      trajectories,
      computeScoreResult: 0.9,
      hasTransitionPromptVersion: false,
    });

    const result = await decideProceduralTransition(storage, "ws1", "a1");
    expect(result.action).toBe("noop");
    expect(result.reason).toMatch(/waiting_for_ab_data/);
    // transitionPromptVersion not available — should not throw
    expect(transitionPromptVersion).not.toHaveBeenCalled();
  });
});
