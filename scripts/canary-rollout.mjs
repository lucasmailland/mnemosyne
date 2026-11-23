#!/usr/bin/env node
// One stage of .github/workflows/deploy-canary.yml, end to end: record the
// image to roll back to, move machines to the new image, wait, judge the stage
// with scripts/canary-slo-check.mjs and, on anything but "promote" (hold and
// any error included), put every machine back on the previous image.
//
//   node scripts/canary-rollout.mjs one    # 1 machine; records previous_image
//   node scripts/canary-rollout.mjs half   # half the machines; needs PREVIOUS_IMAGE
//   node scripts/canary-rollout.mjs full   # rolling deploy to every machine; needs PREVIOUS_IMAGE
//
// Env: FLY_APP, NEW_IMAGE, CANARY_IMAGE_TAG, PROMETHEUS_URL, OBSERVE_SECS,
// PREVIOUS_IMAGE (half, full) and GITHUB_OUTPUT (gets previous_image= and
// decision=). Exits 0 only on "promote". Talks to Fly only through the `fly`
// on PATH, so scripts/__tests__/canary-rollout.test.mjs runs it against a fake.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { checkStage, imageMatcher } from "./canary-slo-check.mjs";

const STAGES = {
  one: { label: "1 machine", mode: "split" },
  half: { label: "half the machines", mode: "split" },
  full: { label: "full rollout", mode: "history" },
};

/** An image ref the workflow may pass to fly or emit as a step output. */
const IMAGE_REF = /^[a-z0-9][a-z0-9./_-]*(:[A-Za-z0-9_.-]+)?(@sha256:[a-f0-9]{64})?$/;
export const isImageRef = (v) => typeof v === "string" && IMAGE_REF.test(v);

/** OBSERVE_SECS: unset or empty means 600; anything but a non-negative number stops the stage. */
export function observeSeconds(raw) {
  if (raw === undefined || raw.trim() === "") return 600;
  const secs = Number(raw);
  if (!Number.isFinite(secs) || secs < 0) {
    throw new Error(`OBSERVE_SECS must be a non-negative number of seconds, got "${raw}"`);
  }
  return secs;
}

/** A ref of `newImage` itself ("...:tag" or "...:tag@sha256:..."). */
export const isNew = (image, newImage) => image === newImage || image.startsWith(`${newImage}@`);

/** The image most started machines run that is not `newImage`, or null. */
export function previousImage(machines, newImage) {
  const counts = new Map();
  for (const m of machines) {
    const img = m.config?.image;
    if (m.state !== "started" || !img || isNew(img, newImage)) continue;
    counts.set(img, (counts.get(img) ?? 0) + 1);
  }
  let best = null;
  for (const [img, n] of counts) if (!best || n > counts.get(best)) best = img;
  return best;
}

/** Ids of the started machines to move so that `target` of them run `newImage`. */
export function machinesToMove(machines, newImage, target) {
  const started = machines.filter((m) => m.state === "started");
  const already = started.filter((m) => isNew(m.config?.image ?? "", newImage)).length;
  const need = Math.max(0, target(started.length) - already);
  return started
    .filter((m) => !isNew(m.config?.image ?? "", newImage))
    .slice(0, need)
    .map((m) => m.id);
}

