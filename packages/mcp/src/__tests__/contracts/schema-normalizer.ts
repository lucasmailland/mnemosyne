export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeSchema(value: unknown, parentKey?: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Schema contains a non-JSON number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizeSchema(item));
    return parentKey === "required"
      ? [...normalized].sort((left, right) => compareAscii(String(left), String(right)))
      : normalized;
  }
  if (typeof value !== "object") {
    throw new TypeError("Schema contains a non-JSON value");
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Schema contains a non-plain object");
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareAscii(left, right))
      .map(([key, item]) => [key, normalizeSchema(item, key)]),
  );
}
