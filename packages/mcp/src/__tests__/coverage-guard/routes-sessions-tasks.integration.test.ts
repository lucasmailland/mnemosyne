/**
 * B4.1 — HTTP route coverage fill-in: session lifecycle (incl. the `/sessions`
 * spec aliases) and tasks (design.md "B4. Coverage fill-in", spec.md
 * Requirement 13).
 */
import { randomUUID } from "node:crypto";
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

describe("session lifecycle routes (B4.1)", () => {
  it("POST /session/start, POST turn, POST scratch, POST feedback, POST pin, POST discard", async () => {
    const started = await json(await surface.http("POST", "/session/start"));
    const sessionId = started.id as string;
    expect(sessionId).toBeTruthy();

    const turnRes = await surface.http("POST", `/session/${sessionId}/turn`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "user", content: "Hello from B4.1." }),
    });
    expect(turnRes.status).toBe(204);

    const scratchRes = await surface.http("POST", `/session/${sessionId}/scratch`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scratch: { note: "b4.1" } }),
    });
    expect(scratchRes.status).toBe(204);

    const feedbackRes = await surface.http("POST", `/session/${sessionId}/feedback`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: "up" }),
    });
    expect(feedbackRes.status).toBe(204);

    // POST /turn surfaces no turn id (204, no body), so pin by index: the turn
    // above is index 0. Since 40065898 a selector that matches no turn is a
    // 404 instead of a silent 204 — both halves are asserted.
    const pinRes = await surface.http("POST", `/session/${sessionId}/pin`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnIndex: 0, pinned: true }),
    });
    expect(pinRes.status).toBe(204);
    const missingPinRes = await surface.http("POST", `/session/${sessionId}/pin`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId: randomUUID(), pinned: true }),
    });
    expect(missingPinRes.status).toBe(404);

    const discardRes = await surface.http("POST", `/session/${sessionId}/discard`);
    expect(discardRes.status).toBe(204);
  });

  it("POST /session/start then POST /session/:id/collapse", async () => {
    const started = await json(await surface.http("POST", "/session/start"));
    const sessionId = started.id as string;
    await surface.http("POST", `/session/${sessionId}/turn`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "user", content: "Collapse this session, B4.1." }),
    });
    const collapseRes = await surface.http("POST", `/session/${sessionId}/collapse`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strategy: "auto" }),
    });
    expect(collapseRes.status).toBe(202);
    const body = await json(collapseRes);
    expect(body.accepted).toBe(true);
    expect(body.sessionId).toBe(sessionId);
  });

  it("POST /sessions — spec alias for POST /session/start", async () => {
    const res = await surface.http("POST", "/sessions");
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.id).toBeTruthy();
  });

  it("GET /sessions — spec alias for GET /session/list", async () => {
    const res = await surface.http("GET", "/sessions");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it("POST /sessions/:id/turns — spec alias for POST /session/:id/turn", async () => {
    const started = await json(await surface.http("POST", "/sessions"));
    const res = await surface.http("POST", `/sessions/${started.id}/turns`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "user", content: "Via the /sessions alias, B4.1." }),
    });
    expect(res.status).toBe(204);
  });

  it("DELETE /sessions/:id — spec alias for POST /session/:id/discard", async () => {
    const started = await json(await surface.http("POST", "/sessions"));
    const res = await surface.http("DELETE", `/sessions/${started.id}`);
    expect(res.status).toBe(204);
  });
});

describe("tasks routes (B4.1)", () => {
  it("POST /tasks, GET list/single, PATCH, POST delegate, DELETE", async () => {
    const created = await json(
      await surface.http("POST", "/tasks", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "B4.1 task", assignedTo: "agent-b4.1" }),
      })
    );
    expect(created.id).toBeTruthy();

    const listRes = await surface.http("GET", "/tasks");
    expect(listRes.status).toBe(200);
    const list = await json(listRes);
    expect(list.items.some((t: any) => t.id === created.id)).toBe(true);

    const getRes = await surface.http("GET", `/tasks/${created.id}`);
    expect(getRes.status).toBe(200);

    const patchRes = await surface.http("PATCH", `/tasks/${created.id}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "Patched by B4.1." }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await json(patchRes);
    expect(patched.description).toBe("Patched by B4.1.");

    // The state machine only allows pending -> {in_progress, cancelled}, not
    // pending -> delegated directly (TASK_TRANSITIONS in
    // packages/core/src/cognitive/tasks.ts) — move through in_progress first.
    const toInProgress = await surface.http("PATCH", `/tasks/${created.id}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(toInProgress.status).toBe(200);

    const delegateRes = await surface.http("POST", `/tasks/${created.id}/delegate`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignedTo: "agent-b4.1-delegate" }),
    });
    expect(delegateRes.status).toBe(200);
    const delegated = await json(delegateRes);
    expect(delegated.status).toBe("delegated");
    expect(delegated.assignedTo).toBe("agent-b4.1-delegate");

    const delRes = await surface.http("DELETE", `/tasks/${created.id}`);
    expect([200, 204]).toContain(delRes.status);
  });
});