export async function runStage(stage, env = process.env) {
  if (stage === "rollback") return rollbackOnly(env);
  const cfg = STAGES[stage];
  if (!cfg) throw new Error(`unknown stage "${stage}" (one, half or full)`);
  const { FLY_APP: app, NEW_IMAGE: newImage, PROMETHEUS_URL: prom } = env;
  const output = (k, v) => writeOutput(env, k, v);
  const fly = (...args) => execFileSync("fly", [...args, "--app", app], { encoding: "utf8" });
  const listMachines = () => JSON.parse(fly("machine", "list", "--json"));

  // Every check that can stop the stage runs before the first machine moves.
  if (!prom) {
    console.error("PROMETHEUS_URL is not set: a canary cannot be judged without metrics.");
    console.error("Nothing was deployed.");
    return 1;
  }
  if (!app || !newImage) throw new Error("FLY_APP and NEW_IMAGE are required");
  if (!isImageRef(newImage)) throw new Error(`NEW_IMAGE is not an image ref: "${newImage}"`);
  const observe = observeSeconds(env.OBSERVE_SECS);
  imageMatcher(env.CANARY_IMAGE_TAG); // throws on a tag PromQL could not match safely
  const previous = stage === "one" ? previousImage(listMachines(), newImage) : env.PREVIOUS_IMAGE;
  if (previous && !isImageRef(previous)) {
    console.error(`Rollback target is not an image ref: "${previous}". Nothing was deployed.`);
    return 1;
  }
  if (!previous || isNew(previous, newImage)) {
    console.error(
      stage === "one"
        ? `No started machine runs an image other than ${newImage}. Nothing was deployed.`
        : `No previous image to roll back to (got "${previous ?? ""}"). Nothing was deployed.`
    );
    return 1;
  }
  console.log(`Rollback target: ${previous}`);
  if (stage === "one") output("previous_image", previous);

  let result;
  output("moved", "true");
  try {
    if (stage === "full") {
      fly("deploy", "--image", newImage, "--strategy", "rolling", "--wait-timeout", "600");
    } else {
      const target = stage === "one" ? () => 1 : (total) => Math.ceil(total / 2);
      const ids = machinesToMove(listMachines(), newImage, target);
      console.log(`Moving ${ids.length} machine(s) to ${newImage}: ${ids.join(", ") || "none"}`);
      for (const id of ids) {
        fly("machine", "update", id, "--image", newImage, "--yes", "--wait-timeout", "300");
      }
    }
    await sleep(observe * 1000);
    const { evaluateCanary } = await import(
      new URL("../packages/core/dist/cognitive.js", import.meta.url).href
    );
    result = await checkStage({
      prom,
      tag: env.CANARY_IMAGE_TAG,
      mode: cfg.mode,
      evaluate: evaluateCanary,
    });
  } catch (err) {
    result = { decision: "error", reason: err?.message ?? String(err) };
  }
  console.log(`SLO decision at ${cfg.label}:`, JSON.stringify(result));
  output("decision", result.decision);
  if (result.decision === "promote") return 0;

  console.error(
    result.decision === "rollback"
      ? `SLO degraded at ${cfg.label}.`
      : result.decision === "hold"
        ? `Not enough metrics to judge ${cfg.label} (${result.reason ?? "no candidate or baseline series"}).`
        : `Stage ${cfg.label} failed: ${result.reason}`
  );
  console.error(`Rolling every machine back to ${previous}.`);
  fly("deploy", "--image", previous, "--strategy", "rolling", "--wait-timeout", "600");
  output("rolled_back", "true");
  if (result.decision === "hold") {
    console.error(
      "Check that Prometheus scrapes every machine and sees mnemo_build_info, then run"
    );
    console.error(
      `the workflow again, or deploy by hand: fly deploy --app ${app} --image ${newImage}`
    );
  }
  return 1;
}

/** A step output; a value with a line break could forge another output, so it is refused. */
function writeOutput(env, key, value) {
  if (!env.GITHUB_OUTPUT) return;
  if (/[\r\n]/.test(String(value)))
    throw new Error(`refusing a multi-line value for output ${key}`);
  appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

/**
 * The workflow's safety net, for a stage that died after moving machines and
 * before its own rollback: every machine back to PREVIOUS_IMAGE. Nothing to do
 * without one.
 */
function rollbackOnly(env) {
  const { FLY_APP: app, PREVIOUS_IMAGE: previous } = env;
  if (!previous) {
    console.error("No PREVIOUS_IMAGE: nothing to roll back to.");
    return 0;
  }
  if (!app || !isImageRef(previous))
    throw new Error("FLY_APP and a valid PREVIOUS_IMAGE are required");
  console.error(`Safety net: rolling every machine back to ${previous}.`);
  execFileSync(
    "fly",
    ["deploy", "--image", previous, "--strategy", "rolling", "--wait-timeout", "600", "--app", app],
    { encoding: "utf8", stdio: "inherit" }
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await runStage(process.argv[2]);
}
