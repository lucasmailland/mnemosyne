import type { Metadata } from "next";
import { cookies, headers } from "next/headers";

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  resolveLocale,
  translate,
  type Locale,
  type MessageKey,
  type T,
  type Vars,
} from "./core";
import { en } from "./messages/en";
import { es } from "./messages/es";
import { ROOMS, type RoomId } from "@/lib/rooms";

export async function getLocale(): Promise<Locale> {
  try {
    const cookie = (await cookies()).get(LOCALE_COOKIE)?.value;
    const accept = (await headers()).get("accept-language");
    return resolveLocale(cookie, accept);
  } catch {
    // No request scope (unit tests, static rendering): English.
    return DEFAULT_LOCALE;
  }
}

export async function getT(): Promise<T> {
  const locale = await getLocale();
  const messages = locale === "es-419" ? es : en;
  return (key: MessageKey, vars?: Vars) => translate(messages, key, vars, locale);
}

/** A page's `generateMetadata`: its localized name, then the product ("Audit · Mnemosyne"). */
export function titled(key: MessageKey) {
  return async (): Promise<Metadata> => ({ title: `${(await getT())(key)} · Mnemosyne` });
}

/** `titled` with the room's navigation name, so the tab and the nav say the same thing. */
export const roomTitle = (id: RoomId) => titled(ROOMS.find((r) => r.id === id)!.nav);
