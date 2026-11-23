// k6 load test for session lifecycle: start → remember → collapse.
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";
import { BASE_URL, authHeaders } from "./lib/auth.js";
import { randomStatement, randomTopic } from "./lib/payload.js";

export const options = {
  scenarios: {
    collapse_steady: {
      executor: "constant-arrival-rate",
      rate: parseInt(__ENV.MNEMO_COLLAPSE_RPS || "1"),
      timeUnit: "1s",
      duration: __ENV.MNEMO_DURATION || "2m",
      preAllocatedVUs: 5,
      maxVUs: 20,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.02"],
    "collapse_duration{scenario:collapse_steady}": ["p(99)<30000"],
  },
};

const collapseDuration = new Trend("collapse_duration", true);
const collapseErrors = new Rate("collapse_errors");

export default function () {
  const startRes = http.post(
    `${BASE_URL}/session/start`,
    JSON.stringify({ agentId: `k6-agent-${__VU}` }),
    { headers: authHeaders(), timeout: "10s" }
  );
  if (!check(startRes, { "session started": (r) => r.status === 200 || r.status === 201 })) {
    collapseErrors.add(1);
    return;
  }
  const { sessionId } = JSON.parse(startRes.body);

  for (let i = 0; i < 3; i++) {
    http.post(
      `${BASE_URL}/remember`,
      JSON.stringify({ statement: randomStatement(), sessionId, topicKey: randomTopic() }),
      { headers: authHeaders(), timeout: "15s" }
    );
  }

  const t0 = Date.now();
  const collapseRes = http.post(`${BASE_URL}/session/${sessionId}/collapse`, JSON.stringify({}), {
    headers: authHeaders(),
    timeout: "60s",
  });
  const elapsed = Date.now() - t0;

  const ok = check(collapseRes, {
    "collapse 200": (r) => r.status === 200,
  });

  collapseDuration.add(elapsed);
  collapseErrors.add(!ok);

  sleep(1);
}
