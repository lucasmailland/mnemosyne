"use client";

import Image from "next/image";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Wordmark } from "@/components/brand/wordmark";
import { LanguageSwitch } from "@/components/language-switch";
import { BRAND_IMAGES, type BrandImageId } from "@/lib/brand/images";
import { useT } from "@/lib/i18n/client";

/** Class strings for the controls of the entry pages (46 px fields, 48 px submit). */
export const authLabel = "mt-4 mb-2 block text-xs font-medium text-text-muted";
export const authLabelFirst = "mb-2 block text-xs font-medium text-text-muted";
export const authInput =
  "h-12 w-full border border-control-border bg-surface px-4 text-ui text-text focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60";
export const authAlert = "mt-4 border border-red/40 bg-red/10 px-3 py-2 text-ui-sm text-red";
export const authLinkButton =
  "mt-3 inline-block min-h-11 text-ui-sm text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-wait";

/** The electric submit button with its Return hint. */
export function AuthSubmit({
  children,
  className = "mt-6",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  ref?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button type="submit" className={`auth-btn ${className}`} {...props}>
      <span>{children}</span>
      <kbd aria-hidden="true" className="font-mono text-mono-sm opacity-70">
        ↵
      </kbd>
    </button>
  );
}

/** Split scene for Login, Setup and Link: the engraving on the left, the form on the right. */
export function AuthScene({
  image,
  eyebrow,
  title,
  lede,
  children,
}: {
  image: BrandImageId;
  eyebrow: string;
  title: string;
  lede: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <main className="auth-layout min-h-screen">
      <section className="auth-scene">
        <Image
          src={BRAND_IMAGES[image]}
          alt=""
          fill
          priority
          sizes="(min-width: 1024px) 55vw, 100vw"
          className="auth-scene-img"
        />
        <Wordmark height={30} className="relative z-10" />
        <div className="relative z-10 hidden items-end justify-between lg:flex gap-4">
          <p className="auth-quote">
            {t("auth.sceneLine")}
            <small className="mt-3 block font-mono text-mono-xs tracking-widest opacity-70">
              {t("auth.sceneCaption")}
            </small>
          </p>
          <span className="font-mono text-mono-xs tracking-widest opacity-70">
            v{process.env.NEXT_PUBLIC_DASHBOARD_VERSION}
          </span>
        </div>
      </section>
      <section className="flex items-center justify-center bg-base p-6 lg:min-h-screen lg:p-12">
        <div className="w-full max-w-92">
          <div className="enter eyebrow" style={{ "--i": 0 } as React.CSSProperties}>
            {eyebrow}
          </div>
          <h1
            className="enter auth-title mt-3 mb-3 break-words"
            style={{ "--i": 1 } as React.CSSProperties}
          >
            {title}
          </h1>
          {lede && (
            <p
              className="enter mb-6 break-words text-ui leading-relaxed text-text-muted"
              style={{ "--i": 2 } as React.CSSProperties}
            >
              {lede}
            </p>
          )}
          <div className="enter" style={{ "--i": 3 } as React.CSSProperties}>
            {children}
          </div>
          <hr className="double-rule mt-7 mb-4 border-border" />
          <p className="text-ui-xs leading-relaxed text-text-faint">{t("auth.finePrint")}</p>
          <div className="mt-6">
            <LanguageSwitch />
          </div>
        </div>
      </section>
    </main>
  );
}
