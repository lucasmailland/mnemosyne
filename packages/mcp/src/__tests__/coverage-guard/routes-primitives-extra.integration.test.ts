/**
 * B4.1 — HTTP route coverage fill-in: decisions/relations/strategies/facts/
 * entities/webhooks "extra" routes not already covered by pre-existing
 * integration tests (design.md "B4. Coverage fill-in", spec.md Requirement 13).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "../harness/live-surface.js";

let surface: LiveSurface;

beforeAll(async () => {
  surface = await startLiveSurface();
}, 120_000);

afterAll(async () => {
  await surface.close();
});

async function json(res: Response): Promise<any> {
  return res.json();
}

describe("decisions routes (B4.1)", () => {
  it("POST /decisions then GET /decisions (list) then PATCH /decisions/:id (supersede)", async () => {
    const created = await surface.http("POST", "/decisions", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "architecture",
        title: "B4.1 decision A",
        body: "Use X because Y.",
      }),
    });
    expect(created.status).toBe(201);
    const a = await json(created);

    const createdB = await surface.http("POST", "/decisions", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "architecture",
        title: "B4.1 decision B",
        body: "Replaces decision A.",
      }),
    });
    const b = await json(createdB);

    const listRes = await surface.http("GET", "/decisions");
    expect(listRes.status).toBe(200);
    const list = await json(listRes);
    expect(list.items.some((d: any) => d.id === a.id)).toBe(true);

    const patchRes = await surface.http("PATCH", `/decisions/${a.id}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ supersededById: b.id }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await json(patchRes);
    expect(patched.status).toBe("superseded");
    expect(patched.supersededById).toBe(b.id);
  });
});

describe("relations PATCH route (B4.1)", () => {
  it("POST /entities x2, POST /relations, PATCH /relations/:id (judgment)", async () => {
    const e1 = await json(
      await surface.http("POST", "/entities", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "B4.1 Entity 1", kind: "concept" }),
      })
    );
    const e2 = await json(
      await surface.http("POST", "/entities", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "B4.1 Entity 2", kind: "concept" }),
      })
    );
    const relRes = await surface.http("POST", "/relations", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceKind: "entity",
        sourceId: e1.id,
        targetKind: "entity",
        targetId: e2.id,
        relation: "related",
        markedByKind: "user",
      }),
    });
    expect(relRes.status).toBe(201);
    const rel = await json(relRes);

    const patchRes = await surface.http("PATCH", `/relations/${rel.id}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relation: "related", markedByKind: "user", confidence: 0.9 }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await json(patchRes);
    expect(patched.judgmentStatus).toBe("judged");
  });
});

describe("strategies PATCH route (B4.1)", () => {
  it("POST /strategies then PATCH /strategies/:id", async () => {
    const created = await json(
      await surface.http("POST", "/strategies", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trigger: "when B4.1 tests run",
          action: "exercise the route",
        }),
      })
    );
    const patchRes = await surface.http("PATCH", `/strategies/${created.id}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "exercise the route thoroughly" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await json(patchRes);
    expect(patched.action).toBe("exercise the route thoroughly");
  });
});

describe("facts patch/citations/restore routes (B4.1)", () => {
  it("PATCH /facts/:id, GET /facts/:id/citations, DELETE + POST /facts/:id/restore", async () => {
    const created = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.1 fact for patch/restore." }),
      })
    );

    const patchRes = await surface.http("PATCH", `/facts/${created.id}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "b4.1-patched" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await json(patchRes);
    expect(patched.subject).toBe("b4.1-patched");

    const citationsRes = await surface.http("GET", `/facts/${created.id}/citations`);
    expect(citationsRes.status).toBe(200);
    const citations = await json(citationsRes);
    expect(citations.factId).toBe(created.id);
    expect(Array.isArray(citations.sourceMessageIds)).toBe(true);

    const delRes = await surface.http("DELETE", `/facts/${created.id}`);
    expect(delRes.status).toBe(204);

    const restoreRes = await surface.http("POST", `/facts/${created.id}/restore`);
    expect(restoreRes.status).toBe(200);
    const restored = await json(restoreRes);
    expect(restored.status).toBe("active");
  });

  it("DELETE /forget/:kind/:id — generic soft-delete for a non-fact primitive (skill)", async () => {
    const createdSkill = await json(
      await surface.http("POST", "/skills", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "b4.1-skill", promptTemplate: "Do the thing." }),
      })
    );
    const res = await surface.http("DELETE", `/forget/skill/${createdSkill.id}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.forgotten).toBe(true);
  });

  it("GET /citations — top-level citations list (empty for a fresh workspace)", async () => {
    const res = await surface.http("GET", "/citations");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Array.isArray(body.items)).toBe(true);
  });
});

describe("entity self-link routes (B4.1) — workspace-only key has no bound userId", () => {
  it("POST /entities/:id/link-user — 403 (mayActOnUser fails closed for a non-user-bound key)", async () => {
    const entity = await json(
      await surface.http("POST", "/entities", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "B4.1 Person", kind: "person" }),
      })
    );
    const res = await surface.http("POST", `/entities/${entity.id}/link-user`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: surface.secondaryIdentities.userA.id }),
    });
    expect(res.status).toBe(403);
  });

  it("DELETE /entities/:id/link-user — 404, entity is not currently linked (checked before mayActOnUser)", async () => {
    const entity = await json(
      await surface.http("POST", "/entities", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "B4.1 Person 2", kind: "person" }),
      })
    );
    const res = await surface.http("DELETE", `/entities/${entity.id}/link-user`);
    expect(res.status).toBe(404);
  });
});

describe("webhook deliveries/test routes (B4.1)", () => {
  // APP-005: webhooks are https-only and never aimed at internal addresses
  // unless the operator allows it. These cases deliver to this test server
  // on loopback, so they opt in the way an operator would.
  const saved = {
    http: process.env.MNEMO_WEBHOOK_ALLOW_HTTP,
    priv: process.env.MNEMO_WEBHOOK_ALLOW_PRIVATE,
  };
  beforeAll(() => {
    process.env.MNEMO_WEBHOOK_ALLOW_HTTP = "true";
    process.env.MNEMO_WEBHOOK_ALLOW_PRIVATE = "true";
  });
  afterAll(() => {
    if (saved.http === undefined) delete process.env.MNEMO_WEBHOOK_ALLOW_HTTP;
    else process.env.MNEMO_WEBHOOK_ALLOW_HTTP = saved.http;
    if (saved.priv === undefined) delete process.env.MNEMO_WEBHOOK_ALLOW_PRIVATE;
    else process.env.MNEMO_WEBHOOK_ALLOW_PRIVATE = saved.priv;
  });

  it("GET /webhooks/:id/deliveries — empty log for a fresh endpoint", async () => {
    const created = await json(
      await surface.http("POST", "/webhooks", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: `${surface.baseUrl}/healthz`,
          events: ["fact.created"],
        }),
      })
    );
    const res = await surface.http("GET", `/webhooks/${created.id}/deliveries`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("POST /webhooks/:id/test — real synthetic delivery against a real (if unaccepting) endpoint", async () => {
    const created = await json(
      await surface.http("POST", "/webhooks", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: `${surface.baseUrl}/healthz`,
          events: ["fact.created"],
        }),
      })
    );
    const res = await surface.http("POST", `/webhooks/${created.id}/test`);
    expect(res.status).toBe(200);
    const body = await json(res);
    // /healthz only registers GET (unauthenticated, mounted on the root app).
    // A POST falls through the router into the authenticated v1 sub-app
    // (mounted at "/"), which rejects it with 401 (no Authorization header
    // on the outbound webhook delivery) — a real, if unintuitive, response
    // that proves the test-delivery path genuinely made an outbound call.
    expect(typeof body.success).toBe("boolean");
    expect(body.statusCode).toBe(401);
    expect(typeof body.signature).toBe("string");
  });
});
