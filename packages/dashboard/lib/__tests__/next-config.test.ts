/**
 * APP-057: every route carries the security headers, set in next.config.ts. The link page keeps
 * its own stricter Referrer-Policy (it comes after, so it wins on /link/*).
 */
import { expect, it } from "vitest";

import nextConfig from "../../next.config";

const routes = async () => (await nextConfig.headers!()) ?? [];
const headersOf = async (source: string) =>
  Object.fromEntries(
    ((await routes()).find((r) => r.source === source)?.headers ?? []).map((h) => [h.key, h.value])
  );

it("sets the security headers for every route", async () => {
  const h = await headersOf("/:path*");
  const csp = Object.fromEntries(
    h["Content-Security-Policy"]!.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values.join(" ")];
    })
  );
  expect(csp["default-src"]).toBe("'self'");
  expect(csp["script-src"]).toMatch(/^'self'/);
  expect(csp["img-src"]).toBe("'self' data: blob:");
  expect(csp["font-src"]).toBe("'self' data:");
  expect(csp["connect-src"]).toBe("'self'");
  expect(csp["frame-ancestors"]).toBe("'none'");
  expect(csp["base-uri"]).toBe("'self'");
  expect(csp["form-action"]).toBe("'self'");
  expect(csp["object-src"]).toBe("'none'");
  expect(h["X-Content-Type-Options"]).toBe("nosniff");
  expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["Permissions-Policy"]).toContain("camera=()");
  expect(h["Strict-Transport-Security"]).toMatch(/^max-age=\d+/);
});

it("does not announce the framework, and keeps the link page's own headers after the global ones", async () => {
  expect(nextConfig.poweredByHeader).toBe(false);
  const sources = (await routes()).map((r) => r.source);
  expect(sources.indexOf("/link/:path*")).toBeGreaterThan(sources.indexOf("/:path*"));
  expect(await headersOf("/link/:path*")).toEqual({
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
});
