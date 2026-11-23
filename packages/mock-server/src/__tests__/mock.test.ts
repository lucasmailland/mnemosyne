/**
 * AB6.4 — Mock server tests (spec §35 line 4298 "offline dev").
 * Boot the mock, verify deterministic fixture responses.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createMockApp } from "../app.js";
import type { Server } from "node:http";

let server: Server | null = null;
let BASE = "";

beforeAll(async () => {
  const { app, port } = await createMockApp(0); // 0 = random port
  server = app.server as Server;
  BASE = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

describe("Mock server — fixture responses", () => {
  it("POST /recall → 200 with deterministic hits", async () => {
    const res = await fetch(`${BASE}/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mk_test_mock" },
      body: JSON.stringify({ query: "test", topK: 5 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits?: unknown[] };
    expect(Array.isArray(body.hits)).toBe(true);
    expect((body.hits as unknown[]).length).toBeGreaterThan(0);
  });

  it("POST /remember → 201 with id", async () => {
    const res = await fetch(`${BASE}/remember`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mk_test_mock" },
      body: JSON.stringify({ statement: "hello world" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id?: string };
    expect(typeof body.id).toBe("string");
  });

  it("GET /health → { status: 'ok' }", async () => {
    const res = await fetch(`${BASE}/health`, {
      headers: { Authorization: "Bearer mk_test_mock" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe("ok");
  });

  it("GET /usage → { recall: { used, limit } }", async () => {
    const res = await fetch(`${BASE}/usage`, {
      headers: { Authorization: "Bearer mk_test_mock" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("recall");
  });

  it("GET /sessions → { items: [] }", async () => {
    const res = await fetch(`${BASE}/sessions`, {
      headers: { Authorization: "Bearer mk_test_mock" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items?: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("unknown route → 404", async () => {
    const res = await fetch(`${BASE}/nonexistent`, {
      headers: { Authorization: "Bearer mk_test_mock" },
    });
    expect(res.status).toBe(404);
  });
});
