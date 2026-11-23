import { Suspense } from "react";

import { RoomSkeleton } from "@/components/room-skeleton";
import { getT, roomTitle } from "@/lib/i18n/server";

import { LoadedGraphFigures } from "./figures";

/** The document title and the room's figures, read on the server, under the client-drawn sky. */
export const generateMetadata = roomTitle("graph");

/** The figures stream in under their own skeleton (APP-043): the sky does not wait on /graph/stats. */
export default async function Layout({ children }: { children: React.ReactNode }) {
  const t = await getT();
  return (
    <>
      {children}
      <Suspense fallback={<RoomSkeleton t={t} shape="figures" />}>
        <LoadedGraphFigures />
      </Suspense>
    </>
  );
}
