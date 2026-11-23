import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MnemosyneAPIError, MnemosyneClient, MnemosyneTimeoutError } from "../index.js";
import { HttpClient } from "../http.js";
import type { SelfEditResponse } from "../index.js";

/**
 * Why msw and not a hand-rolled mock fetch:
 *   - msw intercepts at the network layer (whatever-fetch the SDK
 *     ends up using), so we test the SDK's REAL request behavior
 *     (headers, JSON body, URL shape) — not a paraphrase of it.
 *   - The same handlers can be reused in integration tests later.
 *
 * The "happy path" recall test is intentionally minimal — its job is
 * to assert that the wire contract works end-to-end through the SDK.
 * Edge-case coverage (retry, timeout, error parsing) belongs in
 * dedicated test files we'll add when the server contract stabilizes.
 */

const server = setupServer(
  http.post("https://memory.test/recall", async ({ request }) => {
    // Validate the SDK is sending what the server expects.
    const auth = request.headers.get("authorization");
    if (auth !== "Bearer test-key") {
      return HttpResponse.json({ error: { message: "unauthorized" } }, { status: 401 });
    }
    const body = (await request.json()) as { query?: string; topK?: number };
    if (!body.query) {
      return HttpResponse.json({ error: { message: "query required" } }, { status: 400 });
    }
    return HttpResponse.json({
      hits: [
        {
          id: "fact_1",
          content: "Prefiere comunicación en español.",
          score: 0.91,
          lexicalScore: 0.4,
          vectorScore: 0.91,
          validFrom: "2026-06-01T12:00:00.000Z",
          validTo: null,
          attribution: { source: "user_stated" },
          tags: ["preference"],
        },
      ],
      debug: { embedded: true, latencyMs: 12 },
    });
  })
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("MnemosyneClient.recall", () => {
  it("keeps the timeout active while reading the response body", async () => {
    const httpClient = new HttpClient({
      baseUrl: "https://memory.test",
      apiKey: "test-key",
      timeoutMs: 5,
      retry: { attempts: 1 },
      userAgent: "test",
      fetchImpl: (async (_url, init) =>
        ({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) =>
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              })
            ),
        }) as Response) as typeof fetch,
    });
    const error = await httpClient
      .request({ method: "GET", path: "/health" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MnemosyneTimeoutError);
  });
  it("does not retry malformed successful JSON", async () => {
    let attempts = 0;
    const httpClient = new HttpClient({
      baseUrl: "https://memory.test",
      apiKey: "test-key",
      timeoutMs: 100,
      retry: { attempts: 3, initialDelayMs: 1 },
      userAgent: "test",
      fetchImpl: (async () => {
        attempts++;
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("bad json");
          },
        } as unknown as Response;
      }) as typeof fetch,
    });
    await httpClient.request({ method: "GET", path: "/health" }).catch(() => undefined);
    expect(attempts).toBe(1);
  });
  it("exposes canonical validation metadata and legacy issues", async () => {
    server.use(
      http.post("https://memory.test/recall", () =>
        HttpResponse.json(
          {
            error: {
              code: "validation_error",
              message: "query: required",
              request_id: "req-1",
              retryable: false,
              details: { issues: [{ path: "query", message: "required" }] },
            },
          },
          { status: 400 }
        )
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const error = await client.recall({ query: "x" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "validation_error",
      requestId: "req-1",
      retryable: false,
      details: { issues: [{ path: "query" }] },
    });
  });

  it("does not replay an unkeyed PATCH after a server error", async () => {
    let attempts = 0;
    server.use(
      http.patch("https://memory.test/facts/f-1", () => {
        attempts++;
        return HttpResponse.json(
          { error: { code: "internal_error", message: "failed" } },
          { status: 500 }
        );
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const error = await client
      .patchFact("f-1", { statement: "changed" })
      .catch((caught: unknown) => caught);
    expect(attempts).toBe(1);
    expect(error).toMatchObject({ outcomeUnknown: true });
  });
  it("replays a keyed mutation after a 503", async () => {
    let attempts = 0;
    const keys: (string | null)[] = [];
    server.use(
      http.delete("https://memory.test/facts/f-1", ({ request }) => {
        attempts++;
        keys.push(request.headers.get("idempotency-key"));
        if (attempts < 3) {
          return HttpResponse.json({ error: { message: "unavailable" } }, { status: 503 });
        }
        return new HttpResponse(null, { status: 204 });
      })
    );
    const client = new MnemosyneClient({
      url: "https://memory.test",
      apiKey: "test-key",
      retry: { attempts: 3, initialDelayMs: 1 },
    });
    await client.forgetFact("f-1", undefined, "key-1");
    expect(attempts).toBe(3);
    expect(keys).toEqual(["key-1", "key-1", "key-1"]);
  });

  it("marks a keyed mutation outcomeUnknown when it times out after committing", async () => {
    const httpClient = new HttpClient({
      baseUrl: "https://memory.test",
      apiKey: "test-key",
      timeoutMs: 5,
      retry: { attempts: 1 },
      userAgent: "test",
      fetchImpl: (async (_url, init) =>
        ({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) =>
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              })
            ),
        }) as Response) as typeof fetch,
    });
    const error = await httpClient
      .request({
        method: "POST",
        path: "/remember",
        body: { statement: "x" },
        extraHeaders: { "Idempotency-Key": "k" },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MnemosyneTimeoutError);
    expect(error).toMatchObject({ outcomeUnknown: true });
  });
  it("exposes Retry-After as retryAfterSeconds on a mutation 429", async () => {
    server.use(
      http.patch("https://memory.test/facts/f-1", () =>
        HttpResponse.json(
          { error: { code: "rate_limited", message: "wait" } },
          { status: 429, headers: { "Retry-After": "7" } }
        )
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const error = await client
      .patchFact("f-1", { statement: "x" })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: 7 });
  });

  it("retries 429 recall using Retry-After and preserves the hint on failure", async () => {
    let attempts = 0;
    server.use(
      http.post("https://memory.test/recall", () => {
        attempts++;
        if (attempts === 1)
          return HttpResponse.json(
            { error: { code: "rate_limited", message: "wait", retryable: true } },
            { status: 429, headers: { "Retry-After": "0.02" } }
          );
        return HttpResponse.json({ hits: [], debug: {} });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const started = Date.now(); // determinism-ok: measures elapsed wall time for a latency bound
    await client.recall({ query: "x" });
    expect(attempts).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(18); // determinism-ok: measures elapsed wall time for a latency bound
  });
  it("honors a server retryable false hint", async () => {
    let attempts = 0;
    server.use(
      http.post("https://memory.test/recall", () => {
        attempts++;
        return HttpResponse.json(
          { error: { code: "internal_error", message: "failed", retryable: false } },
          { status: 500 }
        );
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    await client.recall({ query: "x" }).catch(() => undefined);
    expect(attempts).toBe(1);
  });
  it("returns hits for a basic query", async () => {
    const client = new MnemosyneClient({
      url: "https://memory.test",
      apiKey: "test-key",
    });

    const result = await client.recall({ query: "preferencias del usuario", topK: 5 });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.id).toBe("fact_1");
    expect(result.hits[0]?.content).toBe("Prefiere comunicación en español.");
    expect(result.hits[0]?.score).toBeCloseTo(0.91);
    expect(result.debug?.embedded).toBe(true);
  });
});

describe("MnemosyneClient.triggerConsolidation", () => {
  it("preserves the canonical 422 status and code", async () => {
    server.use(
      http.post("https://memory.test/consolidation/trigger", () =>
        HttpResponse.json(
          {
            error: {
              type: "invalid_request_error",
              code: "dry_run_not_supported",
              message: "Consolidation dry-run is not supported yet; no changes were made.",
            },
          },
          { status: 422 }
        )
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });

    const error = await client
      .triggerConsolidation({ dryRun: true })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MnemosyneAPIError);
    expect(error).toMatchObject({
      status: 422,
      code: "dry_run_not_supported",
    });
  });
});

describe("MnemosyneClient.tasks", () => {
  it("listTasks calls GET /tasks with query params", async () => {
    let seenUrl = "";
    server.use(
      http.get("https://memory.test/tasks", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ items: [], total: 0, offset: 0, limit: 50, hasMore: false });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    await client.listTasks({ status: "pending" });
    expect(seenUrl).toContain("status=pending");
  });

  it("createTask calls POST /tasks with body", async () => {
    let seenBody: unknown;
    server.use(
      http.post("https://memory.test/tasks", async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.json({ id: "t-1" }, { status: 201 });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    await client.createTask({ title: "Ship", assignedTo: "agent-1" });
    expect((seenBody as { title: string }).title).toBe("Ship");
  });
});

describe("MnemosyneClient.listRelations — endpoint filters (CLIENTS-8)", () => {
  it("forwards sourceId, targetId and includeClosed to GET /relations", async () => {
    let seen: URL | undefined;
    server.use(
      http.get("https://memory.test/relations", ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({ items: [] });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    await client.listRelations({
      sourceId: "fact-x",
      targetId: "fact-y",
      includeClosed: true,
      judgmentStatus: "pending",
      limit: 7,
    });
    expect(seen?.searchParams.get("sourceId")).toBe("fact-x");
    expect(seen?.searchParams.get("targetId")).toBe("fact-y");
    expect(seen?.searchParams.get("includeClosed")).toBe("true");
    expect(seen?.searchParams.get("judgmentStatus")).toBe("pending");
    expect(seen?.searchParams.get("limit")).toBe("7");
  });

  it("sends no endpoint filter when none is given", async () => {
    let seen: URL | undefined;
    server.use(
      http.get("https://memory.test/relations", ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({ items: [] });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    await client.listRelations();
    expect(seen?.searchParams.has("sourceId")).toBe(false);
    expect(seen?.searchParams.has("targetId")).toBe(false);
    expect(seen?.searchParams.has("includeClosed")).toBe(false);
  });
});

describe("MnemosyneClient.getFact — includeClosed / provenance", () => {
  it("sends each flag only when it is true", async () => {
    const seen: URL[] = [];
    server.use(
      http.get("https://memory.test/facts/f-1", ({ request }) => {
        seen.push(new URL(request.url));
        return HttpResponse.json({ id: "f-1" });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    await client.getFact("f-1");
    await client.getFact("f-1", undefined, { includeClosed: true, provenance: true });
    await client.getFact("f-1", undefined, { includeClosed: false });
    expect(seen.map((u) => u.search)).toEqual(["", "?includeClosed=true&provenance=true", ""]);
  });
});

// APP-019: a closed decision is asked for the way a closed fact is.
describe("MnemosyneClient.getDecision — includeClosed", () => {
  it("sends includeClosed only when it is true", async () => {
    const seen: URL[] = [];
    server.use(
      http.get("https://memory.test/decisions/d-1", ({ request }) => {
        seen.push(new URL(request.url));
        return HttpResponse.json({ id: "d-1" });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    await client.getDecision("d-1");
    await client.getDecision("d-1", undefined, { includeClosed: true });
    expect(seen.map((u) => u.search)).toEqual(["", "?includeClosed=true"]);
  });
});

// APP-013: /reasoning/record stores the requested tier.
describe("MnemosyneClient.recordReasoning — sensitivity", () => {
  it("sends it in the body", async () => {
    let body: unknown;
    server.use(
      http.post("https://memory.test/reasoning/record", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: "r-1" });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    await client.recordReasoning({
      question: "q",
      chain: [{ step: 1, reasoning: "r" }],
      conclusion: "c",
      sensitivity: "restricted",
    });
    expect(body).toMatchObject({ sensitivity: "restricted" });
  });
});

describe("MnemosyneClient.suggestTopicKey — attribute (AGENTSIM-5)", () => {
  it("sends attribute and types the subject+attribute source", async () => {
    let seenBody: unknown;
    server.use(
      http.post("https://memory.test/topic-key/suggest", async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.json({
          topicKey: "payments-api/deploy-method",
          levels: ["payments-api", "deploy-method"],
          source: "subject+attribute",
        });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const out = await client.suggestTopicKey({
      subject: "payments-api",
      body: "deploys with ArgoCD",
      attribute: "deploy method",
    });
    expect(seenBody).toEqual({
      subject: "payments-api",
      body: "deploys with ArgoCD",
      attribute: "deploy method",
    });
    const source: "subject+attribute" | "attribute" | string = out.source;
    expect(source).toBe("subject+attribute");
  });
});

describe("MnemosyneClient.events", () => {
  it("createEvent calls POST /events with body", async () => {
    let seenBody: unknown;
    server.use(
      http.post("https://memory.test/events", async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.json({ id: "e-1" }, { status: 201 });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    await client.createEvent({
      type: "user",
      name: "x",
      description: "y",
      occurredAt: new Date(0).toISOString(),
      source: "test",
    });
    expect((seenBody as { name: string }).name).toBe("x");
  });

  it("listEvents calls GET /events with source filter", async () => {
    let seenUrl = "";
    server.use(
      http.get("https://memory.test/events", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ items: [], total: 0, offset: 0, limit: 25, hasMore: false });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    await client.listEvents({ source: "agent" });
    expect(seenUrl).toContain("source=agent");
  });

  it("updateEventSensitivity calls PATCH /events/:id/sensitivity with body", async () => {
    let seenBody: unknown;
    server.use(
      http.patch("https://memory.test/events/e-1/sensitivity", async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.json({ id: "e-1", sensitivity: "confidential" });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.updateEventSensitivity("e-1", { sensitivity: "confidential" });
    expect((seenBody as { sensitivity: string }).sensitivity).toBe("confidential");
    expect(result.sensitivity).toBe("confidential");
  });
});

describe("MnemosyneClient.entities — link/unlink user", () => {
  it("linkEntityUser calls POST /entities/:id/link-user with { userId } body", async () => {
    let seenBody: unknown;
    server.use(
      http.post("https://memory.test/entities/ment_1/link-user", async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.json({
          id: "ment_1",
          name: "Ada Lovelace",
          kind: "person",
          linkedUserId: "user-1",
        });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.linkEntityUser("ment_1", { userId: "user-1" });
    expect(seenBody).toEqual({ userId: "user-1" });
    expect(result.linkedUserId).toBe("user-1");
  });

  it("unlinkEntityUser calls DELETE /entities/:id/link-user with no body", async () => {
    let sawBody = false;
    server.use(
      http.delete("https://memory.test/entities/ment_1/link-user", async ({ request }) => {
        const text = await request.text();
        sawBody = text.length > 0;
        return HttpResponse.json({
          id: "ment_2",
          name: "Ada Lovelace",
          kind: "person",
          linkedUserId: null,
        });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.unlinkEntityUser("ment_1");
    expect(sawBody).toBe(false);
    expect(result.linkedUserId).toBeNull();
    // Bitemporal unlink returns a successor row — id must differ from the closed original.
    expect(result.id).not.toBe("ment_1");
  });
});

describe("MnemosyneClient.sessions — GET /session/:id and /session/list (orphan-route fix)", () => {
  it("getSession calls GET /session/:id", async () => {
    server.use(
      http.get("https://memory.test/session/sess-1", () => {
        return HttpResponse.json({
          id: "sess-1",
          agentId: null,
          status: "active",
          createdAt: new Date(0).toISOString(),
          label: null,
          lastRecallAt: null,
        });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.getSession("sess-1");
    expect(result.id).toBe("sess-1");
    expect(result.status).toBe("active");
  });

  it("listSessions calls GET /session/list", async () => {
    let seenUrl = "";
    server.use(
      http.get("https://memory.test/session/list", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          sessions: [
            {
              id: "sess-1",
              agentId: null,
              status: "active",
              createdAt: new Date(0).toISOString(),
              label: null,
              lastRecallAt: null,
            },
          ],
        });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.listSessions();
    expect(seenUrl).toContain("/session/list");
    expect(result.sessions).toHaveLength(1);
  });
});

describe("MnemosyneClient.getEpisodeTimeline — orphan-route fix", () => {
  it("calls GET /episodes/:id/timeline", async () => {
    server.use(
      http.get("https://memory.test/episodes/mepi_1/timeline", () => {
        return HttpResponse.json({
          events: [{ kind: "episode_created", occurredAt: new Date(0).toISOString(), detail: {} }],
        });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.getEpisodeTimeline("mepi_1");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.kind).toBe("episode_created");
  });
});

describe("MnemosyneClient.reasoning", () => {
  it("createReasoning calls POST /reasoning", async () => {
    let hit = false;
    server.use(
      http.post("https://memory.test/reasoning", () => {
        hit = true;
        return HttpResponse.json({ id: "r-1" }, { status: 201 });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    await client.createReasoning({
      question: "Q",
      chain: [{ step: 1, reasoning: "R" }],
      conclusion: "C",
    });
    expect(hit).toBe(true);
  });

  it("listReasoning calls GET /reasoning with status filter", async () => {
    let seenUrl = "";
    server.use(
      http.get("https://memory.test/reasoning", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ items: [], total: 0, offset: 0, limit: 25, hasMore: false });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    await client.listReasoning({ status: "active" });
    expect(seenUrl).toContain("status=active");
  });
});

describe("MnemosyneClient.federation", () => {
  it("listFederationPeers calls GET /memory/federation/peers", async () => {
    server.use(
      http.get("https://memory.test/memory/federation/peers", () =>
        HttpResponse.json({ peers: [] })
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.listFederationPeers();
    expect(result.peers).toEqual([]);
  });

  it("createFederationPeer posts the peer and returns the server's answer", async () => {
    let sent: unknown;
    server.use(
      http.post("https://memory.test/memory/federation/peers", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(
          { created: true, peerId: "acme.example", approvedAt: "2026-01-01T00:00:00.000Z" },
          { status: 201 }
        );
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const input = { peerId: "acme.example", pinnedCertDer: "AQID", trustWeight: 0.5 };
    const result = await client.createFederationPeer(input);
    expect(sent).toEqual(input);
    expect(result).toEqual({
      created: true,
      peerId: "acme.example",
      approvedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("listPendingFederationPeers calls GET /memory/federation/peers/pending", async () => {
    server.use(
      http.get("https://memory.test/memory/federation/peers/pending", () =>
        HttpResponse.json({ peers: [], discovery: { enabled: true } })
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.listPendingFederationPeers();
    expect(result.discovery.enabled).toBe(true);
  });

  it("triggerFederationSync calls POST /memory/federation/sync", async () => {
    let seenBody: unknown;
    server.use(
      http.post("https://memory.test/memory/federation/sync", async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.json({ jobId: "j-1", status: "pending" }, { status: 202 });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.triggerFederationSync({ peerId: "peer-1" });
    expect(result.jobId).toBe("j-1");
    expect((seenBody as { peerId: string }).peerId).toBe("peer-1");
  });

  it("listFederationItems calls GET /memory/federation/items with since", async () => {
    let seenUrl = "";
    server.use(
      http.get("https://memory.test/memory/federation/items", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ items: [], nextCursor: null });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    await client.listFederationItems({ since: "2026-01-01T00:00:00Z", limit: 10, cursor: "c1" });
    expect(seenUrl).toContain("since=");
    expect(seenUrl).toContain("limit=10");
    expect(seenUrl).toContain("cursor=c1");
  });

  it("resolveFederationConflict calls POST /memory/federation/resolve", async () => {
    server.use(
      http.post("https://memory.test/memory/federation/resolve", () =>
        HttpResponse.json({
          winner: { id: "f-1", content: "a", version: 2, worth: 0.8 },
          strategy: "trust_anchor",
          resolvedAt: "2026-06-17T00:00:00Z",
        })
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const res = await client.resolveFederationConflict({
      itemA: { id: "f-1", content: "a", version: 2 },
      itemB: { id: "f-1", content: "b", version: 1 },
    });
    expect(res.strategy).toBe("trust_anchor");
  });

  it("deleteFederationPeer calls DELETE /memory/federation/peers/:id", async () => {
    server.use(
      http.delete("https://memory.test/memory/federation/peers/peer-99", () =>
        HttpResponse.json({ deleted: true, peerId: "peer-99" })
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const res = await client.deleteFederationPeer("peer-99");
    expect(res.deleted).toBe(true);
  });
});

describe("MnemosyneClient.getAnticipationFeed", () => {
  it("returns typed AnticipationFeedResponse", async () => {
    server.use(
      http.get("https://memory.test/anticipation", () =>
        HttpResponse.json({
          items: [{ factId: "f-1", score: 0.9, source: "sequential", confidence: 0.7 }],
          generatedAt: "2026-06-17T00:00:00Z",
        })
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const res = await client.getAnticipationFeed({ limit: 5 });
    expect(res.items[0]?.factId).toBe("f-1");
    expect(res.items[0]?.source).toBe("sequential");
  });
});

describe("MnemosyneClient.selfEdit", () => {
  it("returns the required replacement id for an applied fact replacement", async () => {
    server.use(
      http.post("https://memory.test/self/edit", () =>
        HttpResponse.json({
          action: "replace",
          target: "f-1",
          applied: true,
          targetKind: "fact",
          replacementId: "f-2",
          countsAsEdit: true,
          countsAsDelete: false,
        })
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const res = await client.selfEdit({
      action: "replace",
      target: "f-1",
      content: "new",
      reason: "test",
    });
    expect(res.applied).toBe(true);
    if (res.applied && res.action === "replace" && res.targetKind === "fact") {
      expect(res.replacementId).toBe("f-2");
    } else {
      throw new Error("expected an applied fact replacement");
    }
  });

  it("models approval responses without a replacement id", () => {
    const response: SelfEditResponse = {
      applied: false,
      action: "replace",
      target: "strategy:s-1",
      targetKind: "strategy",
      approvalRequired: true,
      scope: "edit_entity",
      reason: "Approval required",
    };

    expect(response.approvalRequired).toBe(true);
    expect("replacementId" in response).toBe(false);
  });
});

describe("MnemosyneClient.createGrpcTransport", () => {
  it("throws a descriptive error when @connectrpc/connect is not installed", () => {
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    expect(() => client.createGrpcTransport()).toThrow("@connectrpc/connect");
  });
});

describe("MnemosyneClient.subscribe — T8 regression", () => {
  // The server mounts its v1 router at root (app.route("/", v1) in
  // packages/server/src/app.ts), so WebSocket routes are bare (/memory/ws,
  // registered by packages/server/src/ws.ts). subscribe() must connect to
  // that bare path, not /memory/ws.
  it("connects to the bare /memory/ws path, not /memory/ws", () => {
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    let capturedUrl: string | undefined;

    class FakeWebSocket {
      constructor(url: string) {
        capturedUrl = url;
      }
      addEventListener(): void {}
      send(): void {}
      close(): void {}
    }

    const handle = client.subscribe("facts.*", () => {}, {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(capturedUrl).toBe("wss://memory.test/memory/ws?token=test-key");
    handle.close();
  });
});

describe("MnemosyneClient.sessionFeedback (P35)", () => {
  it("sends POST /session/:id/feedback with rating body", async () => {
    let capturedId: string | undefined;
    let capturedBody: unknown;

    server.use(
      http.post("https://memory.test/session/:id/feedback", async ({ params, request }) => {
        capturedId = params.id as string;
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      })
    );

    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    await client.sessionFeedback("ses_123", "up");

    expect(capturedId).toBe("ses_123");
    expect(capturedBody).toEqual({ rating: "up" });
  });
});

describe("MnemosyneClient.relationsTraverse (P35)", () => {
  it("sends POST /relations/traverse with body", async () => {
    let capturedBody: unknown;

    server.use(
      http.post("https://memory.test/relations/traverse", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          nodes: [{ id: "fact_1", kind: "fact" }],
          edges: [],
        });
      })
    );

    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const res = await client.relationsTraverse({
      rootId: "fact_1",
      rootKind: "fact",
      maxDepth: 2,
    });

    expect(capturedBody).toEqual({ rootId: "fact_1", rootKind: "fact", maxDepth: 2 });
    expect(res.nodes).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// memory_workspace tool-promise audit (2026-07-29) — tenant-fallback FIXED 2026-07-31
// ─────────────────────────────────────────────────────────────────────────
//
// memory_workspace's action="list" promises listing "workspaces del
// usuario/tenant": try client.listMyWorkspaces() first, and only if that
// comes back empty, fall back to client.listWorkspacesForCurrentTenant()
// so a user with zero personal-workspace memberships can still discover
// other workspaces in their tenant they could join.
//
// listWorkspacesForCurrentTenant() reads `me.tenantId` from GET /me's
// response to decide which tenant to query. This used to be dead code in
// production — the real GET /me handler (packages/server/src/routes/
// keys.ts, MeResponseSchema) never returned a `tenantId` field at all, so
// the method always short-circuited to `[]`. Fixed 2026-07-31: `/me` now
// includes `tenantId` (resolved from the already-available auth context),
// so the fallback genuinely reaches `GET /tenants/:tenantId/workspaces`.
// ─────────────────────────────────────────────────────────────────────────
describe("MnemosyneClient.listWorkspacesForCurrentTenant — memory_workspace tenant-fallback", () => {
  it("REGRESSION (was: FINDING, dead code): calls /tenants/:tenantId/workspaces using the real GET /me response shape, which now includes tenantId", async () => {
    server.use(
      // Exact shape of a real GET /me response (packages/server/src/routes/keys.ts
      // MeResponseSchema) post-fix — includes tenantId.
      http.get("https://memory.test/me", () =>
        HttpResponse.json({
          workspaceId: "ws_real_1",
          workspaceName: "Real workspace",
          actorId: "key_abc",
          scopes: ["memory:read"],
          plan: "free",
          keyPrefix: "mk_live_",
          expiresAt: null,
          ipAllowlist: [],
          userId: "user_1",
          personalWorkspaceId: null,
          personalFactsLive: null,
          tenantId: "tenant_xyz",
        })
      ),
      http.get("https://memory.test/tenants/tenant_xyz/workspaces", () =>
        HttpResponse.json({ workspaces: [{ id: "ws_other", name: "Other tenant workspace" }] })
      )
    );

    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.listWorkspacesForCurrentTenant();

    expect(result).toEqual([{ id: "ws_other", name: "Other tenant workspace" }]);
  });

  it("a key with no tenant binding (tenantId: null) still returns [] without calling the tenant-workspaces route", async () => {
    let tenantWorkspacesRouteHit = false;
    server.use(
      http.get("https://memory.test/me", () =>
        HttpResponse.json({
          workspaceId: "ws_real_1",
          workspaceName: "Real workspace",
          actorId: "key_abc",
          scopes: ["memory:read"],
          plan: "free",
          keyPrefix: "mk_live_",
          expiresAt: null,
          ipAllowlist: [],
          userId: "user_1",
          personalWorkspaceId: null,
          personalFactsLive: null,
          tenantId: null,
        })
      ),
      http.get("https://memory.test/tenants/:tenantId/workspaces", () => {
        tenantWorkspacesRouteHit = true;
        return HttpResponse.json({
          workspaces: [{ id: "ws_other", name: "Other tenant workspace" }],
        });
      })
    );

    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.listWorkspacesForCurrentTenant();

    expect(result).toEqual([]);
    expect(tenantWorkspacesRouteHit).toBe(false);
  });
});

describe("MnemosyneClient.listWorkspaceMembers — memory_workspace tool-promise audit", () => {
  it("REGRESSION (was: FINDING, swallowed error): a 404 (no such workspace / not a member — anti-probing) now throws MnemosyneAPIError instead of silently resolving to []", async () => {
    server.use(
      http.get("https://memory.test/workspaces/:workspaceId/members", () =>
        HttpResponse.json({ error: "not_found", message: "Workspace not found" }, { status: 404 })
      )
    );

    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });

    await expect(client.listWorkspaceMembers("ws_not_mine")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("control: a real, accessible workspace's members ARE returned correctly (the swallowing only affects the error path)", async () => {
    server.use(
      http.get("https://memory.test/workspaces/:workspaceId/members", () =>
        HttpResponse.json({
          members: [{ userId: "user_1", role: "admin", joinedAt: "2026-01-01T00:00:00.000Z" }],
        })
      )
    );

    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.listWorkspaceMembers("ws_mine");

    expect(result).toEqual([
      { userId: "user_1", role: "admin", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// C1 — X-Workspace-Id support
// ─────────────────────────────────────────────────────────────────────────
describe("MnemosyneClient — X-Workspace-Id header (C1)", () => {
  it("sends no X-Workspace-Id header when unconfigured", async () => {
    let seenHeader: string | null = "unset";
    server.use(
      http.get("https://memory.test/me", ({ request }) => {
        seenHeader = request.headers.get("x-workspace-id");
        return HttpResponse.json({
          workspaceId: "ws_home",
          actorId: "k",
          scopes: [],
          plan: "free",
          keyPrefix: "mk_",
          expiresAt: null,
          ipAllowlist: [],
          userId: null,
          personalWorkspaceId: null,
          personalFactsLive: null,
          tenantId: null,
        });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    await client.getMe();
    expect(seenHeader).toBeNull();
  });

  it("sends X-Workspace-Id when set via MnemosyneClientOptions.workspaceId", async () => {
    let seenHeader: string | null = null;
    server.use(
      http.get("https://memory.test/me", ({ request }) => {
        seenHeader = request.headers.get("x-workspace-id");
        return HttpResponse.json({
          workspaceId: "ws_other",
          actorId: "k",
          scopes: [],
          plan: "free",
          keyPrefix: "uk_",
          expiresAt: null,
          ipAllowlist: [],
          userId: "u1",
          personalWorkspaceId: null,
          personalFactsLive: null,
          tenantId: "t1",
        });
      })
    );
    const client = new MnemosyneClient({
      url: "https://memory.test",
      apiKey: "test-key",
      workspaceId: "ws_other",
    });
    await client.getMe();
    expect(seenHeader).toBe("ws_other");
  });

  it("forWorkspace() returns a NEW client and does not mutate the original", async () => {
    const seen: Array<string | null> = [];
    server.use(
      http.get("https://memory.test/me", ({ request }) => {
        seen.push(request.headers.get("x-workspace-id"));
        return HttpResponse.json({
          workspaceId: "ws_x",
          actorId: "k",
          scopes: [],
          plan: "free",
          keyPrefix: "uk_",
          expiresAt: null,
          ipAllowlist: [],
          userId: "u1",
          personalWorkspaceId: null,
          personalFactsLive: null,
          tenantId: "t1",
        });
      })
    );
    const base = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const scoped = base.forWorkspace("ws_scoped");

    await scoped.getMe();
    await base.getMe();

    expect(seen).toEqual(["ws_scoped", null]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// C3/C4 — tenant + workspace CRUD
// ─────────────────────────────────────────────────────────────────────────
describe("MnemosyneClient — tenant methods (C3)", () => {
  it("createTenant calls POST /tenants with body", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("https://memory.test/tenants", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(
          { id: "tenant_1", name: "Acme", kind: "organization", plan: "free", createdAt: null },
          { status: 201 }
        );
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.createTenant({ name: "Acme" });
    expect(capturedBody).toEqual({ name: "Acme" });
    expect(result.id).toBe("tenant_1");
  });

  it("getTenant calls GET /tenants/:tenantId", async () => {
    server.use(
      http.get("https://memory.test/tenants/tenant_1", () =>
        HttpResponse.json({
          id: "tenant_1",
          name: "Acme",
          kind: "organization",
          plan: "free",
          createdAt: null,
        })
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.getTenant("tenant_1");
    expect(result.name).toBe("Acme");
  });

  it("listWorkspacesForTenant calls GET /tenants/:tenantId/workspaces with an explicit tenantId", async () => {
    server.use(
      http.get("https://memory.test/tenants/tenant_explicit/workspaces", () =>
        HttpResponse.json({
          workspaces: [{ id: "ws1", name: "W", slug: null, visibility: "private", memberCount: 1 }],
        })
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.listWorkspacesForTenant("tenant_explicit");
    expect(result).toEqual([
      { id: "ws1", name: "W", slug: null, visibility: "private", memberCount: 1 },
    ]);
  });

  it("listTenantMembers unwraps the members envelope", async () => {
    server.use(
      http.get("https://memory.test/tenants/tenant_1/members", () =>
        HttpResponse.json({ members: [{ userId: "u1", role: "owner", joinedAt: null }] })
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.listTenantMembers("tenant_1");
    expect(result).toEqual([{ userId: "u1", role: "owner", joinedAt: null }]);
  });

  it("inviteTenantMember calls POST /tenants/:tenantId/members with createIfMissing", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("https://memory.test/tenants/tenant_1/members", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.inviteTenantMember("tenant_1", {
      email: "new@example.com",
      role: "member",
      createIfMissing: true,
    });
    expect(capturedBody).toEqual({
      email: "new@example.com",
      role: "member",
      createIfMissing: true,
    });
    expect(result).toEqual({ ok: true });
  });

  it("removeTenantMember calls DELETE /tenants/:tenantId/members/:userId", async () => {
    server.use(
      http.delete("https://memory.test/tenants/tenant_1/members/u1", () =>
        HttpResponse.json({ ok: true })
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.removeTenantMember("tenant_1", "u1");
    expect(result).toEqual({ ok: true });
  });

  it("createUser calls POST /users", async () => {
    server.use(
      http.post("https://memory.test/users", () =>
        HttpResponse.json(
          {
            user: {
              id: "u1",
              email: "a@b.com",
              displayName: null,
              personalTenantId: "t1",
              createdAt: null,
            },
            personalTenant: {
              id: "t1",
              name: "a@b.com",
              kind: "personal",
              plan: "free",
              createdAt: null,
            },
            personalWorkspace: {
              id: "ws1",
              name: "a@b.com's workspace",
              slug: null,
              tenantId: "t1",
              visibility: "private",
              createdAt: null,
            },
          },
          { status: 201 }
        )
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.createUser({ email: "a@b.com" });
    expect(result.user.id).toBe("u1");
    expect(result.personalWorkspace.id).toBe("ws1");
  });
});

describe("MnemosyneClient — workspace methods (C4)", () => {
  it("getWorkspaceById calls GET /workspaces/:workspaceId", async () => {
    server.use(
      http.get("https://memory.test/workspaces/ws1", () =>
        HttpResponse.json({
          id: "ws1",
          name: "W",
          slug: null,
          tenantId: "t1",
          visibility: "private",
          createdAt: null,
        })
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.getWorkspaceById("ws1");
    expect(result.id).toBe("ws1");
  });

  it("createWorkspace calls POST /tenants/:tenantId/workspaces with body", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("https://memory.test/tenants/t1/workspaces", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(
          {
            id: "ws2",
            name: "New WS",
            slug: null,
            tenantId: "t1",
            visibility: "private",
            createdAt: null,
          },
          { status: 201 }
        );
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.createWorkspace("t1", { name: "New WS" });
    expect(capturedBody).toEqual({ name: "New WS" });
    expect(result.id).toBe("ws2");
  });

  it("inviteWorkspaceMember calls POST /workspaces/:workspaceId/members with role", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("https://memory.test/workspaces/ws1/members", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.inviteWorkspaceMember("ws1", { userId: "u2", role: "read" });
    expect(capturedBody).toEqual({ userId: "u2", role: "read" });
    expect(result).toEqual({ ok: true });
  });

  it("removeWorkspaceMember calls DELETE /workspaces/:workspaceId/members/:userId", async () => {
    server.use(
      http.delete("https://memory.test/workspaces/ws1/members/u2", () =>
        HttpResponse.json({ ok: true })
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.removeWorkspaceMember("ws1", "u2");
    expect(result).toEqual({ ok: true });
  });

  it("updateWorkspaceMemberRole calls PATCH /workspaces/:workspaceId/members/:userId with role", async () => {
    let capturedBody: unknown;
    server.use(
      http.patch("https://memory.test/workspaces/ws1/members/u2", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.updateWorkspaceMemberRole("ws1", "u2", "write");
    expect(capturedBody).toEqual({ role: "write" });
    expect(result).toEqual({ ok: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// C5 — user tokens
// ─────────────────────────────────────────────────────────────────────────
describe("MnemosyneClient — user token methods (C5)", () => {
  it("createUserToken calls POST /tenants/:tenantId/users/:userId/tokens and returns the plaintext key", async () => {
    server.use(
      http.post("https://memory.test/tenants/t1/users/u2/tokens", () =>
        HttpResponse.json(
          {
            id: "uk_abc",
            key: "uk_live_deadbeef",
            label: "B's token",
            scopes: ["memory:read"],
            userId: "u2",
            tenantId: "t1",
            workspaceId: "ws1",
            expiresAt: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          { status: 201 }
        )
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.createUserToken("t1", "u2", {
      label: "B's token",
      homeWorkspaceId: "ws1",
    });
    expect(result.key).toBe("uk_live_deadbeef");
    expect(result.userId).toBe("u2");
  });

  it("listUserTokens unwraps the tokens envelope (no secret field)", async () => {
    server.use(
      http.get("https://memory.test/tenants/t1/users/u2/tokens", () =>
        HttpResponse.json({
          tokens: [
            {
              id: "uk_abc",
              label: "B's token",
              scopes: ["memory:read"],
              workspaceId: "ws1",
              expiresAt: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              lastUsedAt: null,
              revokedAt: null,
            },
          ],
        })
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.listUserTokens("t1", "u2");
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty("key");
  });

  it("revokeUserToken calls DELETE /tenants/:tenantId/users/:userId/tokens/:keyId", async () => {
    server.use(
      http.delete("https://memory.test/tenants/t1/users/u2/tokens/uk_abc", () =>
        HttpResponse.json({ ok: true, revokedAt: "2026-01-01T00:00:00.000Z" })
      )
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    const result = await client.revokeUserToken("t1", "u2", "uk_abc");
    expect(result.ok).toBe(true);
  });
});

describe("HttpClient — request observation headers (RL11)", () => {
  function makeClient(seen: Headers[], statuses: number[]) {
    return new HttpClient({
      baseUrl: "https://memory.test",
      apiKey: "test-key",
      timeoutMs: 100,
      retry: { attempts: 3, initialDelayMs: 1 },
      userAgent: "test",
      fetchImpl: (async (_url, init) => {
        seen.push(new Headers(init?.headers));
        const status = statuses.shift() ?? 200;
        return new Response(JSON.stringify(status === 200 ? { requestId: "srv-1" } : {}), {
          status,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
  }
  const observation = { caller: "plugin:x", clientVersion: "1.2.3", pluginVersion: "0.4.0" };

  it("keeps one request id across retries and sends declared metadata (recall)", async () => {
    const seen: Headers[] = [];
    const client = makeClient(seen, [503, 200]);
    const res = await client.request<{ requestId: string }>({
      method: "POST",
      path: "/recall",
      body: { query: "q" },
      observation,
    });
    expect(res.requestId).toBe("srv-1");
    expect(seen).toHaveLength(2);
    expect(seen[0]!.get("x-request-id")).toBeTruthy();
    expect(seen[1]!.get("x-request-id")).toBe(seen[0]!.get("x-request-id"));
    for (const h of seen) {
      expect(h.get("x-mnemo-caller")).toBe("plugin:x");
      expect(h.get("x-mnemo-client-version")).toBe("1.2.3");
      expect(h.get("x-mnemo-plugin-version")).toBe("0.4.0");
    }
  });

  it("keeps the id across a keyed remember retry and differs between calls", async () => {
    const seen: Headers[] = [];
    const client = makeClient(seen, [503, 200, 200]);
    const call = () =>
      client.request({
        method: "POST",
        path: "/remember",
        body: { statement: "x" },
        extraHeaders: { "Idempotency-Key": "k" },
        observation: { caller: "plugin:x" },
      });
    await call();
    await call();
    expect(seen).toHaveLength(3);
    expect(seen[1]!.get("x-request-id")).toBe(seen[0]!.get("x-request-id"));
    expect(seen[2]!.get("x-request-id")).not.toBe(seen[0]!.get("x-request-id"));
    expect(seen[0]!.get("x-mnemo-client-version")).toBeNull();
    expect(seen[0]!.get("x-mnemo-plugin-version")).toBeNull();
  });

  it("protects Authorization / X-Workspace-Id and isolates withWorkspace clones", async () => {
    const seen: Headers[] = [];
    const client = makeClient(seen, []);
    const scoped = client.withWorkspace("ws_scoped");
    const extraHeaders = { authorization: "Bearer evil", "X-Workspace-Id": "ws_evil" };
    await scoped.request({ method: "GET", path: "/me", extraHeaders, observation });
    await client.request({ method: "GET", path: "/me", extraHeaders, observation });
    expect(seen[0]!.get("authorization")).toBe("Bearer test-key");
    expect(seen[0]!.get("x-workspace-id")).toBe("ws_scoped");
    expect(seen[1]!.get("authorization")).toBe("Bearer test-key");
    expect(seen[1]!.get("x-workspace-id")).toBeNull();
    expect(seen[1]!.get("x-request-id")).not.toBe(seen[0]!.get("x-request-id"));
  });
});

describe("MnemosyneClient.withObservation", () => {
  function makeClient(seen: Headers[]) {
    return new MnemosyneClient({
      url: "https://memory.test",
      apiKey: "test-key",
      fetch: (async (_url: unknown, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return new Response(JSON.stringify({ hits: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
  }

  it("sends the declared caller on recall/remember from a clone, never from the shared client", async () => {
    const seen: Headers[] = [];
    const client = makeClient(seen);
    const observed = client.withObservation({
      requestId: "rid-7",
      caller: "mcp:memory_recall",
      clientVersion: "9.9.9",
    });
    await observed.recall({ query: "q" });
    await observed.remember({ statement: "x" }, undefined, "idem-1");
    await client.recall({ query: "q" });
    expect(seen[0]!.get("x-request-id")).toBe("rid-7");
    expect(seen[0]!.get("x-mnemo-caller")).toBe("mcp:memory_recall");
    expect(seen[0]!.get("x-mnemo-client-version")).toBe("9.9.9");
    expect(seen[1]!.get("x-mnemo-caller")).toBe("mcp:memory_recall");
    expect(seen[1]!.get("idempotency-key")).toBe("idem-1");
    expect(seen[2]!.get("x-mnemo-caller")).toBeNull();
    expect(seen[2]!.get("x-request-id")).toBeNull();
  });

  it("composes with forWorkspace in either order", async () => {
    const seen: Headers[] = [];
    const client = makeClient(seen);
    await client.forWorkspace("ws_a").withObservation({ caller: "c" }).recall({ query: "q" });
    await client.withObservation({ caller: "c" }).forWorkspace("ws_a").recall({ query: "q" });
    for (const h of seen) {
      expect(h.get("x-workspace-id")).toBe("ws_a");
      expect(h.get("x-mnemo-caller")).toBe("c");
    }
  });
});

describe("MnemosyneClient.remember — validFrom", () => {
  it("sends validFrom, and leaves it out when unset", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.post("https://memory.test/remember", async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ id: "f-1", kind: "fact", staged: false }, { status: 201 });
      })
    );
    const client = new MnemosyneClient({ url: "https://memory.test", apiKey: "test-key" });
    await client.remember({
      statement: "deploys moved to Fridays",
      validFrom: "2026-01-05T09:00Z",
    });
    await client.remember({ statement: "no date" });
    expect(bodies[0]).toMatchObject({ validFrom: "2026-01-05T09:00Z" });
    expect(bodies[1]).not.toHaveProperty("validFrom");
  });
});
