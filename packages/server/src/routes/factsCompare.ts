import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { ServerDeps } from "../deps.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { AuthVariables } from "../auth.js";
import { assertCanReadFact, dropHiddenPointers } from "../rbac.js";
import { toApiFact } from "../mappers.js";
import { compareFacts } from "../facts/compare.js";
import { FactSchema } from "./facts.js";
import type { MnemoFact } from "@mnemo-ai/types";
import type { Context } from "hono";

/**
 * POST /facts/compare
 *
 * Server-owned relocation of what `memory_compare` used to compute locally
 * (docs/archive/openspec/decompose-recall-and-compare, Slice 2, design.md D2/D3). Fetches
 * both facts via the exact same 3-step read guard `GET /facts/:id` uses —
 * `deps.storage.getFact` → active/open-interval check → `assertCanReadFact`
 * (404, not 403 — S6 anti-probing) → `toApiFact` — then hands both wire
 * facts to the pure `compareFacts` (`../facts/compare.ts`). Either id
 * missing, closed, or above the caller's sensitivity ceiling ⇒ 404. No
 * `withMnemoTx`: `storage.getFact` owns its own workspace-GUC transaction,
 * same as every other `facts.ts` handler.
 */

const CompareFactsRequestSchema = z
  .object({
    factIdA: z.string().min(1).openapi({ description: "ID of the first fact (mfact_…)." }),
    factIdB: z.string().min(1).openapi({ description: "ID of the second fact (mfact_…)." }),
  })
  .openapi("CompareFactsRequest");

const CompareFactsResponseSchema = z
  .object({
    factA: FactSchema,
    factB: FactSchema,
    differences: z.array(z.string()),
    suggestedVerb: z.enum(["supersedes", "conflicts_with", "compatible", "scoped"]),
    sameSubject: z.boolean(),
  })
  .openapi("CompareFactsResponse");

async function resolveReadableFact(
  c: Context<{ Variables: AuthVariables }>,
  deps: ServerDeps,
  id: string
): Promise<MnemoFact> {
  const workspaceId = c.get("workspaceId");
  if (!deps.storage) throw new BadRequestError("storage adapter not available");
  const fact = await deps.storage.getFact(id, workspaceId);
  if (!fact || fact.validTo != null || fact.status !== "active") {
    throw new NotFoundError(`Fact ${id} not found`);
  }
  assertCanReadFact(c, id, fact.sensitivity);
  return fact;
}

export function mountFactsCompare(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(
    createRoute({
      method: "post",
      path: "/facts/compare",
      tags: ["facts"],
      summary: "Compare two facts by id: field differences, sameSubject, suggested relation verb.",
      request: {
        body: {
          content: { "application/json": { schema: CompareFactsRequestSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: "The comparison result.",
          content: { "application/json": { schema: CompareFactsResponseSchema } },
        },
        404: {
          description:
            "Either fact not found in this workspace (or above the sensitivity ceiling).",
        },
      },
    }),
    async (c) => {
      const { factIdA, factIdB } = c.req.valid("json");
      const [factA, factB] = await Promise.all([
        resolveReadableFact(c, deps, factIdA),
        resolveReadableFact(c, deps, factIdB),
      ]);
      const [wireA, wireB] = (await dropHiddenPointers(
        c,
        deps.storage!,
        c.get("workspaceId"),
        [toApiFact(factA), toApiFact(factB)],
        { ids: ["episodeId"] }
      )) as [ReturnType<typeof toApiFact>, ReturnType<typeof toApiFact>];
      const { differences, suggestedVerb, sameSubject } = compareFacts(wireA, wireB);
      return c.json({ factA: wireA, factB: wireB, differences, suggestedVerb, sameSubject }, 200);
    }
  );
}
