import { expect, it } from "vitest";
import { loginPath } from "../login-path";
import { sanitizeDashboardNext } from "../utils";

it("keeps addresses inside the dashboard", () => {
  for (const ok of [
    "/dashboard",
    "/dashboard/",
    "/dashboard/sessions",
    "/dashboard/sessions/abc?tab=facts#top",
    "/dashboard?q=1",
    "/dashboard/recall?q=http://example.test//x",
  ])
    expect(sanitizeDashboardNext(ok)).toBe(ok);
});

it.each([
  ["nothing", null],
  ["an empty value", ""],
  ["another site", "https://evil.test/dashboard"],
  ["a protocol-relative address", "//evil.test/dashboard"],
  ["a path outside the dashboard", "/login"],
  ["APP-041 a sibling of the base path", "/dashboardX/evil"],
  ["APP-041 a host glued to the base path", "/dashboard.evil.test"],
  ["APP-041 a double slash after the base path", "/dashboard//evil.test"],
  ["APP-041 a double slash deeper in the path", "/dashboard/a//evil.test"],
  ["a backslash", "/dashboard/\\evil.test"],
  ["APP-041 a tab the browser would drop", "/dashboard/\t/evil.test"],
  ["APP-041 a line break the browser would drop", "/dashboard/\n/evil.test"],
])("falls back to the home for %s", (_, next) => {
  expect(sanitizeDashboardNext(next)).toBe("/dashboard");
});

it("loginPath carries the way back, and nothing when it is the home or not ours", () => {
  expect(loginPath("/dashboard/sessions/abc?tab=facts")).toBe(
    "/login?next=%2Fdashboard%2Fsessions%2Fabc%3Ftab%3Dfacts"
  );
  expect(loginPath("/dashboard")).toBe("/login");
  expect(loginPath("/dashboard/")).toBe("/login");
  expect(loginPath(null)).toBe("/login");
  expect(loginPath("//evil.test")).toBe("/login");
  // never back to the login itself
  expect(loginPath("/dashboard/login?next=%2Fdashboard%2Fx")).toBe("/login");
});
