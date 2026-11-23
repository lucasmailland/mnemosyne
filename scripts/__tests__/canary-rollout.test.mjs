// Runs scripts/canary-rollout.mjs the way .github/workflows/deploy-canary.yml
// does (stage one, then half with its previous_image, then full, each only after
// a promote) against a fake `fly` on PATH and a fake Prometheus on localhost.
// Needs packages/core built (evaluateCanary comes from its dist, as in CI).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isImageRef, machinesToMove, observeSeconds, previousImage } from "../canary-rollout.mjs";

const SCRIPT = fileURLToPath(new URL("../canary-rollout.mjs", import.meta.url));
const FAKE_FLY = fileURLToPath(new URL("./fake-fly.mjs", import.meta.url));
const OLD = "registry.fly.io/mnemosyne:sha-old";
const TAG = "sha-new";
const NEW = `registry.fly.io/mnemosyne:${TAG}`;

// What Prometheus answers; set per stage by the tests. null = empty result.
let metrics;
const healthy = { err: 0.001, p99: 120 };
const server = createServer((req, res) => {
  const q = new URL(req.url, "http://x").searchParams.get("query") ?? "";
  const side = metrics[q.includes("image=~") ? "candidate" : "others"];
  const v = side && (q.includes("histogram_quantile") ? side.p99 : side.err);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data: { result: v == null ? [] : [{ value: [0, String(v)] }] } }));
});
let prom;
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  prom = `http://127.0.0.1:${server.address().port}/api/v1`;
});
after(() => server.close());

function setup(images = [OLD, OLD, OLD, OLD]) {
  const dir = mkdtempSync(join(tmpdir(), "canary-"));
  const machines = images.map((image, i) => ({
    id: `m${i}`,
    state: "started",
    config: { image },
  }));
  // A stopped machine on another image: never moved, never the rollback target.
  machines.push({ id: "stopped", state: "stopped", config: { image: "registry.fly.io/x:y" } });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ machines }));
  writeFileSync(join(dir, "fly.log"), "");
  writeFileSync(join(dir, "fly"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_FLY}" "$@"\n`);
  chmodSync(join(dir, "fly"), 0o755);
  const env = {
    PATH: `${dir}:${process.env.PATH}`,
    FAKE_FLY_STATE: join(dir, "state.json"),
    FAKE_FLY_LOG: join(dir, "fly.log"),
    FLY_APP: "mnemosyne",
    NEW_IMAGE: NEW,
    CANARY_IMAGE_TAG: TAG,
    PROMETHEUS_URL: prom,
    OBSERVE_SECS: "0",
  };
  return {
    env,
    images: () =>
      JSON.parse(readFileSync(env.FAKE_FLY_STATE, "utf8"))
        .machines.filter((m) => m.state === "started")
        .map((m) => m.config.image),
    calls: () =>
      readFileSync(env.FAKE_FLY_LOG, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const a = JSON.parse(l);
          const img = a[a.indexOf("--image") + 1];
          if (a[0] === "deploy") return `deploy ${img}`;
          return a[1] === "update" ? `update ${a[2]} ${img}` : `machine ${a[1]}`;
        }),
  };
}

