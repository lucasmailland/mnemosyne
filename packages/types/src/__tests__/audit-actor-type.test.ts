/**
 * resolveAuditActorType — the §6 Audit Trail actor_type resolution.
 *
 * Regression target: before this, DrizzleStorageAdapter.appendAuditEntry
 * hardcoded actor_type='user' on every insert, collapsing the
 * agent/user/system/federation distinction the threat model relies on
 * (insider-access detection + federation-sync provenance).
 */
import { describe, it, expect } from "vitest";
import { resolveAuditActorType } from "../audit.js";

describe("resolveAuditActorType", () => {
  it("preserves an explicit federation-origin actor_type", () => {
    expect(
      resolveAuditActorType({ actorType: "federation", actorId: "peer-eu-1" }),
    ).toBe("federation");
  });

  it("preserves an explicit agent-origin actor_type", () => {
    expect(
      resolveAuditActorType({ actorType: "agent", actorId: "agent-42" }),
    ).toBe("agent");
  });

  it("preserves an explicit system-origin actor_type even without an actorId", () => {
    expect(resolveAuditActorType({ actorType: "system" })).toBe("system");
  });

  it("preserves an explicit user-origin actor_type", () => {
    expect(
      resolveAuditActorType({ actorType: "user", actorId: "u-7" }),
    ).toBe("user");
  });

  it("falls back to 'user' when actorType is absent but an actorId is present (back-compat)", () => {
    expect(resolveAuditActorType({ actorId: "legacy-actor" })).toBe("user");
  });

  it("falls back to 'system' when neither actorType nor actorId is present", () => {
    expect(resolveAuditActorType({})).toBe("system");
  });

  it("treats an explicit actorType as authoritative over the actorId heuristic", () => {
    // actorId present would otherwise default to 'user'; explicit 'federation' wins.
    expect(
      resolveAuditActorType({ actorType: "federation", actorId: "anything" }),
    ).toBe("federation");
  });
});
