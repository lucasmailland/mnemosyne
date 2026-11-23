import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MnemosyneClient } from "../index.js";

const BASE = "https://memory.test";
const API_KEY = "test-key";

const server = setupServer(
  // appendTurn → POST /session/:id/turn (204 No Content)
  http.post(`${BASE}/session/:id/turn`, async ({ request, params }) => {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${API_KEY}`) {
      return new HttpResponse(null, { status: 401 });
    }
    const body = (await request.json()) as { role?: string; content?: string };
    if (!body.role || !body.content) {
      return new HttpResponse(null, { status: 400 });
    }
    return new HttpResponse(null, { status: 204 });
  }),

  // pinSessionTurn → POST /session/:id/pin (204 No Content)
  http.post(`${BASE}/session/:id/pin`, async ({ request }) => {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${API_KEY}`) {
      return new HttpResponse(null, { status: 401 });
    }
    const body = (await request.json()) as { turnId?: string; pinned?: boolean };
    if (body.turnId === undefined || body.pinned === undefined) {
      return new HttpResponse(null, { status: 400 });
    }
    return new HttpResponse(null, { status: 204 });
  }),

  // createSession → POST /session/start
  http.post(`${BASE}/session/start`, () => {
    return HttpResponse.json({
      id: "ses_test_1",
      agentId: null,
      status: "active",
      createdAt: "2026-06-20T00:00:00.000Z",
    });
  }),

  // collapseSession → POST /session/:id/collapse
  http.post(`${BASE}/session/:id/collapse`, () => {
    return HttpResponse.json({ accepted: true, sessionId: "ses_test_1" });
  })
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient() {
  return new MnemosyneClient({ url: BASE, apiKey: API_KEY });
}

describe("MnemosyneClient.appendTurn", () => {
  it("resolves to void on success (204)", async () => {
    const client = makeClient();
    const result = await client.appendTurn("ses_test_1", {
      role: "user",
      content: "Hello Mnemosyne!",
    });
    expect(result).toBeUndefined();
  });

  it("APP-018: a turn has no metadata field to send", () => {
    // Compile-time: metadata is not part of AppendTurnInput any more.
    const input: import("../types.js").AppendTurnInput = { role: "user", content: "x" };
    // @ts-expect-error metadata was removed: the server refuses it with 400
    const withMetadata: import("../types.js").AppendTurnInput = { ...input, metadata: {} };
    expect(withMetadata).toBeDefined();
  });

  it("URL-encodes the session ID", async () => {
    let capturedPath: string | undefined;
    server.use(
      http.post(`${BASE}/session/:id/turn`, ({ params }) => {
        capturedPath = params.id as string;
        return new HttpResponse(null, { status: 204 });
      })
    );

    const client = makeClient();
    await client.appendTurn("ses/special id", {
      role: "user",
      content: "test",
    });

    // msw decodes the param automatically — confirm the raw URL was encoded
    expect(capturedPath).toBe("ses/special id");
  });
});

describe("MnemosyneClient.pinSessionTurn", () => {
  it("resolves to void when pinning a turn (204)", async () => {
    const client = makeClient();
    const result = await client.pinSessionTurn("ses_test_1", {
      turnId: "turn_abc",
      pinned: true,
    });
    expect(result).toBeUndefined();
  });

  it("sends pinned=false to unpin a turn", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(`${BASE}/session/:id/pin`, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      })
    );

    const client = makeClient();
    await client.pinSessionTurn("ses_test_1", {
      turnId: "turn_xyz",
      pinned: false,
    });

    expect(capturedBody).toEqual({ turnId: "turn_xyz", pinned: false });
  });
});

describe("MnemosyneClient.sessions (chaining helper)", () => {
  it("create delegates to createSession", async () => {
    const client = makeClient();
    const res = await client.sessions.create();
    expect(res.id).toBe("ses_test_1");
    expect(res.status).toBe("active");
  });

  it("addTurn delegates to appendTurn", async () => {
    const client = makeClient();
    const result = await client.sessions.addTurn("ses_test_1", {
      role: "user",
      content: "via sessions.addTurn",
    });
    expect(result).toBeUndefined();
  });

  it("pinTurn delegates to pinSessionTurn", async () => {
    const client = makeClient();
    const result = await client.sessions.pinTurn("ses_test_1", {
      turnId: "turn_abc",
      pinned: true,
    });
    expect(result).toBeUndefined();
  });

  it("collapse delegates to collapseSession", async () => {
    const client = makeClient();
    const res = await client.sessions.collapse("ses_test_1");
    expect(res.accepted).toBe(true);
    expect(res.sessionId).toBe("ses_test_1");
  });

  it("full chaining workflow: create → addTurn → pinTurn → collapse", async () => {
    const client = makeClient();
    const { id } = await client.sessions.create();
    await client.sessions.addTurn(id, { role: "user", content: "Remember X." });
    await client.sessions.addTurn(id, { role: "assistant", content: "Noted." });
    await client.sessions.pinTurn(id, { turnId: "turn_1", pinned: true });
    const res = await client.sessions.collapse(id);
    expect(res.accepted).toBe(true);
  });
});
