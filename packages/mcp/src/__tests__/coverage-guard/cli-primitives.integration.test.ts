/**
 * B4.3 — CLI command coverage fill-in: primitive + relation commands
 * (design.md "B4. Coverage fill-in", spec.md Requirement 13). Exercises
 * `mnemo decide`, `entity`, `relate`, `strategy`, `workflow`, `skill`,
 * `reasoning`, `hyperedge` via `surface.cli(args)` — the real built `mnemo`
 * binary as a subprocess against the live server.
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

describe("mnemo decide (B4.3)", () => {
  it("create, list, show, supersede", async () => {
    const created = await surface.cli([
      "decide",
      "create",
      "--kind",
      "architecture",
      "--title",
      "B4.3 CLI: use topic keys for idempotent decisions",
      "--body",
      "Reuses the existing decide route.",
      "--topic-key",
      "b4.3-cli-decide-coverage",
    ]);
    expect(created.code).toBe(0);
    const createdBody = JSON.parse(created.stdout) as { id: string };
    expect(createdBody.id).toBeTruthy();

    const list = await surface.cli(["decide", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(createdBody.id);

    const show = await surface.cli(["decide", "show", createdBody.id]);
    expect(show.code).toBe(0);
    const showBody = JSON.parse(show.stdout) as { id: string; title: string };
    expect(showBody.id).toBe(createdBody.id);

    const superseder = await surface.cli([
      "decide",
      "create",
      "--kind",
      "architecture",
      "--title",
      "B4.3 CLI: supersedes the topic-key decision",
      "--body",
      "New decision replacing the previous one.",
    ]);
    const supersederBody = JSON.parse(superseder.stdout) as { id: string };

    const supersede = await surface.cli([
      "decide",
      "supersede",
      createdBody.id,
      "--by",
      supersederBody.id,
    ]);
    expect(supersede.code).toBe(0);
  });
});

describe("mnemo entity (B4.3)", () => {
  it("create, list, show, update, facts", async () => {
    const created = await surface.cli([
      "entity",
      "create",
      "--name",
      "B4.3 CLI Corp",
      "--kind",
      "organization",
    ]);
    expect(created.code).toBe(0);
    const createdBody = JSON.parse(created.stdout) as { id: string };

    const list = await surface.cli(["entity", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(createdBody.id);

    const show = await surface.cli(["entity", "show", createdBody.id]);
    expect(show.code).toBe(0);
    // client.getEntity() returns EntityWithCount — { entity, factCount } —
    // not a flat entity object.
    const showBody = JSON.parse(show.stdout) as { entity: { id: string; name: string } };
    expect(showBody.entity.name).toBe("B4.3 CLI Corp");

    const updated = await surface.cli([
      "entity",
      "update",
      createdBody.id,
      "--name",
      "B4.3 CLI Corp Renamed",
    ]);
    expect(updated.code).toBe(0);
    const updatedBody = JSON.parse(updated.stdout) as { name: string };
    expect(updatedBody.name).toBe("B4.3 CLI Corp Renamed");

    const facts = await surface.cli(["entity", "facts", createdBody.id]);
    expect(facts.code).toBe(0);
  });

  it("link-user / unlink-user — workspace-only key fails closed (real 403/404, matches B4.1/B4.2's finding)", async () => {
    const person = await surface.cli([
      "entity",
      "create",
      "--name",
      "B4.3 CLI Person",
      "--kind",
      "person",
    ]);
    const personBody = JSON.parse(person.stdout) as { id: string };

    const link = await surface.cli([
      "entity",
      "link-user",
      personBody.id,
      surface.secondaryIdentities.userA.id,
    ]);
    expect(link.code).not.toBe(0);
    expect(link.stderr).toContain("Error:");

    const unlink = await surface.cli(["entity", "unlink-user", personBody.id]);
    expect(unlink.code).not.toBe(0);
  });
});

describe("mnemo relate (B4.3)", () => {
  it("create, list, history", async () => {
    const factA = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.3 CLI relate: fact A." }),
      })
    );
    const factB = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.3 CLI relate: fact B." }),
      })
    );

    const created = await surface.cli(["relate", "fact", factA.id, "related", "fact", factB.id]);
    expect(created.code).toBe(0);

    const list = await surface.cli(["relate", "list"]);
    expect(list.code).toBe(0);

    const history = await surface.cli(["relate", "history", "fact", factA.id]);
    expect(history.code).toBe(0);
  });
});

describe("mnemo strategy (B4.3)", () => {
  it("create, list, show, update, rate, archive", async () => {
    const created = await surface.cli([
      "strategy",
      "create",
      "--trigger",
      "B4.3 CLI: user asks about invoicing",
      "--action",
      "Point them to the billing portal.",
    ]);
    expect(created.code).toBe(0);
    const createdBody = JSON.parse(created.stdout) as { id: string };

    const list = await surface.cli(["strategy", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(createdBody.id);

    const show = await surface.cli(["strategy", "show", createdBody.id]);
    expect(show.code).toBe(0);

    const updated = await surface.cli([
      "strategy",
      "update",
      createdBody.id,
      "--context",
      "Billing-related questions only.",
    ]);
    expect(updated.code).toBe(0);

    const rated = await surface.cli(["strategy", "rate", createdBody.id, "success"]);
    expect(rated.code).toBe(0);

    const archived = await surface.cli(["strategy", "archive", createdBody.id]);
    expect(archived.code).toBe(0);
    expect(archived.stderr).toContain("Archived");
    expect(archived.stderr).toContain(createdBody.id);
  });
});

describe("mnemo workflow (B4.3)", () => {
  it("create, list, show", async () => {
    const created = await surface.cli([
      "workflow",
      "create",
      "--name",
      "B4.3 CLI onboarding workflow",
      "--steps",
      '["Collect requirements","Send welcome email"]',
    ]);
    expect(created.code).toBe(0);
    const createdBody = JSON.parse(created.stdout) as { id: string };

    const list = await surface.cli(["workflow", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(createdBody.id);

    const show = await surface.cli(["workflow", "show", createdBody.id]);
    expect(show.code).toBe(0);
    const showBody = JSON.parse(show.stdout) as { steps: unknown[] };
    expect(showBody.steps.length).toBe(2);
  });
});

describe("mnemo skill (B4.3)", () => {
  it("create, list, show", async () => {
    const created = await surface.cli([
      "skill",
      "create",
      "--name",
      "B4.3 CLI draft-reply skill",
      "--prompt",
      "Draft a reply to {{customer}} about {{topic}}.",
      "--variables",
      "customer,topic",
    ]);
    expect(created.code).toBe(0);
    const createdBody = JSON.parse(created.stdout) as { id: string };

    const list = await surface.cli(["skill", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(createdBody.id);

    const show = await surface.cli(["skill", "show", createdBody.id]);
    expect(show.code).toBe(0);
  });
});

describe("mnemo reasoning (B4.3)", () => {
  it("create, list, show, record, feedback, resolve, archive", async () => {
    const chain = JSON.stringify([{ step: 1, reasoning: "B4.3 CLI reasoning step." }]);
    const created = await surface.cli([
      "reasoning",
      "create",
      "--question",
      "B4.3 CLI: should we cache this?",
      "--conclusion",
      "Yes, cache it.",
      "--chain",
      chain,
    ]);
    expect(created.code).toBe(0);
    const createdBody = JSON.parse(created.stdout) as { id: string };

    const list = await surface.cli(["reasoning", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(createdBody.id);

    const show = await surface.cli(["reasoning", "show", createdBody.id]);
    expect(show.code).toBe(0);

    const recorded = await surface.cli([
      "reasoning",
      "record",
      "--question",
      "B4.3 CLI: recorded reasoning question",
      "--conclusion",
      "Recorded conclusion.",
      "--chain",
      chain,
    ]);
    expect(recorded.code).toBe(0);
    const recordedBody = JSON.parse(recorded.stdout) as { id: string };

    const feedback = await surface.cli(["reasoning", "feedback", recordedBody.id, "success"]);
    expect(feedback.code).toBe(0);

    const resolved = await surface.cli(["reasoning", "resolve", "cache this"]);
    expect(resolved.code).toBe(0);

    const archived = await surface.cli(["reasoning", "archive", createdBody.id]);
    expect(archived.code).toBe(0);
    expect(archived.stderr).toContain("Archived");
    expect(archived.stderr).toContain(createdBody.id);
  });
});

describe("mnemo hyperedge (B4.3)", () => {
  it("create, list, show, update, archive", async () => {
    const members = await Promise.all(
      [1, 2, 3].map(async (n) => {
        const f = await json(
          await surface.http("POST", "/remember", {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ statement: `B4.3 CLI hyperedge member ${n}.` }),
          })
        );
        return f.id as string;
      })
    );

    const created = await surface.cli([
      "hyperedge",
      "create",
      "--members",
      members.join(","),
      "--label",
      "B4.3 CLI hyperedge",
    ]);
    expect(created.code).toBe(0);
    const createdBody = JSON.parse(created.stdout) as { id: string };

    const list = await surface.cli(["hyperedge", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(createdBody.id);

    const show = await surface.cli(["hyperedge", "show", createdBody.id]);
    expect(show.code).toBe(0);

    const updated = await surface.cli([
      "hyperedge",
      "update",
      createdBody.id,
      "--label",
      "B4.3 CLI hyperedge renamed",
    ]);
    expect(updated.code).toBe(0);
    const updatedBody = JSON.parse(updated.stdout) as { label?: string };
    expect(updatedBody.label).toBe("B4.3 CLI hyperedge renamed");

    const archived = await surface.cli(["hyperedge", "archive", createdBody.id]);
    expect(archived.code).toBe(0);
    expect(archived.stderr).toContain("Archived");
    expect(archived.stderr).toContain(createdBody.id);
  });
});
