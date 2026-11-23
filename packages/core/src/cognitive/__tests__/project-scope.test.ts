import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { resolveProjectScopeRef } from "../project-scope.js";

const WS = "ws-p";

async function withProjects(
  projects: Array<{ name: string; aliases?: string[]; kind?: "project" | "organization" }>
) {
  const storage = new InMemoryStorageAdapter();
  const created = [];
  for (const p of projects) {
    created.push(
      await storage.createEntity({
        workspaceId: WS,
        name: p.name,
        kind: p.kind ?? "project",
        aliases: p.aliases ?? [],
      })
    );
  }
  return { storage, created };
}

describe("resolveProjectScopeRef (P135)", () => {
  it("leaves the value alone when the workspace has no project entities", async () => {
    const { storage } = await withProjects([{ name: "Acme", kind: "organization" }]);
    const r = await resolveProjectScopeRef(storage, WS, "acme");
    expect(r).toEqual({ scopeRef: "acme", aliases: [] });
  });

  it("canonicalizes the project's own name regardless of case and surrounding space", async () => {
    const { storage, created } = await withProjects([{ name: "acme", aliases: ["Acme HR"] }]);
    const r = await resolveProjectScopeRef(storage, WS, "  ACME ");
    expect(r.scopeRef).toBe("acme");
    expect(r.aliases).toEqual(["Acme HR"]);
    expect(r.canonicalized).toEqual({
      received: "  ACME ",
      storedAs: "acme",
      entityId: created[0]!.id,
    });
    expect(r.suggestion).toBeUndefined();
  });

  it("maps an alias onto the canonical name and lists every other spelling", async () => {
    const { storage } = await withProjects([{ name: "acme", aliases: ["Acme", "acme-hr"] }]);
    const r = await resolveProjectScopeRef(storage, WS, "acme-hr");
    expect(r.scopeRef).toBe("acme");
    expect(r.aliases.sort()).toEqual(["Acme", "acme-hr"]);
    expect(r.canonicalized?.storedAs).toBe("acme");
  });

  it("reports no canonicalization when the value already is the canonical name", async () => {
    const { storage } = await withProjects([{ name: "orchester", aliases: ["Orchester"] }]);
    const r = await resolveProjectScopeRef(storage, WS, "orchester");
    expect(r.scopeRef).toBe("orchester");
    expect(r.aliases).toEqual(["Orchester"]);
    expect(r.canonicalized).toBeUndefined();
  });

  it("prefers a project's own name over another project's alias", async () => {
    const { storage } = await withProjects([
      { name: "billing", aliases: ["payments"] },
      { name: "payments" },
    ]);
    const r = await resolveProjectScopeRef(storage, WS, "Payments");
    expect(r.scopeRef).toBe("payments");
  });

  it("suggests a project that differs only in punctuation, and stores the value unchanged", async () => {
    const { storage, created } = await withProjects([{ name: "acme-integrations" }]);
    const r = await resolveProjectScopeRef(storage, WS, "acme_integrations");
    expect(r.scopeRef).toBe("acme_integrations");
    expect(r.aliases).toEqual([]);
    expect(r.canonicalized).toBeUndefined();
    expect(r.suggestion).toEqual({
      received: "acme_integrations",
      project: "acme-integrations",
      entityId: created[0]!.id,
    });
  });

  it("suggests a project within two edits, but not for short names", async () => {
    const { storage } = await withProjects([{ name: "mnemosyne" }, { name: "web" }]);
    expect((await resolveProjectScopeRef(storage, WS, "mnemosine")).suggestion?.project).toBe(
      "mnemosyne"
    );
    expect((await resolveProjectScopeRef(storage, WS, "wbe")).suggestion).toBeUndefined();
    expect((await resolveProjectScopeRef(storage, WS, "aurora")).suggestion).toBeUndefined();
  });

  it("ignores closed project entities", async () => {
    const { storage, created } = await withProjects([{ name: "legacy" }]);
    await storage.archiveEntity(created[0]!.id, WS);
    const r = await resolveProjectScopeRef(storage, WS, "Legacy");
    expect(r).toEqual({ scopeRef: "Legacy", aliases: [] });
  });

  it("does not see another workspace's projects", async () => {
    const { storage } = await withProjects([{ name: "acme" }]);
    const r = await resolveProjectScopeRef(storage, "ws-other", "Acme");
    expect(r).toEqual({ scopeRef: "Acme", aliases: [] });
  });

  it("degrades to the raw value when the entity read fails", async () => {
    const warned: unknown[] = [];
    const storage = {
      queryEntities: async () => {
        throw new Error("db down");
      },
    };
    const r = await resolveProjectScopeRef(storage as never, WS, "Acme", {
      warn: (msg) => warned.push(msg),
    });
    expect(r).toEqual({ scopeRef: "Acme", aliases: [] });
    expect(warned).toHaveLength(1);
  });
});
