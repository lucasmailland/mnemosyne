/**
 * APP-018 safety net: a value Postgres cannot parse for its column (22P02,
 * invalid_text_representation — "invalid input syntax for type uuid") is the
 * caller's malformed input, not a server fault. It answered 500.
 */
import { describe, it, expect } from "vitest";
import { toErrorBody } from "../../errors.js";

const pg22P02 = () =>
  Object.assign(new Error('invalid input syntax for type uuid: "1"'), { code: "22P02" });

describe("toErrorBody — 22P02", () => {
  it("is a 400, also when wrapped by the query builder", () => {
    for (const err of [pg22P02(), new Error("Failed query", { cause: pg22P02() })]) {
      const { status, body } = toErrorBody(err);
      expect(status).toBe(400);
      expect(body.error.code).toBe("invalid_input_syntax");
      // The database's own text (which echoes the value) never reaches the caller.
      expect(body.error.message).not.toMatch(/syntax for type/);
    }
  });
});
