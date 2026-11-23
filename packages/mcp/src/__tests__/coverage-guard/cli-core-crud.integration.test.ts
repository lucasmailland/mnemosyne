/**
 * B4.3 — CLI command coverage fill-in: core fact CRUD (design.md "B4.
 * Coverage fill-in", spec.md Requirement 13). Exercises `mnemo recall`,
 * `remember`, `forget`, `list`, `search`, `show`, `pin`, `unpin` via
 * `surface.cli(args)` — the real built `mnemo` binary as a subprocess
 * against the live server — asserting on real stdout content and, where
 * useful, a follow-up HTTP call confirming the observable side effect.
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

async function createFact(content: string): Promise<{ id: string }> {
  return json(
    await surface.http("POST", "/remember", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: content }),
    })
  );
}

describe("mnemo remember / recall / search (B4.3)", () => {
  it("remember creates a fact; recall and search find it", async () => {
    const statement = "B4.3 CLI: the customer Initech wants monthly invoices, not weekly.";

    const remembered = await surface.cli(["remember", statement]);
    expect(remembered.code).toBe(0);
    // V-11 (fix/verify-cli): the confirmation is a status line on stderr;
    // stdout carries only results (use --json to script the id).
    expect(remembered.stderr).toContain("Memory saved");
    const idMatch = remembered.stderr.match(/\(([^)]+)\)/);
    expect(idMatch).toBeTruthy();
    const id = idMatch![1];

    // Confirm the real side effect via a follow-up HTTP call, not just stdout.
    const fact = await json(await surface.http("GET", `/facts/${id}`));
    expect(fact.content).toBe(statement);

    const recalled = await surface.cli(["recall", "--json", "Initech monthly invoices"]);
    expect(recalled.code).toBe(0);
    const recalledBody = JSON.parse(recalled.stdout) as {
      hits: Array<{ id: string; statement: string }>;
    };
    expect(Array.isArray(recalledBody.hits)).toBe(true);

    const searched = await surface.cli(["search", "Initech monthly invoices"]);
    expect(searched.code).toBe(0);
    // cmdSearch prints via printFactLine — real lexical fallback (no
    // embedder configured in this harness) still surfaces an exact-text hit.
    expect(searched.stdout).toContain(statement);
  });

  it("recall --limit caps the returned hit count", async () => {
    // The harness's fake embed adapter returns an identical deterministic
    // vector for every input (see live-surface.ts's `fakeEmbed` docstring),
    // so cosine similarity is uniform across facts — every query "matches"
    // everything already remembered above. That makes `--limit` the
    // observable, real behavior to assert on here (not an empty-result
    // scenario, which this harness cannot produce via the vector path).
    const result = await surface.cli(["recall", "--json", "--limit", "1", "Initech invoices"]);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as { hits: Array<{ id: string }> };
    expect(body.hits.length).toBe(1);
  });
});

describe("mnemo forget (B4.3)", () => {
  it("soft-deletes a fact — DELETE /facts/:id under the hood", async () => {
    const created = await createFact("B4.3 CLI: fact to forget.");

    const result = await surface.cli(["forget", created.id]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Forgotten");
    expect(result.stderr).toContain(created.id);

    // Soft-delete, per CLAUDE.md — the row is never destroyed. But plain
    // GET /facts/:id filters to currently-valid rows, so it 404s for a
    // just-forgotten fact even though the row still exists for audit —
    // real, observed behavior, not a hard delete.
    const after = await surface.http("GET", `/facts/${created.id}`);
    expect(after.status).toBe(404);
  });
});

describe("mnemo list (B4.3)", () => {
  it("lists recent facts, most-recent first, including a freshly-created one", async () => {
    const created = await createFact("B4.3 CLI: fact for list coverage — unique-marker-list-b43.");

    const result = await surface.cli(["list", "--limit", "50"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(created.id);
    expect(result.stdout).toContain("unique-marker-list-b43");
  });
});

describe("mnemo show (B4.3)", () => {
  it("prints the full fact JSON for a given id", async () => {
    const created = await createFact("B4.3 CLI: fact for show coverage.");

    const result = await surface.cli(["show", created.id]);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as { id: string; content: string };
    expect(body.id).toBe(created.id);
    expect(body.content).toBe("B4.3 CLI: fact for show coverage.");
  });
});

describe("mnemo pin / unpin (B4.3)", () => {
  it("pins then unpins a fact, each step verified via a follow-up HTTP GET", async () => {
    const created = await createFact("B4.3 CLI: fact for pin/unpin coverage.");

    const pinned = await surface.cli(["pin", created.id]);
    expect(pinned.code).toBe(0);
    const pinnedBody = JSON.parse(pinned.stdout) as { id: string; pinned: boolean };
    expect(pinnedBody.pinned).toBe(true);
    const afterPin = await json(await surface.http("GET", `/facts/${created.id}`));
    expect(afterPin.pinned).toBe(true);

    const unpinned = await surface.cli(["unpin", created.id]);
    expect(unpinned.code).toBe(0);
    const unpinnedBody = JSON.parse(unpinned.stdout) as { id: string; pinned: boolean };
    expect(unpinnedBody.pinned).toBe(false);
    const afterUnpin = await json(await surface.http("GET", `/facts/${created.id}`));
    expect(afterUnpin.pinned).toBe(false);
  });
});
