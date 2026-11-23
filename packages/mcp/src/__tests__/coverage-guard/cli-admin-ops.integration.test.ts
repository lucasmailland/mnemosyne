/**
 * B4.3 — CLI command coverage fill-in: operational/admin commands (design.md
 * "B4. Coverage fill-in", spec.md Requirement 13). Exercises `mnemo health`,
 * `export`, `import`, `doctor`, `keys`, `reset`, `consolidate`, `judge`,
 * `purge`, `remind` via `surface.cli(args)` — the real built `mnemo` binary
 * as a subprocess against the live server.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("mnemo health (B4.3)", () => {
  it("prints readiness and detail health JSON", async () => {
    const result = await surface.cli(["health"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Readiness:");
    expect(result.stdout).toContain("Detail:");
  });
});

describe("mnemo export (B4.3)", () => {
  it("workspace-only default key: real 403 user_binding_required (matches B4.1's HTTP finding)", async () => {
    const result = await surface.cli(["export"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("403");
  });

  it("user-bound key, no --approval-request-id: prints the pending request id and how to approve it (exit code 2)", async () => {
    const result = await surface.cli(["export"], {
      MNEMO_KEY: surface.secondaryIdentities.userA.apiKey,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Export requires approval");
    expect(result.stderr).toMatch(/Approval request id: \S+/);
    expect(result.stderr).toContain("mnemo export --approval-request-id");
  });

  it("full round trip: request -> a DIFFERENT identity approves -> --approval-request-id completes the real JSONL export", async () => {
    // Fixed this session (was previously a real gap — see git history for
    // the finding). userA requests, userB approves (dual control —
    // self-approval is rejected server-side, matching
    // routes-export-import-admin.integration.test.ts's raw-HTTP round trip).
    const { userA, userB } = surface.secondaryIdentities;

    const pendingResult = await surface.cli(["export"], { MNEMO_KEY: userA.apiKey });
    expect(pendingResult.code).toBe(2);
    const match = pendingResult.stderr.match(/Approval request id: (\S+)/);
    const approvalRequestId = match?.[1];
    expect(approvalRequestId).toBeTruthy();

    const approveRes = await surface.http("POST", `/approvals/${approvalRequestId}/resolve`, {
      headers: { authorization: `Bearer ${userB.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(approveRes.status).toBe(200);

    const completed = await surface.cli(
      ["export", "--approval-request-id", approvalRequestId as string],
      { MNEMO_KEY: userA.apiKey }
    );
    expect(completed.code).toBe(0);
    // Real, observed behavior — not what the CLI's own doc comment claims
    // (fixed alongside this test, see cmdExport's updated comment):
    // Node's fetch() transparently decompresses a `Content-Encoding: gzip`
    // response body, so `response.arrayBuffer()` already yields the plain
    // JSONL text, not raw gzip bytes. Assert the real JSONL shape: a
    // versioned header line, one JSON object per line.
    const lines = completed.stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    const header = JSON.parse(lines[0] as string);
    expect(header._type).toBe("header");
    expect(header.version).toBe("mnemo-export-v1");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("mnemo import (B4.3)", () => {
  it("imports a plain (non-gzip) JSONL file — the route falls back to plain text when gunzip fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mnemo-b4.3-import-"));
    const file = join(dir, "seed.jsonl");
    const lines = [
      JSON.stringify({ version: "mnemo-export-v1" }),
      JSON.stringify({
        _type: "fact",
        statement: "B4.3 CLI import: imported fact via mnemo import.",
        subject: "b4.3-cli-import",
      }),
    ];
    writeFileSync(file, lines.join("\n") + "\n");

    const result = await surface.cli(["import", file]);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as { imported: Record<string, number> };
    expect(body.imported.fact).toBeGreaterThanOrEqual(1);
  });
});

describe("mnemo doctor (B4.3)", () => {
  it("prints the real doctor diagnostic report", async () => {
    const result = await surface.cli(["doctor"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Mnemosyne Doctor");
  });
});

describe("mnemo keys (B4.3)", () => {
  it("create, list, show, revoke", async () => {
    const created = await surface.cli([
      "keys",
      "create",
      "--label",
      "b4.3-cli-key",
      "--scopes",
      "memory:read,memory:write",
    ]);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("Key created");
    const idMatch = created.stdout.match(/ID:\s+(\S+)/);
    expect(idMatch).toBeTruthy();
    const keyId = idMatch![1]!;

    const list = await surface.cli(["keys", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(keyId);

    const show = await surface.cli(["keys", "show", keyId]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain(keyId);

    const revoked = await surface.cli(["keys", "revoke", keyId]);
    expect(revoked.code).toBe(0);
    // V-11: confirmations are status lines on stderr.
    expect(revoked.stderr).toContain(`Key ${keyId} revoked`);
  });
});

describe("mnemo reset (B4.3)", () => {
  it("dry-run safety check against /admin/embedding-migrations", async () => {
    const result = await surface.cli(["reset", "--workspace", surface.workspaceId, "--confirm"]);
    expect(result.code).toBe(0);
    // V-11: confirmations are status lines on stderr.
    expect(result.stderr).toContain(
      `Safe reset check completed for workspace ${surface.workspaceId}`
    );
  });
});

describe("mnemo consolidate (B4.3)", () => {
  it("fast-mode manual tick — the only mode/dryRun combination the server accepts outside a scheduled tick", async () => {
    const result = await surface.cli(["consolidate"]);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as { accepted: boolean; mode: string };
    expect(body.accepted).toBe(true);
    expect(body.mode).toBe("fast");
  });
});

describe("mnemo judge (B4.3)", () => {
  it("list finds a real conflicts_with pair, resolve keeps both", async () => {
    const factA = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.3 CLI judge: fact A says X." }),
      })
    );
    const factB = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.3 CLI judge: fact B says NOT X." }),
      })
    );
    const related = await surface.cli([
      "relate",
      "fact",
      factA.id,
      "conflicts_with",
      "fact",
      factB.id,
    ]);
    expect(related.code).toBe(0);
    const relatedBody = JSON.parse(related.stdout) as { id: string };

    const listed = await surface.cli(["judge", "list", "--limit", "20"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(relatedBody.id);

    const resolved = await surface.cli(["judge", "resolve", relatedBody.id, "keep_both"]);
    expect(resolved.code).toBe(0);
  });
});

describe("mnemo purge (B4.3)", () => {
  it("hard-deletes a fact — real, irreversible, and different from forget's soft-delete", async () => {
    const created = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.3 CLI purge: fact to hard-delete." }),
      })
    );

    const result = await surface.cli(["purge", created.id, "--confirm"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Purged");
    expect(result.stderr).toContain(created.id);

    const after = await surface.http("GET", `/facts/${created.id}`);
    expect(after.status).toBe(404);
  });
});

describe("mnemo remind (B4.3)", () => {
  it("create, list, dismiss", async () => {
    const created = await surface.cli([
      "remind",
      "create",
      "--content",
      "B4.3 CLI reminder coverage",
      "--condition",
      "when the b4.3 CLI test suite runs",
    ]);
    expect(created.code).toBe(0);
    const createdBody = JSON.parse(created.stdout) as { id: string };

    const list = await surface.cli(["remind", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(createdBody.id);

    const dismissed = await surface.cli(["remind", "dismiss", createdBody.id]);
    expect(dismissed.code).toBe(0);
    expect(dismissed.stderr).toContain("Dismissed");
    expect(dismissed.stderr).toContain(createdBody.id);
  });
});
