import { describe, it, expect } from "vitest";
import { resolveActorDek } from "../../encryption/dek-resolver.js";

describe("resolveActorDek — C1 fail-closed", () => {
  const ws = "11111111-1111-1111-1111-111111111111";
  const actor = "actor-1";

  it("returns the existing DEK when one is already wrapped", () => {
    const dek = Buffer.alloc(32, 7);
    const r = resolveActorDek({
      sensitivity: "confidential",
      actorId: actor,
      workspaceId: ws,
      existingWrapped: "d3JhcHBlZA==",
      unwrap: () => dek,
      provision: () => { throw new Error("should not provision"); },
    });
    expect(r.dek).toBe(dek);
    expect(r.provisioned).toBe(false);
  });

  it("provisions a new DEK when none exists for a confidential write", () => {
    const dek = Buffer.alloc(32, 9);
    const r = resolveActorDek({
      sensitivity: "restricted",
      actorId: actor,
      workspaceId: ws,
      existingWrapped: null,
      unwrap: () => { throw new Error("nothing to unwrap"); },
      provision: () => dek,
    });
    expect(r.dek).toBe(dek);
    expect(r.provisioned).toBe(true);
  });

  it("FAILS CLOSED: throws when confidential+ and no DEK can be obtained", () => {
    expect(() =>
      resolveActorDek({
        sensitivity: "confidential",
        actorId: actor,
        workspaceId: ws,
        existingWrapped: null,
        unwrap: () => { throw new Error("nope"); },
        provision: () => null,
      }),
    ).toThrowError(/fail-closed|cannot encrypt|no DEK/i);
  });

  it("APP-073: the refusal carries a stable code the HTTP layer can map", () => {
    let thrown: unknown;
    try {
      resolveActorDek({
        sensitivity: "restricted",
        actorId: actor,
        workspaceId: ws,
        existingWrapped: null,
        unwrap: () => { throw new Error("nope"); },
        provision: () => null,
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string }).code).toBe("encryption_not_configured");
  });

  it("returns null DEK (plaintext OK) for internal sensitivity", () => {
    const r = resolveActorDek({
      sensitivity: "internal",
      actorId: actor,
      workspaceId: ws,
      existingWrapped: null,
      unwrap: () => { throw new Error("n/a"); },
      provision: () => { throw new Error("n/a"); },
    });
    expect(r.dek).toBeNull();
    expect(r.provisioned).toBe(false);
  });
});
