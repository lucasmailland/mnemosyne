/**
 * B3.1 — proves `startLiveSurface()` actually boots a real server and tears
 * down cleanly, rather than trusting the extraction to compile and calling
 * it done. Deliberately minimal: one `/health` round trip through each of
 * the three network-facing surfaces (`http`, `sdk`, `cli`) plus the
 * already-connected `mcp` client's `tools/list`. Real coverage of every
 * route/tool/command is B4's job (not authorized this task) — this file
 * only proves the harness itself is usable.
 *
 * Requires Docker + Node >=22 — see `live-surface.ts`'s module doc.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "./live-surface.js";

let surface: LiveSurface;

beforeAll(async () => {
  surface = await startLiveSurface();
}, 180_000);

afterAll(async () => {
  await surface?.close();
}, 60_000);

describe("live-surface harness (B3.1)", () => {
  it("boots a real server reachable over raw HTTP", async () => {
    const res = await surface.http("GET", "/health");
    expect(res.ok).toBe(true);
  });

  it("exposes a real, already-connected MCP stdio client", async () => {
    const result = await surface.mcp.listTools();
    expect(result.tools.length).toBeGreaterThan(0);
  });

  it("exposes a real SDK client bound to the harness server", async () => {
    const me = await surface.sdk.getMe();
    expect(me).toBeTruthy();
  });

  it("spawns the real built CLI binary as a subprocess", async () => {
    const result = await surface.cli(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });
}, 60_000);
