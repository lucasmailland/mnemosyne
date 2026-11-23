// @vitest-environment node
import { expect, it } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "../../proxy";

const forwarded = (url: string, init?: { headers?: Record<string, string> }) =>
  proxy(new NextRequest(url, { ...init, nextConfig: { basePath: "/dashboard" } })).headers.get(
    "x-middleware-request-x-mnemo-path"
  );

it("APP-041 hands the server render the address it renders, base path and query included", () => {
  expect(forwarded("http://localhost/dashboard/sessions/abc?tab=facts")).toBe(
    "/dashboard/sessions/abc?tab=facts"
  );
});

it("APP-041 the address is the proxy's, never one the client sent", () => {
  expect(
    forwarded("http://localhost/dashboard/recall", { headers: { "x-mnemo-path": "//evil.test" } })
  ).toBe("/dashboard/recall");
});
