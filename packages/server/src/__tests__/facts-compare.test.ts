// packages/server/src/__tests__/facts-compare.test.ts
//
// Migrated behavioral anchor for `POST /facts/compare` / `compareFacts`
// (docs/archive/openspec/decompose-recall-and-compare, Slice 2, design.md D4). The
// pure-logic assertions below are ported byte-for-byte from
// `packages/mcp/src/__tests__/contracts/compare.test.ts` — the 11 scenarios
// proving the docs/archive/openspec/complete-mcp-tools B6 fix (4-value `SuggestableVerb`,
// never `related`, no tags-based diff) still hold once the logic runs
// server-side against the relocated pure function. Route-level 404 and
// 200-payload-shape cases are new (task 2.6), added because the domain
// logic now sits behind a real HTTP endpoint with its own read guard.
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { compareFacts } from "../facts/compare.js";
import { createApp } from "../app.js";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps, Fact } from "../deps.js";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";

// ── Pure-logic scenarios, ported from compare.test.ts ──────────────────────

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "mfact_a",
    workspaceId: "ws_1",
    content: "User prefers dark mode",
    attribution: { source: "test" },
    tags: [],
    pinned: false,
    validFrom: "2024-01-01T00:00:00.000Z",
    validTo: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("compareFacts — Scenario: each of the 4 suggested verbs is reachable", () => {
  it("1a. supersedes — same subject, factB clearly newer (>60s apart)", () => {
    const a = makeFact({
      id: "mfact_a",
      content: "User prefers the dark editor theme",
      tags: ["editor"],
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    const b = makeFact({
      id: "mfact_b",
      content: "User prefers the light editor theme",
      tags: ["editor"],
      createdAt: "2024-01-01T00:05:00.000Z",
    });
    const parsed = compareFacts(a, b);
    expect(parsed.sameSubject).toBe(true);
    expect(parsed.suggestedVerb).toBe("supersedes");
  });

  it("1b. conflicts_with — same subject, created within the same minute", () => {
    const ts = "2024-01-01T00:00:00.000Z";
    const a = makeFact({
      id: "mfact_a",
      content: "User prefers the dark editor theme",
      tags: ["editor"],
      createdAt: ts,
    });
    const b = makeFact({
      id: "mfact_b",
      content: "User prefers the light editor theme",
      tags: ["editor"],
      createdAt: ts,
    });
    const parsed = compareFacts(a, b);
    expect(parsed.sameSubject).toBe(true);
    expect(parsed.suggestedVerb).toBe("conflicts_with");
  });

  it("1c. compatible — different subject, same open/closed state, same workspace", () => {
    const a = makeFact({
      id: "mfact_a",
      content: "User speaks fluent Spanish",
      tags: ["language"],
      validTo: null,
      workspaceId: "ws_1",
    });
    const b = makeFact({
      id: "mfact_b",
      content: "Deployment pipeline runs on Kubernetes",
      tags: ["infra"],
      validTo: null,
      workspaceId: "ws_1",
    });
    const parsed = compareFacts(a, b);
    expect(parsed.sameSubject).toBe(false);
    expect(parsed.suggestedVerb).toBe("compatible");
  });

  it("1d. scoped — different subject, one fact closed (validTo set) and the other open", () => {
    const a = makeFact({
      id: "mfact_a",
      content: "User speaks fluent Spanish",
      tags: ["language"],
      validTo: null,
      workspaceId: "ws_1",
    });
    const b = makeFact({
      id: "mfact_b",
      content: "Deployment pipeline runs on Kubernetes",
      tags: ["infra"],
      validTo: "2024-02-01T00:00:00.000Z",
      workspaceId: "ws_1",
    });
    const parsed = compareFacts(a, b);
    expect(parsed.sameSubject).toBe(false);
    expect(parsed.suggestedVerb).toBe("scoped");
  });

  it("1e. compatible (not related) — different subject, same open/closed state, DIFFERENT workspace", () => {
    // Regression for the removed `related` verb (B6): a cross-workspace pair
    // now collapses into `compatible` like every other non-scoped,
    // different-subject pair — `suggestVerb` no longer branches on
    // `workspaceId` at all.
    const a = makeFact({
      id: "mfact_a",
      content: "User speaks fluent Spanish",
      validTo: null,
      workspaceId: "ws_1",
    });
    const b = makeFact({
      id: "mfact_b",
      content: "Deployment pipeline runs on Kubernetes",
      validTo: null,
      workspaceId: "ws_2",
    });
    const parsed = compareFacts(a, b);
    expect(parsed.sameSubject).toBe(false);
    expect(parsed.suggestedVerb).toBe("compatible");
  });
});

describe("compareFacts — Scenario: same-subject detection varies with input", () => {
  it("is true for two facts clearly about the same subject (editor preference)", () => {
    const a = makeFact({
      id: "mfact_a",
      content: "User prefers the dark editor theme for coding",
      tags: [],
    });
    const b = makeFact({
      id: "mfact_b",
      content: "User prefers the dark editor theme for writing",
      tags: [],
    });
    const parsed = compareFacts(a, b);
    expect(parsed.sameSubject).toBe(true);
  });

  it("is false for two facts clearly about different subjects (editor preference vs. deploy process)", () => {
    const a = makeFact({
      id: "mfact_a",
      content: "User prefers the dark editor theme for coding",
      tags: [],
    });
    const b = makeFact({
      id: "mfact_b",
      content: "Deployment pipeline runs on Kubernetes clusters",
      tags: [],
    });
    const parsed = compareFacts(a, b);
    expect(parsed.sameSubject).toBe(false);
  });

  it("flag differs between the same-subject pair and the different-subject pair (not a constant)", () => {
    const same = compareFacts(
      makeFact({ id: "mfact_a", content: "User prefers the dark editor theme", tags: [] }),
      makeFact({ id: "mfact_b", content: "User prefers the light editor theme", tags: [] })
    );
    const different = compareFacts(
      makeFact({ id: "mfact_a", content: "User prefers the dark editor theme", tags: [] }),
      makeFact({ id: "mfact_b", content: "Deployment uses Kubernetes clusters", tags: [] })
    );
    expect(same.sameSubject).not.toBe(different.sameSubject);
  });
});

describe("compareFacts — Scenario: field differences list is complete", () => {
  it("reports every differing field, not just content", () => {
    const a = makeFact({
      id: "mfact_a",
      content: "User prefers dark mode",
      pinned: false,
      validFrom: "2024-01-01T00:00:00.000Z",
      validTo: null,
    });
    const b = makeFact({
      id: "mfact_b",
      content: "User prefers light mode",
      pinned: true,
      validFrom: "2024-03-01T00:00:00.000Z",
      validTo: "2024-06-01T00:00:00.000Z",
    });
    const parsed = compareFacts(a, b);

    const joined = parsed.differences.join(" | ");
    expect(joined).toContain("content:");
    expect(joined).toContain("pinned:");
    expect(joined).toContain("validFrom:");
    expect(joined).toContain("validTo:");
    // 4 distinct field-level entries: content, pinned, validFrom, validTo.
    // No tags entries — tags are not persisted (B6), so no tag diff is ever
    // computed regardless of what the caller passes in `tags`.
    expect(parsed.differences).toHaveLength(4);
  });

  it("never reports a tag diff even when both facts carry different tags", () => {
    // Regression for the removed tags-added/removed branch (B6): `tags` on
    // the wire `Fact` shape is accepted here only to prove it is inert —
    // the real fact-fetch API always returns `tags: []` (mnemo_fact has no
    // tags column), and compareFacts no longer even looks at the field.
    const a = makeFact({ id: "mfact_a", tags: ["old-tag"] });
    const b = makeFact({ id: "mfact_b", tags: ["new-tag"] });
    const parsed = compareFacts(a, b);
    const joined = parsed.differences.join(" | ");
    expect(joined).not.toMatch(/tags added/);
    expect(joined).not.toMatch(/tags removed/);
  });

  it("reports the identical-facts placeholder only when truly nothing differs", () => {
    const a = makeFact({ id: "mfact_a" });
    const b = makeFact({ id: "mfact_b" });
    const parsed = compareFacts(a, b);
    expect(parsed.differences).toEqual([
      "No field differences detected (content and metadata are identical).",
    ]);
  });
});

// ── Route-level: POST /facts/compare ────────────────────────────────────────

const PLAINTEXT_KEY = "mns_live_factscompareroutetest001";
const WS_ID = "00000000-0000-0000-0000-cc0000000001";

async function makeKeyLookup(maxSensitivity = "restricted"): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      {
        id: "key-facts-compare",
        keyHash,
        workspaceId: WS_ID,
        // POST /facts/compare has no dedicated `app-scope.ts` rule (same as
        // POST /topic-key/suggest) — it falls through to the generic
        // POST/PATCH/PUT → memory:write branch even though it performs no
        // writes, so the test key needs memory:write, not just memory:read.
        scopes: ["memory:read", "memory:write", "memory:admin"],
        maxSensitivity,
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json" };
}

function makeCoreDeps() {
  return {} as unknown as ServerDeps["core"];
}

async function buildApp(maxSensitivity = "restricted") {
  const storage = new InMemoryStorageAdapter();
  const deps = {
    core: makeCoreDeps(),
    apiKeys: await makeKeyLookup(maxSensitivity),
    storage,
  } as unknown as ServerDeps;
  const app = createApp({ deps, version: "0.0.0-test" });
  return { app, storage };
}

describe("POST /facts/compare — route", () => {
  it("returns 200 with the full comparison payload shape", async () => {
    const { app, storage } = await buildApp();
    const factA = await storage.createFact({
      workspaceId: WS_ID,
      scope: "global",
      statement: "User prefers the dark editor theme",
      subject: "editor theme",
      kind: "preference",
      sensitivity: "internal",
    });
    const factB = await storage.createFact({
      workspaceId: WS_ID,
      scope: "global",
      statement: "User prefers the light editor theme",
      subject: "editor theme",
      kind: "preference",
      sensitivity: "internal",
    });

    const res = await app.request("/facts/compare", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ factIdA: factA.id, factIdB: factB.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      factA: { id: string };
      factB: { id: string };
      differences: string[];
      suggestedVerb: string;
      sameSubject: boolean;
    };
    expect(body.factA.id).toBe(factA.id);
    expect(body.factB.id).toBe(factB.id);
    expect(body.sameSubject).toBe(true);
    expect(["supersedes", "conflicts_with", "compatible", "scoped"]).toContain(body.suggestedVerb);
    expect(Array.isArray(body.differences)).toBe(true);
  });

  it("returns 404 when factIdA does not exist", async () => {
    const { app, storage } = await buildApp();
    const factB = await storage.createFact({
      workspaceId: WS_ID,
      scope: "global",
      statement: "x",
      subject: "x",
      kind: "other",
    });
    const res = await app.request("/facts/compare", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ factIdA: "mfact_does_not_exist", factIdB: factB.id }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when factIdB does not exist", async () => {
    const { app, storage } = await buildApp();
    const factA = await storage.createFact({
      workspaceId: WS_ID,
      scope: "global",
      statement: "x",
      subject: "x",
      kind: "other",
    });
    const res = await app.request("/facts/compare", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ factIdA: factA.id, factIdB: "mfact_does_not_exist" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when factIdA is above the caller's sensitivity ceiling (anti-probing, not 403)", async () => {
    const { app, storage } = await buildApp("internal");
    const factA = await storage.createFact({
      workspaceId: WS_ID,
      scope: "global",
      statement: "x",
      subject: "x",
      kind: "other",
      sensitivity: "restricted",
    });
    const factB = await storage.createFact({
      workspaceId: WS_ID,
      scope: "global",
      statement: "y",
      subject: "y",
      kind: "other",
      sensitivity: "internal",
    });
    const res = await app.request("/facts/compare", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ factIdA: factA.id, factIdB: factB.id }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("returns 404 when factIdB was forgotten (validTo closed)", async () => {
    const { app, storage } = await buildApp();
    const factA = await storage.createFact({
      workspaceId: WS_ID,
      scope: "global",
      statement: "x",
      subject: "x",
      kind: "other",
    });
    const factB = await storage.createFact({
      workspaceId: WS_ID,
      scope: "global",
      statement: "y",
      subject: "y",
      kind: "other",
    });
    await storage.archiveFact(factB.id, WS_ID);
    const res = await app.request("/facts/compare", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ factIdA: factA.id, factIdB: factB.id }),
    });
    expect(res.status).toBe(404);
  });
});
