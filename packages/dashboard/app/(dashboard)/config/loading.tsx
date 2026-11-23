import { RoomSkeleton } from "@/components/room-skeleton";
import { getT } from "@/lib/i18n/server";

/** This room while its data loads (APP-043): its own boundary, never one over the group (404s). */
export default async function Loading() {
  return <RoomSkeleton t={await getT()} shape="figures" />;
}
