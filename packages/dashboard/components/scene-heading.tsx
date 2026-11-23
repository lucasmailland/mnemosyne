"use client";

import { useT } from "@/lib/i18n/client";
import type { Room } from "@/lib/rooms";

/**
 * The h1 of a scene room (Home, Graph), which draws its own scene instead of the
 * room header strip. Same convention as RoomHeader: the functional nav name leads
 * the accessible name (visually hidden), the Didot title follows, and the eyebrow
 * reads "numeral · nav name".
 */
export function SceneHeading({ room, className }: { room: Room; className?: string }) {
  const t = useT();
  const name = t(room.nav);
  return (
    <div data-testid="scene-heading" className={className}>
      <p className="eyebrow" aria-hidden="true">
        {room.numeral ? `${room.numeral} · ${name}` : name}
      </p>
      <h1 className="font-display text-display-4 leading-tight font-normal break-words lg:text-display-3">
        <span className="sr-only">{name} — </span>
        {t(room.title)}
      </h1>
    </div>
  );
}
