/**
 * APP-028: the 1 MiB body limit covers the whole API except POST /import,
 * whose own limit (100 MiB compressed) is what the contract states.
 */
import { describe, expect, it } from "vitest";

import { bodyLimitFor } from "../../app.js";

describe("bodyLimitFor", () => {
  it("is 1 MiB for every route", () => {
    expect(bodyLimitFor("POST", "/remember")).toBe(1024 * 1024);
    expect(bodyLimitFor("POST", "/importer")).toBe(1024 * 1024);
  });
  it("is the import limit for POST /import", () => {
    expect(bodyLimitFor("POST", "/import")).toBe(100 * 1024 * 1024);
  });
});
