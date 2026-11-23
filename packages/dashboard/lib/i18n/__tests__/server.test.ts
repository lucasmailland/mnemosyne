import { afterEach, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({ locale: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (jar.locale ? { value: jar.locale } : undefined) }),
  headers: async () => new Headers(),
}));

import { roomTitle, titled } from "../server";

afterEach(() => {
  jar.locale = undefined;
});

it("titles each page with its navigation name, then the product, in the reader's language", async () => {
  expect(await roomTitle("audit")()).toEqual({ title: "Audit · Mnemosyne" });
  expect(await roomTitle("installation-audit")()).toEqual({ title: "Security audit · Mnemosyne" });
  expect(await titled("auth.signIn")()).toEqual({ title: "Sign in · Mnemosyne" });
  jar.locale = "es-419";
  expect(await roomTitle("audit")()).toEqual({ title: "Auditoría · Mnemosyne" });
  expect(await titled("auth.signIn")()).toEqual({ title: "Iniciar sesión · Mnemosyne" });
});
