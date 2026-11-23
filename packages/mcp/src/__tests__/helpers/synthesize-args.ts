/**
 * B1.2 — generic zod (v4) arg synthesizer.
 *
 * Produces a minimal-valid object for a tool's `inputSchema` (a
 * `ZodRawShape` — a plain record of zod types, not a `ZodObject`) without
 * hand-writing one fixture per tool. Handlers are invoked directly,
 * bypassing the MCP SDK's own request-time validation (the same trick
 * `registry.test.ts` already uses), so a minimal-valid object is enough to
 * reach each tool's real branch logic.
 *
 * Algorithm (matches design.md's B1 zod-synthesis rule exactly):
 *   string  -> "x"
 *   number  -> 1
 *   boolean -> false
 *   enum    -> first declared member
 *   array   -> []
 *   object  -> recurse
 *   record  -> {}
 *   optional / default -> OMIT the key entirely (relies on each tool's own
 *     `?? fallback` normalization — an established repo convention; see
 *     e.g. `forget.ts`'s own comment on this exact point).
 *
 * This intentionally does NOT satisfy branch-specific guards that live in
 * a tool's own handler code (e.g. "`create` requires `name` and `kind`") —
 * those aren't expressible in a flat zod shape. Branching tools get an
 * explicit per-branch override table in `tool-route-map.test.ts` instead.
 */
import type { z } from "zod";

type ZodRawShapeLike = Record<string, z.ZodTypeAny>;

interface ZodDefLike {
  type: string;
  innerType?: z.ZodTypeAny;
  shape?: ZodRawShapeLike;
  entries?: Record<string, unknown> | unknown[];
  element?: z.ZodTypeAny;
}

function defOf(schema: z.ZodTypeAny): ZodDefLike {
  return (schema as unknown as { _def: ZodDefLike })._def;
}

/** Synthesizes one value for a single zod type, or `undefined` to signal "omit this key". */
function synthesizeValue(schema: z.ZodTypeAny): unknown {
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
    case "default":
    case "nullable":
      return SKIP;
    case "string":
      return "x";
    case "number":
      return 1;
    case "boolean":
      return false;
    case "enum": {
      const entries = def.entries;
      const values = Array.isArray(entries) ? entries : Object.values(entries ?? {});
      return values[0];
    }
    case "array":
      return [];
    case "object":
      return synthesizeShape(def.shape ?? {});
    case "record":
      return {};
    default:
      // Unions, unknown/any, custom refinements, etc. — "x" is a harmless
      // default for a field that isn't itself branch-gating (any field
      // whose value genuinely matters for a specific branch gets an
      // explicit override in tool-route-map.test.ts's ACTION_FIXTURES).
      return "x";
  }
}

const SKIP = Symbol("synthesize-args:skip");

/** Synthesizes a minimal-valid object from a tool's `inputSchema` ZodRawShape. */
export function synthesizeShape(shape: ZodRawShapeLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(shape)) {
    const value = synthesizeValue(schema);
    if (value === SKIP) continue;
    out[key] = value;
  }
  return out;
}
