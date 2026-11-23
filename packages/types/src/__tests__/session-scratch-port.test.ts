import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("has no generic StorageAdapter scratch writer", () => {
  const ports = readFileSync(new URL("../ports.ts", import.meta.url), "utf8");
  expect(ports).not.toContain("updateSessionScratch");
});
