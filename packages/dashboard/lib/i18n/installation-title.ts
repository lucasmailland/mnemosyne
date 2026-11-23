import type { Metadata } from "next";

import { getSession } from "@/lib/server-api";
import type { RoomId } from "@/lib/rooms";

import { roomTitle, titled } from "./server";

/**
 * `roomTitle` for the Installation pages. Anyone who is not a superadmin sees the in-shell
 * not-found, so the tab must not name the room either: it carries the not-found title.
 */
export const installationTitle = (id: RoomId) => async (): Promise<Metadata> =>
  (await getSession())?.isSuperadmin ? roomTitle(id)() : titled("lethe.notFoundName")();
