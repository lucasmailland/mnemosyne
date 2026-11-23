import { RoomSkeleton } from "@/components/room-skeleton";
import { getT } from "@/lib/i18n/server";

/** The catalog while its lists load: figures, then two columns of index cards. */
export default async function Loading() {
  return <RoomSkeleton t={await getT()} shape="list" />;
}
