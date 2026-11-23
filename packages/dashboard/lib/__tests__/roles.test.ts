import { expect, it } from "vitest";

import { isRole, ROLES } from "../roles";

it("lists the server's roles", () => {
  expect(ROLES).toEqual(["owner", "admin", "write", "read"]);
});

it("isRole accepts roles only", () => {
  expect(isRole("admin")).toBe(true);
  expect(isRole("x")).toBe(false);
  expect(isRole("constructor")).toBe(false);
  expect(isRole(3)).toBe(false);
});
