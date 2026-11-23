/**
 * B4.1 — HTTP route coverage fill-in: /admin/keys CRUD + rotate
 * (design.md "B4. Coverage fill-in", spec.md Requirement 13).
 *
 * B4.1 DISCOVERY, FIXED this session (migration
 * 0027_api_key_rotated_from_id.sql): `GET /admin/keys/:keyId` (showKeyRoute)
 * and `POST /admin/keys/:keyId/rotate` (`packages/server/src/routes/keys.ts`)
 * have always SELECTed/INSERTed a `rotated_from_id` column on
 * `mnemo_api_keys`, but that column never existed on the table — a genuine
 * missing migration, not a design mistake (the column already existed on the
 * unrelated `mnemo_scoped_api_keys` table for the same purpose). Both routes
 * 500'd with a real Postgres `42703 undefined_column` error against a
 * genuine database before the fix — confirmed via direct
 * `information_schema.columns` introspection, not assumed.
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

describe("admin keys routes (B4.1)", () => {
  it("POST /admin/keys, GET /admin/keys (list), DELETE revoke — the working half", async () => {
    const created = await json(
      await surface.http("POST", "/admin/keys", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "B4.1 test key", scopes: ["memory:read"] }),
      })
    );
    expect(created.id).toBeTruthy();
    expect(created.key).toMatch(/^mk_/);

    const listRes = await surface.http("GET", "/admin/keys");
    expect(listRes.status).toBe(200);
    const list = await json(listRes);
    expect(list.keys.some((k: any) => k.id === created.id)).toBe(true);

    const revokeRes = await surface.http("DELETE", `/admin/keys/${created.id}`);
    expect(revokeRes.status).toBe(200);
    const revoked = await json(revokeRes);
    expect(revoked.ok).toBe(true);
  });

  it("GET /admin/keys/:keyId — 200, rotatedFromId null for a never-rotated key", async () => {
    const created = await json(
      await surface.http("POST", "/admin/keys", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "B4.1 show-key repro", scopes: ["memory:read"] }),
      })
    );
    const res = await surface.http("GET", `/admin/keys/${created.id}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.id).toBe(created.id);
    expect(body.rotatedFromId).toBeNull();
  });

  it("POST /admin/keys/:keyId/rotate — 200, new key carries rotatedFromId back to the old one", async () => {
    const created = await json(
      await surface.http("POST", "/admin/keys", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "B4.1 rotate repro", scopes: ["memory:read"] }),
      })
    );
    const rotateRes = await surface.http("POST", `/admin/keys/${created.id}/rotate`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "B4.1 rotation test" }),
    });
    expect(rotateRes.status).toBe(201);
    const rotated = await json(rotateRes);
    expect(rotated.newKeyId).toBeTruthy();
    expect(rotated.newKeyId).not.toBe(created.id);

    const showNew = await json(await surface.http("GET", `/admin/keys/${rotated.newKeyId}`));
    expect(showNew.rotatedFromId).toBe(created.id);
  });
});
