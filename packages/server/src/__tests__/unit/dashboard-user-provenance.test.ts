import { Hono } from "hono";
import { expect, it } from "vitest";
import type { AuthVariables } from "../../auth.js";
import { resolveProvenance } from "../../provenance.js";
it("AUTH-12 distinguishes user principals from API key principals", async () => {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.get("/:kind", (c) => {
    c.set("actorId", "person-id");
    c.set("actorType", "user");
    c.set("userId", "person-id");
    if (c.req.param("kind") === "password") c.set("actorRefKind", "user");
    return c.json(resolveProvenance(c));
  });
  expect(await (await app.request("/password")).json()).toMatchObject({
    actorId: "user:person-id",
    userId: "person-id",
  });
  expect(await (await app.request("/apiKey")).json()).toMatchObject({ actorId: "key:person-id" });
});
