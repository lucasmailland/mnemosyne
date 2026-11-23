// Shared zod schema primitives (TASK-5006: zod unification).
//
// All routes should import from here instead of defining inline schemas for
// common parameters. This ensures consistent validation rules and OpenAPI
// descriptions across the entire API surface.

import { z } from "@hono/zod-openapi";

// ── Identity primitives ───────────────────────────────────────────────────────

/** A non-empty string used as a resource identifier. */
export const IdSchema = z.string().min(1).openapi({ example: "fact_01hwz..." });

/** workspace_id from the auth context — always a non-empty string. */
export const WorkspaceIdSchema = z.string().min(1).openapi({
  example: "ws_01hwz...",
  description: "Workspace identifier (taken from API key scope).",
});

/** Standard `{id}` path-parameter object for routes like GET /facts/{id}. */
export const IdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: "id", in: "path" },
      example: "fact_01HXY...",
    }),
});

// ── Pagination primitives ─────────────────────────────────────────────────────

/**
 * Standard page-size parameter.
 * Routes can override `.max()` for resource-specific ceilings.
 */
export const LimitSchema = z.coerce.number().int().min(1).max(500).default(50).openapi({
  description: "Maximum number of items to return per page (1–500).",
  example: 50,
});

/** Zero-based page offset for offset-based pagination. */
export const OffsetSchema = z.coerce.number().int().min(0).default(0).openapi({
  description: "Zero-based offset (number of items to skip).",
  example: 0,
});

/**
 * Standard offset + limit query parameters used by most list endpoints.
 * Routes with non-standard ceilings (e.g. max 20 or max 500) should define
 * their own limit schema via `LimitSchema.max(N)`.
 */
export const OffsetPaginationSchema = z.object({
  offset: OffsetSchema,
  limit: z.coerce.number().int().min(1).max(200).default(50).openapi({
    description: "Maximum number of items to return (1–200).",
    example: 50,
  }),
});

/** Opaque cursor token returned by the previous page response. */
export const CursorSchema = z.string().optional().openapi({
  description: "Pagination cursor from a previous response's `nextCursor` field.",
});

/** Standard paginated-list response wrapper. */
export function PaginatedSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable().openapi({
      description:
        "Pass this value as `cursor` to fetch the next page. Null when on the last page.",
    }),
    total: z.number().int().openapi({
      description: "Total count of matching items (ignoring pagination).",
    }),
  });
}

// ── Content primitives ────────────────────────────────────────────────────────

/** A non-empty statement or content string (max 50 000 chars). */
export const StatementSchema = z.string().min(1).max(50_000).openapi({
  description: "Free-form text content. Keep it atomic — one claim per fact.",
});

/** Provenance metadata bag. */
export const AttributionSchema = z.record(z.string(), z.unknown()).default({}).openapi({
  description: "Provenance bag. Recommended keys: source, actor, message_id, timestamp.",
});

/** Flat tag list for filtering and rollups. */
export const TagsSchema = z.array(z.string().min(1).max(200)).max(64).default([]).openapi({
  description: "Optional string tags (max 64, each ≤ 200 chars).",
});

// ── Date helpers ──────────────────────────────────────────────────────────────

/**
 * Converts a Date, ISO string, or null/undefined to an ISO string or null.
 * Use this in route handlers instead of defining local toIso arrow functions.
 */
export function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  // Already an ISO string — return as-is; otherwise parse and normalise.
  return value.includes("T") ? value : new Date(value).toISOString();
}
