import { describe, it, expect } from "vitest";
import { sensitivityAllowed, viewFact } from "../recall-cold.js";
import { SENSITIVITY_ORDER, type AuthContext, type MnemoFact, type Sensitivity } from "@mnemo-ai/types";

// §17/§5 regression: the cold-tier view MUST propagate the fact's real stored
// sensitivity. Previously it hardcoded "internal", leaking confidential/restricted
// facts past the cold-path sensitivity ceiling to non-admin callers.
function fact(sensitivity: MnemoFact["sensitivity"]): MnemoFact {
  return {
    id: "f1", workspaceId: "ws", statement: "s", kind: "fact",
    sensitivity, worth: 0.8, worthAlpha: 20, worthBeta: 5,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  } as unknown as MnemoFact;
}

describe("§17 cold-tier view propagates real sensitivity (no hardcoded internal)", () => {
  it.each(["public", "internal", "confidential", "restricted"] as const)(
    "preserves sensitivity=%s",
    (s) => {
      expect(viewFact(fact(s)).sensitivity).toBe(s);
    },
  );

  it("does not silently downgrade a restricted fact to internal", () => {
    expect(viewFact(fact("restricted")).sensitivity).not.toBe("internal");
  });
});

describe("effective recall sensitivity ceiling", () => {
  const sensitivities = Object.keys(SENSITIVITY_ORDER) as Sensitivity[];
  const cases: Array<{
    name: string;
    scopes: AuthContext["scopes"];
    maxSensitivity?: Sensitivity;
    effectiveCeiling: Sensitivity;
  }> = [
    { name: "read scope", scopes: ["memory:read"], effectiveCeiling: "internal" },
    { name: "admin scope", scopes: ["memory:admin"], effectiveCeiling: "restricted" },
    { name: "read scope with public ceiling", scopes: ["memory:read"], maxSensitivity: "public", effectiveCeiling: "public" },
    { name: "admin scope with internal ceiling", scopes: ["memory:admin"], maxSensitivity: "internal", effectiveCeiling: "internal" },
    { name: "read scope with higher confidential ceiling", scopes: ["memory:read"], maxSensitivity: "confidential", effectiveCeiling: "internal" },
    { name: "admin scope with restricted ceiling", scopes: ["memory:admin"], maxSensitivity: "restricted", effectiveCeiling: "restricted" },
  ];

  it.each(cases)("uses the lower numeric ceiling for $name", ({ scopes, maxSensitivity, effectiveCeiling }) => {
    const auth: AuthContext = {
      workspaceId: "ws",
      actorId: "actor",
      actorType: "agent",
      scopes,
      ...(maxSensitivity ? { maxSensitivity } : {}),
    };

    for (const sensitivity of sensitivities) {
      expect(sensitivityAllowed(sensitivity, auth)).toBe(
        SENSITIVITY_ORDER[sensitivity] <= SENSITIVITY_ORDER[effectiveCeiling],
      );
    }
  });
});
