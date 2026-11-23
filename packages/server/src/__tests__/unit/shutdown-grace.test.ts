import { describe, expect, it } from "vitest";
import { DEFAULT_SHUTDOWN_GRACE_MS, readShutdownGraceMs } from "../../boot/shutdown-grace.js";

describe("readShutdownGraceMs", () => {
  it("defaults to 45 s when unset or empty", () => {
    expect(DEFAULT_SHUTDOWN_GRACE_MS).toBe(45_000);
    expect(readShutdownGraceMs({})).toBe(45_000);
    expect(readShutdownGraceMs({ MNEMO_SHUTDOWN_GRACE_MS: "" })).toBe(45_000);
  });

  it("reads a positive whole number of milliseconds", () => {
    expect(readShutdownGraceMs({ MNEMO_SHUTDOWN_GRACE_MS: "20000" })).toBe(20_000);
  });

  it.each(["0", "-1", "1.5", "45s", "abc", "99999999999"])("rejects %j", (v) => {
    expect(() => readShutdownGraceMs({ MNEMO_SHUTDOWN_GRACE_MS: v })).toThrow(
      /MNEMO_SHUTDOWN_GRACE_MS/
    );
  });
});
