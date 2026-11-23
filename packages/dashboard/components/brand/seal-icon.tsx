import Image from "next/image";

import { BRAND_ICONS, type BrandIconId } from "@/lib/brand/images";

export function SealIcon({ icon, size = 24 }: { icon: BrandIconId; size?: 24 | 32 }) {
  const inner = size * 0.75;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, background: "var(--brand-electric)" }}
    >
      <Image src={BRAND_ICONS[icon]} alt="" width={inner} height={inner} />
    </span>
  );
}
