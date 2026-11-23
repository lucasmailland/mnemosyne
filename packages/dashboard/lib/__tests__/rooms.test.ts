import { describe, expect, it } from "vitest";

import { en } from "@/lib/i18n/messages/en";
import { ROLES, roleLabel } from "@/lib/roles";
import { ROOMS, roomForPath } from "@/lib/rooms";
import { translate, type Locale, type Messages, type T } from "@/lib/i18n/core";
import { es } from "@/lib/i18n/messages/es";

describe("roomForPath", () => {
  it.each([
    ["/", "home"],
    ["/browser", "browser"],
    ["/browser/x", "browser"],
    ["/browserx", null],
    ["/admin/keys", "keys"],
    ["/installation/users", "installation-users"],
    ["/relations", "graph"],
    ["/nope", null],
  ])("roomForPath(%s) is %s", (p, id) => expect(roomForPath(p)?.id ?? null).toBe(id));
});

it("numbers the palace and the keepers I to XI", () => {
  expect(ROOMS.filter((r) => r.numeral).map((r) => r.numeral)).toEqual([
    "I",
    "II",
    "III",
    "IV",
    "V",
    "VI",
    "VII",
    "VIII",
    "IX",
    "X",
    "XI",
  ]);
});

it("has a title, subtitle and nav label in both locales", () => {
  for (const r of ROOMS) {
    for (const key of [r.nav, r.title, r.subtitle]) {
      expect(translate(en, key, undefined, "en-US")).not.toBe(key);
      expect(translate(es, key, undefined, "es-419")).not.toBe(key);
    }
  }
});

it("labels roles in both locales", () => {
  const t =
    (m: Messages, locale: Locale): T =>
    (k, vars) =>
      translate(m, k, vars, locale);
  expect(ROLES.map((r) => roleLabel(t(en, "en-US"), r))).toEqual([
    "Owner",
    "Admin",
    "Contributor",
    "Viewer",
  ]);
  expect(ROLES.map((r) => roleLabel(t(es, "es-419"), r))).toEqual([
    "Propietario",
    "Administrador",
    "Colaborador",
    "Lector",
  ]);
});
