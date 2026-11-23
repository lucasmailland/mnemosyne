"use client";

import { usePathname } from "next/navigation";

export function RouteStage({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="enter" data-route={pathname}>
      {children}
    </div>
  );
}
