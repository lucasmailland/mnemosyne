import { describe, it, expect } from "vitest";
import { unsafeSwitchesInProduction } from "../../boot/unsafe-switches.js";

describe("unsafe switches in production", () => {
  it("names every unsafe switch that is on with NODE_ENV=production", () => {
    expect(
      unsafeSwitchesInProduction({
        NODE_ENV: "production",
        MNEMO_DASHBOARD_INSECURE_COOKIE: "true",
        MNEMO_ALLOW_UNSAFE_DB_ROLE: "true",
      })
    ).toEqual(["MNEMO_DASHBOARD_INSECURE_COOKIE", "MNEMO_ALLOW_UNSAFE_DB_ROLE"]);
  });

  it('accepts them outside production, and anything but "true" in production', () => {
    expect(
      unsafeSwitchesInProduction({
        NODE_ENV: "development",
        MNEMO_DASHBOARD_INSECURE_COOKIE: "true",
        MNEMO_ALLOW_UNSAFE_DB_ROLE: "true",
      })
    ).toEqual([]);
    expect(
      unsafeSwitchesInProduction({
        NODE_ENV: "production",
        MNEMO_DASHBOARD_INSECURE_COOKIE: "false",
      })
    ).toEqual([]);
  });
});
