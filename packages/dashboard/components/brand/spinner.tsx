import Image from "next/image";

import { SPINNER } from "@/lib/brand/images";

export function Spinner({ label }: { label: string }) {
  return (
    <span role="status" className="inline-flex items-center">
      <Image src={SPINNER} alt="" width={24} height={24} />
      <span className="sr-only">{label}</span>
    </span>
  );
}
