import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  LINK_ISSUE_BURST,
  LINK_TTL_SECONDS,
  consumeLinkIssue,
  hashLinkToken,
  isLinkToken,
  linkBaseUrl,
  linkTtl,
  linkUrl,
  newLinkToken,
  redactLinkPath,
} from "../../single-use-link.js";
import { getScopeForRequest } from "../../app-scope.js";
import { DashboardLoginLimiter } from "../../dashboard-password.js";

describe("newLinkToken", () => {
  it("makes 32 random bytes as base64url and their sha256 hex", () => {
    const { token, hash } = newLinkToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLinkToken(token)).toBe(hash);
  });

  it("never repeats a token", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newLinkToken().token));
    expect(tokens.size).toBe(200);
  });

  it("recognizes only tokens of that shape", () => {
    expect(isLinkToken(newLinkToken().token)).toBe(true);
    expect(isLinkToken("short")).toBe(false);
    expect(isLinkToken("a".repeat(44))).toBe(false);
    expect(isLinkToken(`${"a".repeat(42)}/`)).toBe(false);
    expect(isLinkToken(undefined)).toBe(false);
  });
});

describe("linkUrl", () => {
  it("points at the dashboard link page", () => {
    expect(linkUrl("https://mnemo.example.test", "abc")).toBe(
      "https://mnemo.example.test/dashboard/link/abc"
    );
  });
});

describe("linkBaseUrl", () => {
  const baseOf = async (url: string, env: Record<string, string | undefined>) => {
    const app = new Hono();
    app.get("*", async (c) => c.text(await linkBaseUrl(c, {}, env)));
    return (await app.request(url)).text();
  };

  it("uses MNEMO_PUBLIC_BASE_URL, trimmed and without trailing slashes", async () => {
    expect(
      await baseOf("http://internal:8080/x", {
        MNEMO_PUBLIC_BASE_URL: "  https://mnemo.example.test// ",
      })
    ).toBe("https://mnemo.example.test");
  });

  it("falls back to the request origin when unset or blank", async () => {
    expect(await baseOf("http://localhost:3000/a/b?c=1", {})).toBe("http://localhost:3000");
    expect(await baseOf("http://localhost:3000/a", { MNEMO_PUBLIC_BASE_URL: "  " })).toBe(
      "http://localhost:3000"
    );
  });
});

describe("link lifetimes", () => {
  it("invitation and account setup 7 days, password reset 30 minutes", () => {
    expect(LINK_TTL_SECONDS).toEqual({
      invite: 604_800,
      account_setup: 604_800,
      password_reset: 1_800,
    });
    expect(linkTtl("password_reset")).toBe("1800 seconds");
  });
});

describe("redactLinkPath", () => {
  it("replaces the token of both link paths and leaves other paths alone", () => {
    const { token } = newLinkToken();
    expect(redactLinkPath(`/dashboard/auth/link/${token}`)).toBe("/dashboard/auth/link/:token");
    expect(redactLinkPath(`/dashboard/link/${token}`)).toBe("/dashboard/link/:token");
    expect(redactLinkPath("/dashboard/auth/login")).toBe("/dashboard/auth/login");
    expect(redactLinkPath("/facts/abc")).toBe("/facts/abc");
  });
});

describe("consumeLinkIssue", () => {
  it("allows 30 links per acting user, then asks to wait; other users are unaffected", async () => {
    const deps = {};
    for (let i = 0; i < LINK_ISSUE_BURST; i++) expect(await consumeLinkIssue(deps, "u1")).toBe(0);
    expect(await consumeLinkIssue(deps, "u1")).toBeGreaterThan(0);
    expect(await consumeLinkIssue(deps, "u2")).toBe(0);
  });
});

describe("DashboardLoginLimiter.consumeKeys", () => {
  it("takes a token from every bucket and reports the longest wait", async () => {
    let now = 0;
    const limiter = new DashboardLoginLimiter(undefined, () => now);
    expect(await limiter.consumeKeys([["a", 1]])).toBe(0);
    expect(await limiter.consumeKeys([["a", 1]])).toBeGreaterThan(0);
    now += 15 * 60_000;
    expect(await limiter.consumeKeys([["a", 1]])).toBe(0);
  });
});

describe("scope rule for members and invitations", () => {
  it("reads need memory:read, every change memory:admin", () => {
    expect(getScopeForRequest("GET", "/workspace/members")).toBe("memory:read");
    expect(getScopeForRequest("PATCH", "/workspace/members/u1")).toBe("memory:admin");
    expect(getScopeForRequest("DELETE", "/workspace/members/u1")).toBe("memory:admin");
    expect(getScopeForRequest("POST", "/workspace/invitations")).toBe("memory:admin");
    expect(getScopeForRequest("POST", "/workspace/invitations/i1/regenerate")).toBe("memory:admin");
    expect(getScopeForRequest("DELETE", "/workspace/invitations/i1")).toBe("memory:admin");
    // Unchanged neighbours.
    expect(getScopeForRequest("POST", "/workspace-mode")).toBe("memory:admin");
    expect(getScopeForRequest("POST", "/instance/users")).toBe("admin:workspace");
  });
});
