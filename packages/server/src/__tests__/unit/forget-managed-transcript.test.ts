import { describe, expect, it, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountForget } from "../../routes/forget.js";
import { toErrorBody } from "../../errors.js";

// APP-008: the route asks the storage port whether the id sits above the caller's ceiling.
const findHiddenIds = async (): Promise<string[]> => [];

function fixture(overrides: Record<string, unknown> = {}) {
  const forgetManagedTranscriptForEpisode = vi.fn(async () => ({
    sessionId: "session-1",
    turnsRemoved: 2,
  }));
  const forget = vi.fn(async () => undefined);
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.onError((error, c) => {
    const { status, body } = toErrorBody(error);
    return c.json(body, status as 400 | 403 | 404 | 500);
  });
  app.use("*", async (c, next) => {
    c.set("workspaceId", "workspace-a");
    c.set("scopes", ["memory:write", "memory:admin"]);
    c.set("actorId", "key-row-1");
    c.set("actorType", "user");
    c.set("userId", "user-1");
    await next();
  });
  mountForget(app, {
    cognitive: { forget },
    storage: { forgetManagedTranscriptForEpisode, findHiddenIds },
    ...overrides,
  } as unknown as ServerDeps);
  return { app, forget, forgetManagedTranscriptForEpisode };
}

describe("forgetting an episode also forgets its transcript", () => {
  it("erases the linked transcript, attributed to the caller", async () => {
    const { app, forgetManagedTranscriptForEpisode } = fixture();

    const res = await app.request("/forget/episode/episode-1", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(forgetManagedTranscriptForEpisode).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      episodeId: "episode-1",
      actorId: expect.stringMatching(/^(key|user|system|federation|peer):.+/),
    });
  });

  it("leaves other primitive kinds alone", async () => {
    const { app, forgetManagedTranscriptForEpisode } = fixture();

    await app.request("/forget/fact/fact-1", { method: "DELETE" });

    // Only an episode stands for a captured conversation; a fact does not.
    expect(forgetManagedTranscriptForEpisode).not.toHaveBeenCalled();
  });

  it("still reports the primitive forgotten when the transcript erasure fails", async () => {
    const { app } = fixture({
      storage: {
        findHiddenIds,
        forgetManagedTranscriptForEpisode: vi.fn(async () => {
          throw new Error("transcript store unavailable");
        }),
      },
    });

    // The episode is already forgotten by this point. Failing the request would
    // claim it was not, and retention erases the same rows on its own schedule.
    expect((await app.request("/forget/episode/episode-1", { method: "DELETE" })).status).toBe(200);
  });

  it("works against an adapter that predates the transcript port", async () => {
    const { app } = fixture({ storage: { findHiddenIds } });
    expect((await app.request("/forget/episode/episode-1", { method: "DELETE" })).status).toBe(200);
  });
});
