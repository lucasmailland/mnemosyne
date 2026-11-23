import Image from "next/image";
import type { ReactNode } from "react";

import { BRAND_IMAGES } from "@/lib/brand/images";

export function EmptyState({
  title,
  body,
  command,
  action,
}: {
  title: string;
  body: string;
  /** A shell command to run first, printed after a "$" prompt. */
  command?: string;
  action?: ReactNode;
}) {
  return (
    <section className="border-border grid overflow-hidden border md:grid-cols-2">
      <div
        className="relative h-48 md:h-auto md:min-h-72"
        style={{ background: "var(--brand-electric)" }}
      >
        <Image
          src={BRAND_IMAGES["obj-wax-tablet"]}
          alt=""
          fill
          sizes="(min-width: 768px) 50vw, 100vw"
          className="object-cover"
        />
      </div>
      <div className="flex flex-col justify-center gap-3 p-6 md:p-12">
        <h2 className="font-display text-display-4 md:text-display-3 leading-tight font-normal">
          {title}
        </h2>
        <p className="text-text-muted text-ui max-w-sm leading-relaxed">{body}</p>
        {command && (
          <pre className="border-border bg-surface-2 text-text mt-2 overflow-x-auto border px-3 py-2 font-mono text-mono">
            <b className="text-accent" aria-hidden="true">
              ${" "}
            </b>
            {command}
          </pre>
        )}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </section>
  );
}
