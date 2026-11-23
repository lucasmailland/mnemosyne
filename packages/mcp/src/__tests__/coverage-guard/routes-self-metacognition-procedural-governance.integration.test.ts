/**
 * B4.1 — HTTP route coverage fill-in: self-editing memory, metacognition,
 * procedural memory, review queue, reminders (GET/DELETE), governance gate
 * (design.md "B4. Coverage fill-in", spec.md Requirement 13).
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

describe("self-editing memory routes (B4.1)", () => {
  it("POST /self/edit — 'reflect' action, GET /self/profile, POST /self/reflect", async () => {
    const editRes = await surface.http("POST", "/self/edit", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reflect", target: "profile", reason: "B4.1 coverage" }),
    });
    expect(editRes.status).toBe(200);
    const edit = await json(editRes);
    expect(edit.applied).toBe(true);
    expect(edit.action).toBe("reflect");

    const profileRes = await surface.http("GET", "/self/profile");
    expect(profileRes.status).toBe(200);
    const profile = await json(profileRes);
    expect(profile.workspaceId).toBe(surface.workspaceId);

    const reflectRes = await surface.http("POST", "/self/reflect", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(reflectRes.status).toBe(200);
  });
});

describe("metacognition route (B4.1)", () => {
  it("GET /metacognition — workspace SelfModel", async () => {
    const res = await surface.http("GET", "/metacognition");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.workspaceId).toBe(surface.workspaceId);
    expect(body.summary).toBeTruthy();
  });
});

describe("procedural memory routes (B4.1)", () => {
  it("POST /procedural/optimize — 503 without a configured LLM adapter (real harness state)", async () => {
    const res = await surface.http("POST", "/procedural/optimize", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "b4.1-agent" }),
    });
    expect(res.status).toBe(503);
  });

  it("GET /procedural/prompt/:agent — null when no version exists yet", async () => {
    const res = await surface.http("GET", "/procedural/prompt/b4.1-agent");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.version).toBeNull();
  });

  it("GET /procedural/versions/:agent — empty history for a fresh agent", async () => {
    const res = await surface.http("GET", "/procedural/versions/b4.1-agent");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Array.isArray(body.versions)).toBe(true);
  });
});

describe("review queue route (B4.1)", () => {
  it("GET /review, GET /review/count, POST /review/enqueue, POST /review/:id/resolve", async () => {
    const fact = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "Needs manual review." }),
      })
    );
    const enqueueRes = await surface.http("POST", "/review/enqueue", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ factId: fact.id, reason: "manual" }),
    });
    expect(enqueueRes.status).toBe(200);
    const enqueued = await json(enqueueRes);

    const listRes = await surface.http("GET", "/review");
    expect(listRes.status).toBe(200);

    const countRes = await surface.http("GET", "/review/count");
    expect(countRes.status).toBe(200);
    const count = await json(countRes);
    expect(typeof count.count).toBe("number");

    const resolveRes = await surface.http("POST", `/review/${enqueued.id}/resolve`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolution: "kept" }),
    });
    expect(resolveRes.status).toBe(200);
    const resolved = await json(resolveRes);
    expect(resolved.resolution).toBe("kept");
  });
});

describe("reminders read/delete routes (B4.1)", () => {
  it("GET /reminders, DELETE /reminders/:id", async () => {
    const created = await json(
      await surface.http("POST", "/reminders", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "B4.1 reminder", condition: "when B4.1 runs" }),
      })
    );
    const listRes = await surface.http("GET", "/reminders");
    expect(listRes.status).toBe(200);
    const list = await json(listRes);
    expect(list.reminders.some((r: any) => r.id === created.id)).toBe(true);

    const delRes = await surface.http("DELETE", `/reminders/${created.id}`);
    expect([200, 204]).toContain(delRes.status);
  });
});

describe("governance gate route (B4.1)", () => {
  it("POST /governance/gate — canonical gate on a real fact", async () => {
    const fact = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "Governed by B4.1." }),
      })
    );
    const res = await surface.http("POST", "/governance/gate", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ factId: fact.id, gate: "canonical" }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.factId).toBe(fact.id);
  });
});
