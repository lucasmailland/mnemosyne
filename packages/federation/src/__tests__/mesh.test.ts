import { describe, it, expect } from "vitest";
import { FederationMesh } from "../mesh.js";

describe("FederationMesh — §20 announce/discovery (lines 1558–1565)", () => {
  it("registers an announce and lists it back", () => {
    const mesh = new FederationMesh();
    mesh.announce({ instanceId: "inst-a", capabilities: ["recall", "facts"], publicKey: "PK_A" });
    expect(mesh.list().map((p) => p.instanceId)).toEqual(["inst-a"]);
    expect(mesh.get("inst-a")?.capabilities).toEqual(["recall", "facts"]);
  });

  it("upserts on re-announce (new key/caps replace old, announcedAt updated)", () => {
    const mesh = new FederationMesh();
    mesh.announce({ instanceId: "inst-a", capabilities: ["recall"], publicKey: "PK_OLD" });
    mesh.announce({ instanceId: "inst-a", capabilities: ["recall", "events"], publicKey: "PK_NEW" });
    expect(mesh.list()).toHaveLength(1);
    expect(mesh.get("inst-a")?.publicKey).toBe("PK_NEW");
    expect(mesh.get("inst-a")?.capabilities).toEqual(["recall", "events"]);
  });

  it("filters peers by capability", () => {
    const mesh = new FederationMesh();
    mesh.announce({ instanceId: "a", capabilities: ["recall"], publicKey: "P1" });
    mesh.announce({ instanceId: "b", capabilities: ["recall", "events"], publicKey: "P2" });
    expect(mesh.withCapability("events").map((p) => p.instanceId)).toEqual(["b"]);
  });

  it("rejects an announce missing instanceId or publicKey", () => {
    const mesh = new FederationMesh();
    expect(() => mesh.announce({ instanceId: "", capabilities: [], publicKey: "P" })).toThrow();
    expect(() => mesh.announce({ instanceId: "x", capabilities: [], publicKey: "" })).toThrow();
  });
});
