"use client";

import { usePathname } from "next/navigation";

import { RoomHeader } from "@/components/room-header";
import { useT } from "@/lib/i18n/client";
import { roomForPath } from "@/lib/rooms";

/**
 * The header of the room the URL is in; nothing when no room matches or the room draws its own
 * scene. Keyed by room, so it enters again on a route change. An Installation room seen by
 * anyone but a superadmin is a 404 (`requireSuperadmin`): no header, so the page has one h1
 * and the section's name does not leak (APP-058).
 */
export function RoomHeaderForPath({ isSuperadmin = false }: { isSuperadmin?: boolean }) {
  const t = useT();
  const room = roomForPath(usePathname());
  if (!room || room.scene || (room.group === "installation" && !isSuperadmin)) return null;
  return (
    <RoomHeader
      key={room.id}
      numeral={room.numeral}
      name={t(room.nav)}
      title={t(room.title)}
      subtitle={t(room.subtitle)}
      image={room.image}
    />
  );
}
