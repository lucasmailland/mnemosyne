// Shared auth header builder for k6 scripts.
export const BASE_URL = __ENV.MNEMO_BASE_URL || "http://localhost:3939";
export const API_KEY = __ENV.MNEMO_TEST_API_KEY || "mk_test_localdev";

export function authHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
    ...extra,
  };
}
