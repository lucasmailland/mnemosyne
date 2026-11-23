/**
 * B4.3 — CLI command coverage fill-in: session/episode/task/event commands
 * (design.md "B4. Coverage fill-in", spec.md Requirement 13). Exercises
 * `mnemo sessions`, `tasks`, `events`, `episode`, `timeline` via
 * `surface.cli(args)` — the real built `mnemo` binary as a subprocess
 * against the live server.
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

describe("mnemo episode / sessions (B4.3)", () => {
  it("episode start creates a session; sessions list/show find it", async () => {
    const started = await surface.cli([
      "episode",
      "start",
      "--label",
      "B4.3 CLI episode coverage",
      "--agent-id",
      "b4.3-cli",
    ]);
    expect(started.code).toBe(0);
    const startedBody = JSON.parse(started.stdout) as { id: string };
    expect(startedBody.id).toBeTruthy();

    const list = await surface.cli(["sessions"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(startedBody.id);

    const show = await surface.cli(["sessions", "show", startedBody.id]);
    expect(show.code).toBe(0);
    const showBody = JSON.parse(show.stdout) as { id: string };
    expect(showBody.id).toBe(startedBody.id);
  });

  it("episode collapse ends a session", async () => {
    const started = await surface.cli(["episode", "start"]);
    const startedBody = JSON.parse(started.stdout) as { id: string };

    const collapsed = await surface.cli([
      "episode",
      "collapse",
      startedBody.id,
      "--hint",
      "B4.3 CLI collapse coverage",
      "--strategy",
      "explicit",
    ]);
    expect(collapsed.code).toBe(0);
  });
});

describe("mnemo tasks (B4.3)", () => {
  it("create, list, show, update, delegate", async () => {
    const created = await surface.cli([
      "tasks",
      "create",
      "--title",
      "B4.3 CLI task coverage",
      "--assigned-to",
      "agent-b4.3",
      "--priority",
      "medium",
    ]);
    expect(created.code).toBe(0);
    const createdBody = JSON.parse(created.stdout) as { id: string };

    const list = await surface.cli(["tasks"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(createdBody.id);

    const show = await surface.cli(["tasks", "show", createdBody.id]);
    expect(show.code).toBe(0);
    const showBody = JSON.parse(show.stdout) as { id: string; title: string };
    expect(showBody.title).toBe("B4.3 CLI task coverage");

    const updated = await surface.cli([
      "tasks",
      "update",
      createdBody.id,
      "--status",
      "in_progress",
    ]);
    expect(updated.code).toBe(0);
    const updatedBody = JSON.parse(updated.stdout) as { status: string };
    expect(updatedBody.status).toBe("in_progress");

    const delegated = await surface.cli([
      "tasks",
      "delegate",
      createdBody.id,
      "--to",
      "agent-b4.3-b",
    ]);
    expect(delegated.code).toBe(0);
    const delegatedBody = JSON.parse(delegated.stdout) as { assignedTo?: string; status?: string };
    expect(delegatedBody.assignedTo ?? delegatedBody.status).toBeTruthy();
  });
});

describe("mnemo events (B4.3)", () => {
  it("create, list, show, sensitivity, archive", async () => {
    const created = await surface.cli([
      "events",
      "create",
      "--type",
      "agent",
      "--name",
      "B4.3 CLI event coverage",
      "--description",
      "Exercises the events CLI command for real.",
      "--source",
      "b4.3-cli-test",
    ]);
    expect(created.code).toBe(0);
    const createdBody = JSON.parse(created.stdout) as { id: string };

    const list = await surface.cli(["events"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(createdBody.id);

    const show = await surface.cli(["events", "show", createdBody.id]);
    expect(show.code).toBe(0);
    const showBody = JSON.parse(show.stdout) as { id: string; sensitivity: string };
    expect(showBody.sensitivity).toBe("internal");

    // Events are immutable: since PRIM-10 (e13fab0b) DELETE /events/:id
    // refuses with 409 event_immutable instead of a 204 that changed nothing,
    // so the CLI reports the refusal (generic exit 1) rather than "Archived".
    const archived = await surface.cli(["events", "archive", createdBody.id]);
    expect(archived.code).toBe(1);
    expect(archived.stderr).toContain("immutable");

    // Raise-only: the current tier is accepted.
    const kept = await surface.cli(["events", "sensitivity", createdBody.id, "internal"]);
    expect(kept.code).toBe(0);
    expect((JSON.parse(kept.stdout) as { sensitivity: string }).sensitivity).toBe("internal");

    // PRIM-14: `confidential` is above this key's `internal` ceiling; the
    // server refuses (404 sensitivity_above_ceiling) and nothing changes.
    const raised = await surface.cli(["events", "sensitivity", createdBody.id, "confidential"]);
    expect(raised.code).not.toBe(0);
    expect(raised.stderr).toContain("read ceiling");
    const after = await surface.cli(["events", "show", createdBody.id]);
    expect(after.code).toBe(0);
    expect((JSON.parse(after.stdout) as { sensitivity: string }).sensitivity).toBe("internal");
  });
});

describe("mnemo timeline (B4.3)", () => {
  it("lists recent fact events", async () => {
    await surface.http("POST", "/remember", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: "B4.3 CLI timeline seed fact." }),
    });

    const result = await surface.cli(["timeline", "--limit", "10"]);
    expect(result.code).toBe(0);
    // printList prints a JSON envelope for a non-empty list.
    const body = JSON.parse(result.stdout) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
  });
});
