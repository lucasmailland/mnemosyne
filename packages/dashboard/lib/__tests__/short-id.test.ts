import { expect, it } from "vitest";

import { shortId } from "../short-id";

it("prints an ellipsis and the last six characters, or a short id whole", () => {
  expect(shortId("ckxyz0123abc123")).toBe("…abc123");
  expect(shortId("abc")).toBe("abc");
});
