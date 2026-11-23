import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { suggestTopicKey } from "@mnemo-ai/core";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";

/**
 * POST /topic-key/suggest
 *
 * Pure, deterministic, idempotent `topicKey` derivation — no adapter, no
 * `withMnemoTx`, no DB round-trip. The handler reads nothing and writes
 * nothing; it only shapes the two input strings via
 * `@mnemo-ai/core`'s `suggestTopicKey()`. Mounted on `v1` next to
 * `mountRemember`, so it inherits the existing bearer-auth middleware even
 * though it performs no workspace-scoped I/O.
 *
 * See docs/archive/openspec/topickey-suggest-and-hit-freshness/design.md §1 for the
 * exact algorithm.
 */
export function mountTopicKeySuggest(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  _deps: ServerDeps
): void {
  app.openapi(
    createRoute({
      method: "post",
      path: "/topic-key/suggest",
      tags: ["memory"],
      summary: "Derive a deterministic topicKey from a subject/body pair.",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  subject: z.string().optional().openapi({
                    description:
                      "Fact subject or decision title. Combined with body to derive levels.",
                  }),
                  body: z.string().optional().openapi({
                    description: "Fact statement or decision body. Optional.",
                  }),
                  attribute: z.string().max(200).optional().openapi({
                    description:
                      "AGENTSIM-5. WHAT the fact is about (e.g. 'deploy method', 'runtime version'), not its current value. When given, the key is derived from subject + attribute and `body` is ignored, so an updated value gets the same key as the one it replaces and supersedes it. Omit for the legacy subject/body derivation.",
                  }),
                })
                .openapi("SuggestTopicKeyRequest"),
            },
          },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Derived topicKey.",
          content: {
            "application/json": {
              schema: z
                .object({
                  topicKey: z.string(),
                  levels: z.array(z.string()),
                  source: z.enum([
                    "identity",
                    "subject+body",
                    "subject",
                    "body",
                    "fallback",
                    "subject+attribute",
                    "attribute",
                  ]),
                })
                .openapi("SuggestTopicKeyResponse"),
            },
          },
        },
        401: { description: "Missing or invalid bearer token." },
      },
    }),
    (c) => {
      const body = c.req.valid("json");
      const suggestion = suggestTopicKey({
        subject: body.subject,
        body: body.body,
        ...(body.attribute !== undefined ? { attribute: body.attribute } : {}),
      });
      return c.json(suggestion, 200);
    }
  );
}
