import { RoomSkeleton } from "@/components/room-skeleton";
import { getT } from "@/lib/i18n/server";

/** Recall while it loads: the query field, then result rows. */
export default async function Loading() {
  return <RoomSkeleton t={await getT()} shape="search" />;
}
