import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time byte compare. Length is compared first and leaks (unavoidable —
 * `timingSafeEqual` throws on unequal lengths); content comparison does not.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
