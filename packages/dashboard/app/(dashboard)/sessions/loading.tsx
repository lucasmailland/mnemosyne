import { RoomSkeleton } from "@/components/room-skeleton";
import { getT } from "@/lib/i18n/server";

/** The columbarium while it loads: figures, then the grid of niches. */
export default async function Loading() {
  return <RoomSkeleton t={await getT()} shape="grid" />;
}