async function stage(name, env, extra = {}) {
  const out = join(mkdtempSync(join(tmpdir(), "gh-")), "output");
  writeFileSync(out, "");
  const child = spawn(process.execPath, [SCRIPT, name], {
    env: { ...env, ...extra, GITHUB_OUTPUT: out },
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const code = await new Promise((r) => child.on("close", r));
  const outputs = Object.fromEntries(
    readFileSync(out, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(/=(.*)/s).slice(0, 2))
  );
  return { code, outputs, log };
}

// The three jobs with the workflow's `if:` gates. `perStage` = metrics per stage.
async function workflow(env, perStage) {
  const ran = {};
  metrics = perStage.one;
  ran.one = await stage("one", env);
  if (ran.one.outputs.decision !== "promote") return ran;
  metrics = perStage.half;
  ran.half = await stage("half", env, { PREVIOUS_IMAGE: ran.one.outputs.previous_image });
  if (ran.half.outputs.decision !== "promote") return ran;
  metrics = perStage.full;
  ran.full = await stage("full", env, { PREVIOUS_IMAGE: ran.one.outputs.previous_image });
  return ran;
}

const ok = { candidate: healthy, others: healthy };

test("full promotion: 1 machine, then half, then every machine on the new image", async () => {
  const f = setup();
  const ran = await workflow(f.env, { one: ok, half: ok, full: ok });
  assert.deepEqual(
    [ran.one.code, ran.half.code, ran.full.code],
    [0, 0, 0],
    ran.one.log + ran.half?.log + ran.full?.log
  );
  assert.equal(ran.one.outputs.previous_image, OLD);
  assert.deepEqual(f.calls(), [
    "machine list", // stage one: rollback target
    "machine list",
    `update m0 ${NEW}`, // 1 of 4
    "machine list",
    `update m1 ${NEW}`, // 2 of 4
    `deploy ${NEW}`,
  ]);
  assert.deepEqual(f.images(), [NEW, NEW, NEW, NEW]);
  assert.ok(!readFileSync(f.env.FAKE_FLY_LOG, "utf8").includes(OLD));
});

test("SLO rollback at half the machines puts every machine back on the previous image", async () => {
  const f = setup();
  const bad = { candidate: { err: 0.2, p99: 120 }, others: healthy };
  const ran = await workflow(f.env, { one: ok, half: bad });
  assert.equal(ran.one.code, 0);
  assert.equal(ran.half.code, 1);
  assert.equal(ran.half.outputs.decision, "rollback");
  assert.equal(ran.full, undefined);
  assert.deepEqual(f.calls().slice(-1), [`deploy ${OLD}`]);
  assert.deepEqual(f.images(), [OLD, OLD, OLD, OLD]);
  assert.match(ran.half.log, /SLO degraded at half the machines/);
});

test("SLO rollback at the full rollout compares with an hour earlier and rolls back", async () => {
  const f = setup();
  const slow = { candidate: { err: 0.001, p99: 900 }, others: healthy };
  const ran = await workflow(f.env, { one: ok, half: ok, full: slow });
  assert.equal(ran.full.code, 1);
  assert.equal(ran.full.outputs.decision, "rollback");
  assert.deepEqual(f.images(), [OLD, OLD, OLD, OLD]);
});

test("hold (no candidate series) rolls back too and says how to retry", async () => {
  const f = setup();
  const ran = await workflow(f.env, { one: { candidate: null, others: healthy } });
  assert.equal(ran.one.code, 1);
  assert.equal(ran.one.outputs.decision, "hold");
  assert.equal(ran.half, undefined);
  assert.deepEqual(f.calls().slice(-2), [`update m0 ${NEW}`, `deploy ${OLD}`]);
  assert.deepEqual(f.images(), [OLD, OLD, OLD, OLD]);
  assert.match(ran.one.log, /Not enough metrics to judge 1 machine/);
  assert.match(ran.one.log, /deploy by hand/);
});

test("a Prometheus that does not answer is a failure that rolls back", async () => {
  const f = setup();
  metrics = ok;
  const ran = await stage("one", { ...f.env, PROMETHEUS_URL: "http://127.0.0.1:1/api/v1" });
  assert.equal(ran.code, 1);
  assert.equal(ran.outputs.decision, "error");
  assert.deepEqual(f.images(), [OLD, OLD, OLD, OLD]);
});

test("without PROMETHEUS_URL it stops before calling fly at all", async () => {
  const f = setup();
  for (const name of ["one", "half", "full"]) {
    const ran = await stage(name, { ...f.env, PROMETHEUS_URL: "" }, { PREVIOUS_IMAGE: OLD });
    assert.equal(ran.code, 1, name);
    assert.match(ran.log, /PROMETHEUS_URL is not set/);
  }
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(f.images(), [OLD, OLD, OLD, OLD]);
});

test("a tag PromQL cannot match safely stops before calling fly", async () => {
  const f = setup();
  const ran = await stage("one", { ...f.env, CANARY_IMAGE_TAG: 'x"} or vector(1) #' });
  assert.notEqual(ran.code, 0);
  assert.deepEqual(f.calls(), []);
});

test("a previous image equal to the new one is refused before any machine moves", async () => {
  // Stage one: every started machine already runs the new image (one by digest).
  const f = setup([NEW, `${NEW}@sha256:${"a".repeat(64)}`, NEW]);
  metrics = ok;
  const one = await stage("one", f.env);
  assert.equal(one.code, 1);
  assert.equal(one.outputs.previous_image, undefined);
  assert.deepEqual(f.calls(), ["machine list"]);
  assert.match(one.log, /No started machine runs an image other than/);

  // Later stages: a PREVIOUS_IMAGE that is the new image, or missing.
  const g = setup();
  for (const prev of [NEW, `${NEW}@sha256:${"a".repeat(64)}`, ""]) {
    for (const name of ["half", "full"]) {
      const ran = await stage(name, g.env, { PREVIOUS_IMAGE: prev });
      assert.equal(ran.code, 1, `${name} ${prev}`);
      assert.match(ran.log, /No previous image to roll back to/);
    }
  }
  assert.deepEqual(g.calls(), []);
});

test("previousImage and machinesToMove pick by started machines only", () => {
  const ms = [
    { id: "a", state: "started", config: { image: "img:1" } },
    { id: "b", state: "started", config: { image: `${NEW}@sha256:x` } },
    { id: "c", state: "started", config: { image: "img:2" } },
    { id: "d", state: "started", config: { image: "img:2" } },
    { id: "e", state: "stopped", config: { image: "img:3" } },
    { id: "f", state: "stopped", config: { image: "img:3" } },
    { id: "g", state: "stopped", config: { image: "img:3" } },
  ];
  assert.equal(previousImage(ms, NEW), "img:2");
  // 4 started, 1 already new: half (2) needs one more; one machine needs none.
  assert.deepEqual(
    machinesToMove(ms, NEW, (n) => Math.ceil(n / 2)),
    ["a"]
  );
  assert.deepEqual(
    machinesToMove(ms, NEW, () => 1),
    []
  );
});

test("an invalid OBSERVE_SECS stops before calling fly; an empty one means 600", async () => {
  const f = setup();
  const ran = await stage("one", { ...f.env, OBSERVE_SECS: "ten minutes" });
  assert.notEqual(ran.code, 0);
  assert.match(ran.log, /OBSERVE_SECS must be a non-negative number/);
  assert.deepEqual(f.calls(), []);
  assert.equal(observeSeconds(""), 600);
  assert.equal(observeSeconds(undefined), 600);
  assert.equal(observeSeconds("0"), 0);
});

test("a previous image that is not an image ref is never emitted or deployed", async () => {
  const f = setup();
  const ran = await stage("half", f.env, { PREVIOUS_IMAGE: "x\ndecision=promote" });
  assert.equal(ran.code, 1);
  assert.equal(ran.outputs.decision, undefined);
  assert.deepEqual(f.calls(), []);
  assert.equal(isImageRef(OLD), true);
  assert.equal(isImageRef(`${NEW}@sha256:${"a".repeat(64)}`), true);
  assert.equal(isImageRef("x\ny"), false);
});

test("a stage marks moved before touching machines and rolled_back after its rollback", async () => {
  const f = setup();
  metrics = { candidate: { err: 0.5, p99: 9000 }, others: healthy };
  const ran = await stage("one", f.env);
  assert.equal(ran.outputs.moved, "true");
  assert.equal(ran.outputs.rolled_back, "true");
});

test("the safety-net rollback puts every machine back on PREVIOUS_IMAGE", async () => {
  const f = setup([NEW, NEW, OLD, OLD]);
  const ran = await stage("rollback", f.env, { PREVIOUS_IMAGE: OLD });
  assert.equal(ran.code, 1);
  assert.deepEqual(f.calls(), [`deploy ${OLD}`]);
  const none = await stage("rollback", f.env, { PREVIOUS_IMAGE: "" });
  assert.equal(none.code, 0);
});
