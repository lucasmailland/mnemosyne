import { z } from "zod";

// zod's own date regex (calendar-aware, leap years), without the anchors.
const DATE = z.regexes.date.source.slice(1, -1);
const TIME = "(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?";
const OFFSET = "[+-](?:[01]\\d|2[0-3]):[0-5]\\d";

const UTC_ONLY = new RegExp(`^${DATE}T(?:${TIME}(?:Z))$`);
const WITH_OFFSET = new RegExp(`^${DATE}T(?:${TIME}(?:Z|(${OFFSET})))$`);

/**
 * ISO 8601 date-time for request inputs. Seconds and fractions are optional
 * (`2026-08-01T09:00Z`, `…T09:00:00Z`, `…T09:00:00.000Z`): the set
 * `z.string().datetime()` accepted before zod 4.5 made seconds mandatory.
 * Same issue (`invalid_format`, format `datetime`), same JSON Schema
 * (`format: date-time`). Responses keep zod's strict `datetime()`.
 */
export function isoDateTimeInput(opts: { offset?: boolean } = {}) {
  return z.stringFormat("datetime", opts.offset ? WITH_OFFSET : UTC_ONLY);
}
