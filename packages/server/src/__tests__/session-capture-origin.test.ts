import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../../../types/src/testing/InMemoryStorageAdapter.js";
import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { toErrorBody } from "../errors.js";
import { mountSession } from "../routes/session.js";

const ws = "00000000-0000-4000-8000-000000000101";
function fixture() {
  const storage = new InMemoryStorageAdapter();
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", ws);
    c.set("actorId", "capture");
    c.set("actorType", "agent");
    await next();
  });
  app.onError((err, c) => {
    const e = toErrorBody(err);
    return c.json(e.body, e.status as 409);
  });
  mountSession(app, { storage } as unknown as ServerDeps);
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { storage, post };
}

describe("typed capture provenance", () => {
  it("persists traffic, turn origin and evidence independently of role and actor", async () => {
    const { storage, post } = fixture();
    const start = await post("/session/start", {});
    const session = await start.json();
    expect(session.trafficOrigin).toBe("organic");
    const content = "<task-notification>job complete</task-notification>";
    expect(
      (
        await post(`/session/${session.id}/turn`, {
          role: "user",
          content,
          turnOrigin: "task_notification",
          turnOriginEvidence: "host:task_notification",
          sourceMessageId: "native-1",
        })
      ).status
    ).toBe(204);
    expect(await storage.listTurns(session.id, ws)).toEqual([
      expect.objectContaining({
        role: "user",
        content,
        turnOrigin: "task_notification",
        turnOriginEvidence: "host:task_notification",
        sourceMessageId: "native-1",
      }),
    ]);
    expect((await storage.getSession(session.id, ws))?.metadata.actorId).toBe("key:capture");
  });
  it("rejects caller supplied evaluation origin without authorized credential configuration", async () => {
    const { post } = fixture();
    expect((await post("/session/start", { trafficOrigin: "evaluation" })).status).toBe(403);
  });
  it("returns a structured terminal cause while managed fencing stays distinct", async () => {
    const { storage, post } = fixture();
    const { id } = await (await post("/session/start", {})).json();
    await storage.closeSession(id, ws);
    const res = await post(`/session/${id}/turn`, { role: "user", content: "late" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.details.cause).toBe("SESSION_TERMINAL");
  });
});
