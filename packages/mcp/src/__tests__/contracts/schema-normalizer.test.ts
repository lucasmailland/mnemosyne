import { describe, expect, it } from "vitest";

import { normalizeSchema } from "./schema-normalizer.js";

describe("normalizeSchema", () => {
  it("sorts object keys and required arrays without dropping wire keywords", () => {
    const input = {
      required: ["zeta", "alpha"],
      type: "object",
      properties: {
        zeta: { type: "integer", minimum: 1, maximum: 25 },
        alpha: {
          type: "string",
          enum: ["second", "first"],
          default: "second",
          pattern: "^[a-z]+$",
        },
        nested: {
          oneOf: [{ required: ["beta", "alpha"], type: "object" }, { type: "null" }],
        },
      },
      description: "Advertised metadata",
      $schema: "http://json-schema.org/draft-07/schema#",
    };

    const normalized = normalizeSchema(input);

    expect(normalized).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      description: "Advertised metadata",
      properties: {
        alpha: {
          default: "second",
          enum: ["second", "first"],
          pattern: "^[a-z]+$",
          type: "string",
        },
        nested: {
          oneOf: [{ required: ["alpha", "beta"], type: "object" }, { type: "null" }],
        },
        zeta: { maximum: 25, minimum: 1, type: "integer" },
      },
      required: ["alpha", "zeta"],
      type: "object",
    });
    expect(input).toEqual({
      required: ["zeta", "alpha"],
      type: "object",
      properties: {
        zeta: { type: "integer", minimum: 1, maximum: 25 },
        alpha: {
          type: "string",
          enum: ["second", "first"],
          default: "second",
          pattern: "^[a-z]+$",
        },
        nested: {
          oneOf: [{ required: ["beta", "alpha"], type: "object" }, { type: "null" }],
        },
      },
      description: "Advertised metadata",
      $schema: "http://json-schema.org/draft-07/schema#",
    });
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    () => undefined,
    Symbol("x"),
  ])("rejects non-JSON value %s", (value) => {
    expect(() => normalizeSchema(value)).toThrow("non-JSON");
  });

  it.each([new Date(0), new Map([["type", "object"]])])("rejects non-plain object %s", (value) => {
    expect(() => normalizeSchema(value)).toThrow("non-plain object");
  });
});
