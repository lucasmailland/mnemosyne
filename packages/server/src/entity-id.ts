/**
 * The accepted shapes for `mnemo_entity.id`, in one place.
 *
 * `mnemo_entity.id` is a bare `text` primary key with no default and no CHECK
 * (`adapter-postgres/src/schema/entities.ts`), so any route-level check is an
 * allowlist rather than a mirror of a database constraint. Two routes wrote
 * that allowlist independently — `/entities/{id}` and `/graph?focus=` — and
 * both allowed a shape nothing produces while rejecting the only shape
 * everything produces:
 *
 *   const ENTITY_ID_PATTERN = /^ment_[a-z0-9_]{1,64}$/   // entities.ts
 *   const FOCUS_ID_PATTERN  = /^ment_[a-z0-9_]{1,64}$/   // graph.ts
 *
 * Every adapter mints entity ids with `uuid()`. A grep for a `ment_` generator
 * outside the test tree returns only OpenAPI `example:` strings — no code path
 * in any adapter has ever emitted one. Measured against a live stack: 2 of 2
 * rows in `mnemo_entity` were uuids, 0 matched `ment_`. So `POST /entities`
 * answered 201 with an id its own `GET` rejected as malformed, which took down
 * five of the seven actions `memory_entity` exposes (get, linked_facts,
 * update, link_user, unlink_user) plus the focused graph view.
 *
 * The `ment_` arm is kept because seeded fixtures and older deployments carry
 * ids in that shape; dropping it would strand them. Both arms stay anchored so
 * a path segment cannot smuggle separators or whitespace through.
 */

const ENTITY_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_ID_LEGACY_SLUG = /^ment_[a-z0-9_]{1,64}$/;

/** Human-readable form of the rule, for zod `message` fields. */
export const ENTITY_ID_MESSAGE = "must be a uuid, or a legacy ment_<slug> seed id";

/** An example that is actually representative of what the system stores. */
export const ENTITY_ID_EXAMPLE = "d0522e17-bd87-4ced-bc38-2b9a499beea7";

export function isEntityId(id: string): boolean {
  return ENTITY_ID_UUID.test(id) || ENTITY_ID_LEGACY_SLUG.test(id);
}
