"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef } from "react";

import { BRAND_IMAGES } from "@/lib/brand/images";
import { useT } from "@/lib/i18n/client";

/**
 * The scene for pages that do not exist and for errors: the Lethe plate (drawn at
 * 240 px, never smaller), a Didot line, one sentence and the way back. The h1
 * leads with the functional name (visually hidden), as in RoomHeader.
 */
export function Lethe({
  kind,
  home,
  digest,
  reset,
}: {
  kind: "notFound" | "error";
  /** Where "back" goes: the atrium inside the shell, the login outside it. */
  home?: { href: string; label: "lethe.toAtrium" | "lethe.toLogin" | "lethe.toDashboard" };
  digest?: string;
  reset?: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const notFound = kind === "notFound";
  const name = t(notFound ? "lethe.notFoundName" : "lethe.errorName");
  const h1 = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (notFound) return;
    // Error boundaries are client components and cannot export metadata: set the title
    // here and restore it on unmount; move focus so screen readers land on the message.
    const previous = document.title;
    document.title = `${name} · Mnemosyne`;
    h1.current?.focus({ preventScroll: true });
    return () => {
      document.title = previous;
    };
  }, [notFound, name]);
  return (
    <section
      data-lethe
      className="enter-scene mx-auto flex min-h-120 max-w-2xl flex-col items-center justify-center gap-6 p-6 text-center md:flex-row md:text-left"
    >
      <Image
        src={BRAND_IMAGES.lethe}
        alt=""
        width={240}
        height={240}
        preload
        className="size-60 shrink-0"
      />
      <div>
        <p className="eyebrow" aria-hidden="true">
          {notFound ? t("lethe.notFoundEyebrow") : name}
        </p>
        <h1
          ref={h1}
          tabIndex={-1}
          className="font-display text-display-4 mt-2 leading-tight font-normal break-words outline-none lg:text-display-3"
        >
          <span className="sr-only">{name} — </span>
          {t(notFound ? "lethe.notFoundTitle" : "lethe.errorTitle")}
        </h1>
        <p className="text-ui text-text-muted mt-3">
          {t(notFound ? "lethe.notFoundBody" : "lethe.errorBody")}
        </p>
        {digest && (
          <p className="text-text-faint text-mono-sm mt-3">
            {t("lethe.reference")}: <span className="font-mono">{digest}</span>
          </p>
        )}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-4 md:justify-start">
          {reset && (
            <button
              type="button"
              // An error from a server component comes back unless its data is fetched again:
              // refresh, then reset the boundary, in one transition.
              onClick={() =>
                startTransition(() => {
                  router.refresh();
                  reset();
                })
              }
              className="border-border bg-surface text-text text-ui-sm min-h-11 border px-4"
            >
              {t("common.retry")}
            </button>
          )}
          {home && (
            <Link
              href={home.href}
              className="text-ui-sm text-accent min-h-11 content-center underline underline-offset-4"
            >
              {t(home.label)}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
