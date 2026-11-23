import { RoomSkeleton } from "@/components/room-skeleton";
import { getT } from "@/lib/i18n/server";

/** The constellation while it loads: one sky. */
export default async function Loading() {
  return <RoomSkeleton t={await getT()} shape="sky" />;
}
