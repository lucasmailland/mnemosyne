/**
 * Canary staged ramp guard — spec §35 task 6.7.
 *
 * deploy-canary.yml ramps by machine share (Fly has no weighted routing): one
 * machine, half the machines, then all. Guards the order and that only
 * `promote` advances. What a stage does (move, judge, roll back) lives in
 * scripts/canary-rollout.mjs and is run end to end by
 * scripts/__tests__/canary-rollout.test.mjs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const wfPath = fileURLToPath(
  new URL("../../../../../.github/workflows/deploy-canary.yml", import.meta.url)
);
const raw = readFileSync(wfPath, "utf8");
type Step = { id?: string; name?: string; run?: string; if?: string };
type Job = { needs?: string | string[]; if?: string; steps: Step[] };
const jobs = (yaml.load(raw) as { jobs: Record<string, Job> }).jobs;
const STAGES = ["canary-one", "canary-half", "full-rollout"];
const needsOf = (j: Job) => (Array.isArray(j.needs) ? j.needs : j.needs ? [j.needs] : []);

describe("deploy-canary.yml staged ramp (task 6.7)", () => {
  it("runs one machine, then half, then the full rollout, in order", () => {
    expect(Object.keys(jobs)).toEqual(STAGES);
    expect(needsOf(jobs["canary-half"]!)).toContain("canary-one");
    expect(needsOf(jobs["full-rollout"]!)).toContain("canary-half");
  });

  it("each stage runs scripts/canary-rollout.mjs, never a whole-app canary deploy", () => {
    const stageArg = { "canary-one": "one", "canary-half": "half", "full-rollout": "full" };
    for (const k of STAGES) {
      const step = jobs[k]!.steps.find((s) => s.id === "stage");
      expect(step?.run, k).toBe(
        `node scripts/canary-rollout.mjs ${stageArg[k as keyof typeof stageArg]}`
      );
      expect(step?.if, k).toBeUndefined();
    }
    const runs = STAGES.flatMap((k) => jobs[k]!.steps.map((s) => s.run ?? "")).join("\n");
    expect(runs).not.toMatch(/--strategy canary/);
    expect(runs).not.toMatch(/fly rollback/);
  });

  it("later stages roll back to the image stage one recorded", () => {
    expect(raw).toContain("previous_image: ${{ steps.stage.outputs.previous_image }}");
    for (const k of ["canary-half", "full-rollout"]) {
      const env = (jobs[k]!.steps.find((s) => s.id === "stage") as { env?: Record<string, string> })
        .env;
      expect(env?.PREVIOUS_IMAGE, k).toBe("${{ needs.canary-one.outputs.previous_image }}");
    }
  });

  it("only a promote decision lets the next stage run", () => {
    expect(jobs["canary-half"]!.if).toBe("needs.canary-one.outputs.decision == 'promote'");
    expect(jobs["full-rollout"]!.if).toMatch(/canary-one\.outputs\.decision == 'promote'/);
    expect(jobs["full-rollout"]!.if).toMatch(/canary-half\.outputs\.decision == 'promote'/);
  });

  it("gives every stage PROMETHEUS_URL (the script stops before fly without it)", () => {
    for (const k of STAGES) {
      const env = (jobs[k]!.steps.find((s) => s.id === "stage") as { env?: Record<string, string> })
        .env;
      expect(env?.PROMETHEUS_URL, k).toBe("${{ secrets.PROMETHEUS_URL }}");
    }
  });
});
