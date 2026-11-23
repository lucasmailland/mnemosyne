/**
 * Shared JSON-Schema-lite structural validator for contract + parity tests.
 *
 * Extracted from `unit/contracts.test.ts` (Wave V §36) so Tier A parity
 * tests (design.md D3, `__tests__/parity/*.parity.test.ts`) can validate
 * response shapes against `packages/server/contracts/*.schema.json` without
 * duplicating the hand-rolled structural checker. Behavior is unchanged —
 * this is a pure extraction.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/server/src/__tests__
// ../.. = packages/server
export const contractsDir = join(__dirname, "..", "..", "contracts");

export function loadSchema(name: string): Record<string, unknown> {
  const raw = readFileSync(join(contractsDir, `${name}.schema.json`), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Validate that `obj` conforms to `schema`.
 * Handles: type, required, properties, enum, minimum, maximum.
 * Returns null on pass, or an error message on fail.
 */
export function validate(obj: unknown, schema: Record<string, unknown>, path = "$"): string | null {
  if (schema["type"]) {
    const types = Array.isArray(schema["type"]) ? schema["type"] : [schema["type"]];
    const jsType = obj === null ? "null" : typeof obj;
    const matched = types.some((t) => {
      if (t === "null") return obj === null;
      if (t === "integer") return typeof obj === "number" && Number.isInteger(obj);
      if (t === "array") return Array.isArray(obj);
      return jsType === t;
    });
    if (!matched) {
      return `${path}: expected type ${JSON.stringify(types)}, got ${obj === null ? "null" : typeof obj} (value=${JSON.stringify(obj)})`;
    }
  }

  if (schema["enum"] && !Array.isArray(obj)) {
    const allowed = schema["enum"] as unknown[];
    if (!allowed.includes(obj)) {
      return `${path}: expected one of ${JSON.stringify(allowed)}, got ${JSON.stringify(obj)}`;
    }
  }

  if (typeof schema["minimum"] === "number" && typeof obj === "number") {
    if (obj < (schema["minimum"] as number)) {
      return `${path}: ${obj} < minimum ${schema["minimum"]}`;
    }
  }
  if (typeof schema["maximum"] === "number" && typeof obj === "number") {
    if (obj > (schema["maximum"] as number)) {
      return `${path}: ${obj} > maximum ${schema["maximum"]}`;
    }
  }

  if (Array.isArray(schema["required"]) && typeof obj === "object" && obj !== null) {
    for (const key of schema["required"] as string[]) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) {
        return `${path}: missing required property "${key}"`;
      }
    }
  }

  if (schema["properties"] && typeof obj === "object" && obj !== null) {
    const props = schema["properties"] as Record<string, Record<string, unknown>>;
    const record = obj as Record<string, unknown>;
    for (const [key, propSchema] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        const err = validate(record[key], propSchema, `${path}.${key}`);
        if (err) return err;
      }
    }
  }

  return null;
}
