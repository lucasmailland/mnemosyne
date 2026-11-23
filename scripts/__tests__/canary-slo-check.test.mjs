import { test } from "node:test";
import assert from "node:assert/strict";
import { checkStage, imageMatcher } from "../canary-slo-check.mjs";

const prom = "https://prom.example/api/v1";
const answer = (value) => async () => ({
  json: async () => ({ data: { result: value == null ? [] : [{ value: [0, String(value)] }] } }),
});
const base = { prom, tag: "sha-abc.1", mode: "split" };

test("no PROMETHEUS_URL holds instead of promoting", async () => {
  const r = await checkStage({ ...base, prom: undefined, evaluate: () => "promote" });
  assert.equal(r.decision, "hold");
});

test("missing and NaN (no traffic) series reach evaluate as null", async () => {
  for (const v of [null, "NaN"]) {
    let seen;
    await checkStage({
      ...base,
      fetchImpl: answer(v),
      evaluate: (b, c) => ((seen = [b, c]), "hold"),
    });
    assert.deepEqual(seen, [null, null]);
  }
});

test("split compares candidate machines with the others in the same window", async () => {
  const urls = [];
  await checkStage({
    ...base,
    fetchImpl: async (u) => (urls.push(decodeURIComponent(u)), answer(0.01)()),
    evaluate: () => "promote",
  });
  assert.equal(urls.filter((u) => u.includes('image=~".*:sha-abc\\\\.1(@.*)?"')).length, 2);
  assert.equal(urls.filter((u) => u.includes('image!~".*:sha-abc\\\\.1(@.*)?"')).length, 2);
  assert.ok(urls.every((u) => !u.includes("offset")));
});

test("history offsets every selector of the baseline only", async () => {
  const urls = [];
  await checkStage({
    ...base,
    mode: "history",
    fetchImpl: async (u) => (urls.push(decodeURIComponent(u)), answer(0.01)()),
    evaluate: () => "promote",
  });
  for (const u of urls) {
    const offsets = (u.match(/offset 1h/g) ?? []).length;
    assert.equal(
      offsets,
      u.includes("image!~") ? (u.match(/\[5m\]|mnemo_build_info/g) ?? []).length : 0
    );
  }
});

test("rejects a tag that is not an image tag", () => {
  assert.throws(() => imageMatcher('x"} or vector(1) #'));
});
