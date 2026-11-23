import { RoomSkeleton } from "@/components/room-skeleton";
import { getT } from "@/lib/i18n/server";

/** The atrium while its data loads (APP-043). Only this page: a boundary over the whole group would stream every 404 as a 200. */
export default async function Loading() {
  return <RoomSkeleton t={await getT()} shape="figures" />;
}
