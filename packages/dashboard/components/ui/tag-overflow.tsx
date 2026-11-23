"use client";

import { StatusTag } from "@/components/keeper";
import { useT } from "@/lib/i18n/client";

import { usePopover } from "./popover";

/**
 * The first `max` tags in a row and a "+N" button that opens all of them in a popover, so a long
 * list (a key's permissions) takes one line. With `max` or fewer tags there is no button.
 */
export function TagOverflow({
  label,
  tags,
  max = 3,
  mono = false,
}: {
  /** What the tags are ("Permissions of CI key"): names the list and the button. */
  label: string;
  tags: string[];
  max?: number;
  mono?: boolean;
}) {
  const t = useT();
  const { buttonProps, panelProps } = usePopover();
  const rest = tags.length - max;
  const tag = (s: string) => (
    <li key={s} className={mono ? "font-mono" : undefined}>
      <StatusTag caseless>{s}</StatusTag>
    </li>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ul aria-label={label} className="flex flex-wrap gap-2">
        {tags.slice(0, rest > 0 ? max : tags.length).map(tag)}
      </ul>
      {rest > 0 && (
        <>
          <button
            {...buttonProps}
            aria-haspopup="dialog"
            className="border-control-border text-text-muted hover:border-accent hover:text-accent focus-visible:outline-accent text-ui-xs inline-flex min-h-8 items-center border px-2 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            +{rest}
            <span className="sr-only"> {t("ui.moreTags", { count: tags.length, label })}</span>
          </button>
          <div {...panelProps} role="dialog" aria-label={label} className="pop w-72 p-3">
            <p className="eyebrow mb-2">{label}</p>
            <ul className="flex flex-wrap gap-2">{tags.map(tag)}</ul>
          </div>
        </>
      )}
    </div>
  );
}
