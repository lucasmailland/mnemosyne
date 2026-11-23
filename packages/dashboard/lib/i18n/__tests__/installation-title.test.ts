import { afterEach, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ value: null as { isSuperadmin?: boolean } | null }));
vi.mock("@/lib/server-api", () => ({ getSession: async () => session.value }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

import { installationTitle } from "../installation-title";

afterEach(() => {
  session.value = null;
});

it("a superadmin gets the room's title; anyone else the not-found title (the room stays unnamed)", async () => {
  session.value = { isSuperadmin: true };
  expect(await installationTitle("installation-users")()).toEqual({
    title: "Users · Mnemosyne",
  });
  for (const other of [{ isSuperadmin: false }, {}, null]) {
    session.value = other;
    expect(await installationTitle("installation-users")()).toEqual({
      title: "Not found · Mnemosyne",
    });
  }
});
