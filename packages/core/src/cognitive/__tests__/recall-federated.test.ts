import { describe, expect, it, vi } from "vitest";
import type {
  AuthContext,
  FederatedRecallCandidate,
  RecallHit,
  RecallQuery,
  RecallResponse,
} from "@mnemo-ai/types";
import { withFederatedHits } from "../recall-federated.js";

const auth = { workspaceId: "ws", scopes: ["memory:read"] } as unknown as AuthContext;

const item = (over: Partial<FederatedRecallCandidate> = {}): FederatedRecallCandidate => ({
  id: "fed-1",
  peerDomain: "acme.example",
  statement: "Acme ships larkspur orders on Fridays.",
  sensitivity: "internal",
  validFrom: "2026-01-01T00:00:00.000Z",
  validTo: null,
  lexicalRank: 0.1,
  ...over,
});

const local = { id: "local-1", primitive: "fact", score: 0.8 } as RecallHit;

function response(nothingRelevant: boolean, hits: RecallHit[] = [local]): RecallResponse {
  return {
    hits,
    total: hits.length,
    query: { text: "larkspur orders", limit: 2, offset: 0 },
    latencyMs: 0,
    fromHotTier: false,
    nothingRelevant,
  };
}

function setup(rows: FederatedRecallCandidate[]) {
  const lookup = vi.fn(async () => rows);
  const ctx = {
    storage: { federatedRecallCandidates: lookup },
    config: {},
    logger: { warn: vi.fn() },
  } as never;
  return { ctx, lookup };
}

const query = (over: Partial<RecallQuery> = {}): RecallQuery => ({
  workspaceId: "ws",
  text: "larkspur orders",
  includeFederated: true,
  ...over,
});

describe("withFederatedHits", () => {
  it("adds federated items after relevant local hits, marked, at the caller's tiers", async () => {
    const { ctx, lookup } = setup([item()]);
    const resp = await withFederatedHits(ctx, query(), auth, response(false));

    expect(lookup).toHaveBeenCalledWith({
      workspaceId: "ws",
      terms: ["larkspur", "orders"],
      limit: 2,
      sensitivity: ["public", "internal"],
    });
    expect(resp.hits.map((h) => h.id)).toEqual(["local-1", "fed-1"]);
    expect(resp.hits[1]).toMatchObject({
      primitive: "fact",
      content: "Acme ships larkspur orders on Fridays.",
      provenance: "federation_received",
      origin: "federation:acme.example",
      sensitivity: "internal",
      validTo: null,
    });
    expect(resp.nothingRelevant).toBe(false);
  });

  it("puts them first when recall judged nothing local relevant, within the limit", async () => {
    const { ctx } = setup([item(), item({ id: "fed-2" })]);
    const resp = await withFederatedHits(ctx, query(), auth, response(true));
    expect(resp.hits.map((h) => h.id)).toEqual(["fed-1", "fed-2"]);
    expect(resp.nothingRelevant).toBe(false);
  });

  it.each([
    ["a surface that did not ask for them", { includeFederated: undefined }],
    ["strict semantic mode", { mode: "semantic" as const }],
    ["a later page", { offset: 5 }],
    ["kinds without fact", { filter: { kinds: ["decision" as const] } }],
    ["a scopeRef filter", { filter: { scopeRef: "project:acme" } }],
    ["an owner filter", { filter: { scopeOwner: "user:u1" } }],
    [
      "a provenance filter without federation",
      { filter: { provenance: ["user_stated" as const] } },
    ],
  ])("is skipped for %s", async (_name, over) => {
    const { ctx, lookup } = setup([item()]);
    const before = response(true);
    expect(await withFederatedHits(ctx, query(over), auth, before)).toBe(before);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("asOf keeps only items valid then, and drops an unreadable window", async () => {
    const { ctx } = setup([
      item({ id: "later", validFrom: "2026-06-01T00:00:00.000Z" }),
      item({ id: "closed", validTo: "2026-02-01T00:00:00.000Z" }),
      item({ id: "garbage", validFrom: "not a date" }),
      item({ id: "held" }),
    ]);
    const resp = await withFederatedHits(
      ctx,
      query({ asOf: new Date("2026-03-01T00:00:00.000Z") }),
      auth,
      response(true, [])
    );
    expect(resp.hits.map((h) => h.id)).toEqual(["held"]);
  });

  it("a failing store leaves the local answer as it was", async () => {
    const ctx = {
      storage: { federatedRecallCandidates: vi.fn(async () => Promise.reject(new Error("down"))) },
      config: {},
      logger: { warn: vi.fn() },
    } as never;
    const before = response(false);
    expect(await withFederatedHits(ctx, query(), auth, before)).toBe(before);
  });
});
