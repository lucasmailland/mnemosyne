import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isoDateTimeInput } from "../datetime.js";

// zod 4.5 started requiring seconds in `datetime()`. Inputs keep the set that
// zod 4.4 accepted: seconds and fractions optional.
describe("isoDateTimeInput", () => {
  const utc = isoDateTimeInput();
  const offset = isoDateTimeInput({ offset: true });

  it.each(["2026-08-01T09:00Z", "2026-08-01T09:00:00Z", "2026-08-01T09:00:00.123Z"])(
    "accepts %s",
    (value) => {
      expect(utc.safeParse(value).success).toBe(true);
      expect(offset.safeParse(value).success).toBe(true);
    }
  );

  it.each(["2026-08-01T09:00+03:00", "2026-08-01T09:00:00-05:00", "2026-08-01T09:00:00.5+00:00"])(
    "accepts the offset form %s only with { offset: true }",
    (value) => {
      expect(offset.safeParse(value).success).toBe(true);
      expect(utc.safeParse(value).success).toBe(false);
    }
  );

  it.each([
    "",
    "nope",
    "2026-08-01",
    "2026-08-01T09Z",
    "2026-02-30T09:00Z",
    "2026-08-01T24:00Z",
    "2026-08-01T09:00",
  ])("rejects %j with zod's datetime issue", (value) => {
    const result = utc.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: "invalid_format",
      format: "datetime",
      message: "Invalid ISO datetime",
    });
  });

  it("emits one date-time string schema", () => {
    const schema = z.toJSONSchema(utc) as Record<string, unknown>;
    expect(schema.type).toBe("string");
    expect(schema.format).toBe("date-time");
    expect(new RegExp(schema.pattern as string).test("2026-08-01T09:00Z")).toBe(true);
  });
});
