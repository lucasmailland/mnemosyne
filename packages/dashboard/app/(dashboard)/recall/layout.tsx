import { Suspense } from "react";

import { RoomSkeleton } from "@/components/room-skeleton";
import { getT, roomTitle } from "@/lib/i18n/server";

import { LoadedRecallFigures } from "./figures";

/** The document title and the room's figures, read on the server; the playground is a client page. */
export const generateMetadata = roomTitle("recall");

/**
 * The figures stream in under their own skeleton (APP-043): the room's page does not wait on
 * /recall/metrics, and no boundary sits over the group (a 404 below one is sent as a 200).
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  const t = await getT();
  return (
    <>
      <Suspense fallback={<RoomSkeleton t={t} shape="figures" />}>
        <LoadedRecallFigures />
      </Suspense>
      {children}
    </>
  );
}
