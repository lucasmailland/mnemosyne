/**
 * Task 1.4 — UUID workspace guard.
 *
 * isWorkspaceId() must accept valid UUIDs and reject legacy cuid / arbitrary
 * strings that would cause a Postgres ::uuid cast error (and HTTP 500) if
 * they ever reached RlsMiddleware.
 */
import { describe, it, expect } from "vitest";
import { isWorkspaceId } from "@mnemo-ai/types";

describe("isWorkspaceId", () => {
  it("accepts a canonical UUID v4", () => {
    expect(isWorkspaceId("bd293fa7-cc0d-4773-b3c4-c241599b109b")).toBe(true);
  });

  it("accepts a UUID v1", () => {
    expect(isWorkspaceId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("accepts uppercase UUID", () => {
    expect(isWorkspaceId("BD293FA7-CC0D-4773-B3C4-C241599B109B")).toBe(true);
  });

  it("rejects legacy cuid (tvlds3k623us6sz7zp2ek6gh)", () => {
    expect(isWorkspaceId("tvlds3k623us6sz7zp2ek6gh")).toBe(false);
  });

  it("rejects ws_default", () => {
    expect(isWorkspaceId("ws_default")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isWorkspaceId("")).toBe(false);
  });

  it("rejects UUID without dashes", () => {
    expect(isWorkspaceId("bd293fa7cc0d4773b3c4c241599b109b")).toBe(false);
  });

  it("rejects partial UUID", () => {
    expect(isWorkspaceId("bd293fa7-cc0d-4773-b3c4")).toBe(false);
  });
});
