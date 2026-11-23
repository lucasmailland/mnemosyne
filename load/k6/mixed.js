// Mixed load profile: 70% recall, 20% remember, 10% collapse.
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";
import { BASE_URL, authHeaders } from "./lib/auth.js";
import { randomQuery, randomStatement, randomTopic, randomTag } from "./lib/payload.js";

const TARGET_RPS = parseInt(__ENV.MNEMO_TARGET_RPS || "20");

export const options = {
  scenarios: {
    recall: {
      executor: "constant-arrival-rate",
      rate: Math.round(TARGET_RPS * 0.7),
      timeUnit: "1s",
      duration: __ENV.MNEMO_DURATION || "2m",
      preAllocatedVUs: 30,
      maxVUs: 150,
      exec: "doRecall",
    },
    remember: {
      executor: "constant-arrival-rate",
      rate: Math.round(TARGET_RPS * 0.2),
      timeUnit: "1s",
      duration: __ENV.MNEMO_DURATION || "2m",
      preAllocatedVUs: 10,
      maxVUs: 50,
      exec: "doRemember",
    },
    collapse: {
      executor: "constant-arrival-rate",
      rate: Math.max(1, Math.round(TARGET_RPS * 0.1)),
      timeUnit: "1s",
      duration: __ENV.MNEMO_DURATION || "2m",
      preAllocatedVUs: 5,
      maxVUs: 20,
      exec: "doCollapse",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    recall_p99: ["p(99)<500"],
    remember_p99: ["p(99)<1000"],
    http_req_duration: ["p(95)<2000"],
  },
};

const recallP99 = new Trend("recall_p99", true);
const rememberP99 = new Trend("remember_p99", true);
const totalRequests = new Counter("total_requests");

export function doRecall() {
  const res = http.post(`${BASE_URL}/recall`, JSON.stringify({ query: randomQuery(), topK: 10 }), {
    headers: authHeaders(),
    timeout: "10s",
  });
  check(res, { "recall 200": (r) => r.status === 200 });
  recallP99.add(res.timings.duration);
  totalRequests.add(1);
  sleep(0.05);
}

export function doRemember() {
  const res = http.post(
    `${BASE_URL}/remember`,
    JSON.stringify({ statement: randomStatement(), topicKey: randomTopic(), tags: [randomTag()] }),
    { headers: authHeaders(), timeout: "15s" }
  );
  check(res, { "remember 201": (r) => r.status === 201 });
  rememberP99.add(res.timings.duration);
  totalRequests.add(1);
  sleep(0.1);
}

export function doCollapse() {
  const startRes = http.post(
    `${BASE_URL}/session/start`,
    JSON.stringify({ agentId: `k6-${__VU}` }),
    { headers: authHeaders(), timeout: "10s" }
  );
  if (startRes.status !== 200 && startRes.status !== 201) {
    sleep(1);
    return;
  }
  const { sessionId } = JSON.parse(startRes.body);
  http.post(`${BASE_URL}/remember`, JSON.stringify({ statement: randomStatement(), sessionId }), {
    headers: authHeaders(),
    timeout: "15s",
  });
  const colRes = http.post(`${BASE_URL}/session/${sessionId}/collapse`, "{}", {
    headers: authHeaders(),
    timeout: "60s",
  });
  check(colRes, { "collapse 200": (r) => r.status === 200 });
  totalRequests.add(3);
  sleep(1);
}

export default function () {
  doRecall();
}
