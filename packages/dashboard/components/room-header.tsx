import Image from "next/image";

import { BRAND_IMAGES, type BrandImageId } from "@/lib/brand/images";

/**
 * The electric strip above a room: the engraving on the right fading into solid
 * electric; on the left the numeral and page name ("XI · Audit"), the room's
 * title and its subtitle. The text stays in the solid part and the strip grows
 * with it, so nothing is clipped; below 768 px there is room for the title only.
 * The h1 starts with the page name (visually hidden), so heading navigation
 * names the page and not just the metaphor.
 */
export function RoomHeader({
  numeral,
  name,
  title,
  subtitle,
  image,
}: {
  numeral?: string;
  /** The page's functional name, as in the navigation ("Audit"). */
  name: string;
  title: string;
  subtitle?: string;
  image: BrandImageId;
}) {
  return (
    <header
      className="relative overflow-hidden"
      style={{ background: "var(--brand-electric)", color: "var(--brand-ivory)" }}
    >
      <div className="enter-scene absolute inset-y-0 right-0 w-2/3 overflow-hidden">
        {/* Drawn at least 180 px tall and cropped, never shrunk to the strip. */}
        <div className="absolute inset-x-0 top-1/2 h-full min-h-45 -translate-y-1/2">
          <Image
            src={BRAND_IMAGES[image]}
            alt=""
            fill
            sizes="(min-width: 768px) 66vw, 100vw"
            className="object-cover"
          />
        </div>
      </div>
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(90deg, var(--brand-electric) 38%, color-mix(in srgb, var(--brand-electric) 45%, transparent) 64%, color-mix(in srgb, var(--brand-electric) 10%, transparent) 100%)",
        }}
      />
      <div className="relative flex min-h-28 flex-col justify-end gap-1 px-4 py-4 md:min-h-34 md:max-w-3/5 md:pr-4 md:pb-6 md:pl-10 lg:max-w-2/5">
        {/* Ivory, not the eyebrow's muted color: it sits on electric. */}
        <p className="eyebrow opacity-78" style={{ color: "inherit" }} aria-hidden="true">
          {numeral ? `${numeral} · ${name}` : name}
        </p>
        <h1 className="font-display text-display-4 leading-tight font-normal break-words lg:text-display-3">
          <span className="sr-only">{name} — </span>
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 hidden text-ui-sm opacity-78 md:line-clamp-2">{subtitle}</p>
        )}
      </div>
    </header>
  );
}
