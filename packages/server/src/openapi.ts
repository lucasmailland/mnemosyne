import type { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";

/**
 * OpenAPI assembly.
 *
 * We host the generated spec at `/openapi.json` and a Scalar-powered
 * human reference at `/docs` — the `v1` router this is mounted on is itself
 * mounted at the app root (`app.route("/", v1)` in `app.ts`), not under a
 * `/v1` path prefix. Scalar was chosen over Swagger UI because
 * it's smaller, prettier, and supports OpenAPI 3.1 natively — Mnemosyne's
 * spec uses oneOf/nullable patterns that older Swagger UI versions choke on.
 *
 * The `securitySchemes` declaration here is what makes the "Authorize"
 * button show up in the docs — without it Scalar can't infer that every
 * endpoint expects a bearer token.
 */
export function mountOpenApi(app: OpenAPIHono<any>, version: string): void {
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      version,
      title: "Mnemosyne API",
      description:
        "Multi-tenant cognitive memory for AI systems. All endpoints require a bearer API key in the Authorization header.",
      license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    },
    servers: [{ url: "/", description: "current deployment" }],
  });

  // Declare the bearer security scheme so the docs render an Authorize
  // button and codegen tools emit the right auth helpers.
  app.openAPIRegistry.registerComponent("securitySchemes", "BearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "API Key",
  });

  app.get(
    "/docs",
    apiReference({
      spec: { url: "/openapi.json" },
      pageTitle: "Mnemosyne API Reference",
      theme: "purple",
    })
  );
}
