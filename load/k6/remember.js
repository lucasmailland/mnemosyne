// k6 load test for POST /remember — the write path.
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";
import { BASE_URL, authHeaders } from "./lib/auth.js";
import { randomStatement, randomTopic, randomTag } from "./lib/payload.js";

export const options = {
  scenarios: {
    remember_steady: {
      executor: "constant-arrival-rate",
      rate: parseInt(__ENV.MNEMO_REMEMBER_RPS || "5"),
      timeUnit: "1s",
      duration: __ENV.MNEMO_DURATION || "2m",
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(99)<3000"],
    "remember_duration{scenario:remember_steady}": ["p(99)<1000"],
  },
};

const rememberDuration = new Trend("remember_duration", true);
const rememberErrors = new Rate("remember_errors");

export default function () {
  const payload = JSON.stringify({
    statement: randomStatement(),
    confidence: 0.9,
    topicKey: randomTopic(),
    tags: [randomTag()],
  });
  const res = http.post(`${BASE_URL}/remember`, payload, {
    headers: authHeaders(),
    timeout: "15s",
  });

  const ok = check(res, {
    "status 201": (r) => r.status === 201,
    "has id": (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.id === "string";
      } catch {
        return false;
      }
    },
  });

  rememberDuration.add(res.timings.duration);
  rememberErrors.add(!ok);

  sleep(0.2);
}
