// k6 load test for POST /recall — the primary hot path.
//
// Usage:
//   k6 run --env MNEMO_BASE_URL=http://localhost:3939 \
//          --env MNEMO_TEST_API_KEY=mk_test_localdev \
//          load/k6/recall.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";
import { BASE_URL, authHeaders } from "./lib/auth.js";
import { randomQuery } from "./lib/payload.js";

export const options = {
  scenarios: {
    recall_steady: {
      executor: "constant-arrival-rate",
      rate: parseInt(__ENV.MNEMO_RECALL_RPS || "10"),
      timeUnit: "1s",
      duration: __ENV.MNEMO_DURATION || "2m",
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(99)<4000"],
    "recall_duration{scenario:recall_steady}": ["p(99)<4000"],
  },
};

const recallDuration = new Trend("recall_duration", true);
const recallErrors = new Rate("recall_errors");

export default function () {
  const payload = JSON.stringify({ query: randomQuery(), topK: 10 });
  const res = http.post(`${BASE_URL}/recall`, payload, {
    headers: authHeaders(),
    timeout: "10s",
  });

  const ok = check(res, {
    "status 200": (r) => r.status === 200,
    "has results": (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.hits);
      } catch {
        return false;
      }
    },
  });

  recallDuration.add(res.timings.duration);
  recallErrors.add(!ok);

  sleep(0.1);
}
