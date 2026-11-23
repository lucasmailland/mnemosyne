/**
 * B4.1 — HTTP route coverage fill-in: reasoning, hyperedges, composition
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

describe("reasoning routes (B4.1)", () => {
  it("POST /reasoning, GET list/single, PATCH, POST record/feedback/resolve", async () => {
    const created = await json(
      await surface.http("POST", "/reasoning", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: "Why does B4.1 exist?",
          chain: [{ step: 0, reasoning: "It fills coverage gaps." }],
          conclusion: "B4.1 exercises real routes.",
        }),
      })
    );
    expect(created.id).toBeTruthy();

    const listRes = await surface.http("GET", "/reasoning");
    expect(listRes.status).toBe(200);

    const getRes = await surface.http("GET", `/reasoning/${created.id}`);
    expect(getRes.status).toBe(200);

    const patchRes = await surface.http("PATCH", `/reasoning/${created.id}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "B4.1 exercises real routes, patched." }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await json(patchRes);
    expect(patched.conclusion).toBe("B4.1 exercises real routes, patched.");

    const recordRes = await surface.http("POST", "/reasoning/record", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "Recorded question?",
        chain: [{ step: 0, reasoning: "recorded" }],
        conclusion: "recorded conclusion",
      }),
    });
    expect(recordRes.status).toBe(201);

    const resolveRes = await surface.http("POST", "/reasoning/resolve", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Why does B4.1 exist?" }),
    });
    expect(resolveRes.status).toBe(200);
    const resolved = await json(resolveRes);
    expect(["hit", "execute"]).toContain(resolved.action);

    const feedbackRes = await surface.http("POST", "/reasoning/feedback", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasoning_id: created.id, outcome: "success" }),
    });
    expect([200, 204]).toContain(feedbackRes.status);

    const delRes = await surface.http("DELETE", `/reasoning/${created.id}`);
    expect([200, 204]).toContain(delRes.status);
  });
});

describe("hyperedges routes (B4.1)", () => {
  it("POST /hyperedges, GET list/single, PATCH, DELETE", async () => {
    const members = await Promise.all(
      ["A", "B", "C"].map(async (n) => {
        const res = await surface.http("POST", "/remember", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ statement: `Member ${n} of a hyperedge.` }),
        });
        return (await json(res)).id as string;
      })
    );

    const created = await json(
      await surface.http("POST", "/hyperedges", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberIds: members, label: "B4.1 hyperedge" }),
      })
    );
    expect(created.id).toBeTruthy();

    const listRes = await surface.http("GET", "/hyperedges");
    expect(listRes.status).toBe(200);
    const list = await json(listRes);
    expect(list.items.some((h: any) => h.id === created.id)).toBe(true);

    const getRes = await surface.http("GET", `/hyperedges/${created.id}`);
    expect(getRes.status).toBe(200);

    const patchRes = await surface.http("PATCH", `/hyperedges/${created.id}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "B4.1 hyperedge, patched" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await json(patchRes);
    expect(patched.label).toBe("B4.1 hyperedge, patched");

    const delRes = await surface.http("DELETE", `/hyperedges/${created.id}`);
    expect(delRes.status).toBe(204);
  });
});

describe("composition routes (B4.1)", () => {
  it("POST /composition/rules, GET list/single, PATCH, POST /composition/dry-run", async () => {
    const created = await json(
      await surface.http("POST", "/composition/rules", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "B4.1 composition rule",
          conditionDsl: { all: [{ op: "fact_kind", kind: "preference" }] },
          actionDsl: { op: "derive_fact", statementTemplate: "Derived from B4.1 test." },
        }),
      })
    );
    expect(created.id).toBeTruthy();

    const listRes = await surface.http("GET", "/composition/rules");
    expect(listRes.status).toBe(200);
    const list = await json(listRes);
    expect(list.items.some((r: any) => r.id === created.id)).toBe(true);

    const getRes = await surface.http("GET", `/composition/rules/${created.id}`);
    expect(getRes.status).toBe(200);

    const patchRes = await surface.http("PATCH", `/composition/rules/${created.id}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await json(patchRes);
    expect(patched.isActive).toBe(false);

    const dryRunRes = await surface.http("POST", "/composition/dry-run", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ruleId: created.id, hits: [] }),
    });
    expect(dryRunRes.status).toBe(200);
    const dryRun = await json(dryRunRes);
    expect(Array.isArray(dryRun.inferences)).toBe(true);
  });
});
