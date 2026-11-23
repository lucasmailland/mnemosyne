"use client";

import { useEffect, useId, useRef, useState } from "react";

import { useT } from "@/lib/i18n/client";

import { Chevron, popButton, usePopover } from "./popover";

export interface FilterOption {
  value: string;
  label: string;
}

/** Past this many options the panel gets its own search field. */
const SEARCH_FROM = 9;

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/**
 * One filter as a button ("Kind: All", "Kind: policy", "Kind: 3") that opens a panel with its
 * options: radios for one choice (with "All" first), checkboxes for several, a search field from
 * nine options on, and Clear. The options are real form fields named `name`, so inside a GET form
 * they travel with it; `submitOnChange` sends that form as soon as the choice changes. Controlled
 * with `value` and `onChange`, or left to itself from `defaultValue`.
 */
export function FilterMenu({
  label,
  options,
  multiple = false,
  name,
  value,
  defaultValue = [],
  onChange,
  submitOnChange = false,
  allLabel,
}: {
  label: string;
  options: FilterOption[];
  multiple?: boolean;
  name?: string;
  value?: string[];
  defaultValue?: string[];
  onChange?: (next: string[]) => void;
  submitOnChange?: boolean;
  /** The summary with nothing chosen (default "All"). */
  allLabel?: string;
}) {
  const t = useT();
  const group = useId();
  const [own, setOwn] = useState(defaultValue);
  const current = value ?? own;
  const [query, setQuery] = useState("");
  const pop = usePopover();
  // A change to send once React has written it to the fields (Clear empties several at once).
  const pending = useRef(false);
  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    pop.panel.current?.closest("form")?.requestSubmit();
  });

  const all = allLabel ?? t("common.all");
  const choose = (next: string[], done = !multiple) => {
    if (value === undefined) setOwn(next);
    onChange?.(next);
    if (submitOnChange) pending.current = true;
    if (done) pop.close();
  };
  const toggle = (v: string) =>
    choose(current.includes(v) ? current.filter((x) => x !== v) : [...current, v]);

  const chosen = options.filter((o) => current.includes(o.value));
  const summary =
    chosen.length === 0 ? all : chosen.length === 1 ? chosen[0]!.label : String(chosen.length);
  const shown = query ? options.filter((o) => fold(o.label).includes(fold(query))) : options;
  const fieldName = name ?? group;

  const option = (v: string, text: string, checked: boolean, onPick: () => void) => (
    <li key={v || "all"} hidden={!!query && !shown.some((o) => o.value === v)}>
      <label className="hover:bg-surface-2 text-ui-sm flex min-h-10 cursor-pointer items-center gap-3 px-3">
        <input
          data-item
          type={multiple ? "checkbox" : "radio"}
          name={fieldName}
          value={v}
          checked={checked}
          onChange={onPick}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            onPick();
          }}
          className="accent-accent focus-visible:outline-accent size-4 shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2"
        />
        <span className="min-w-0 break-words">{text}</span>
      </label>
    </li>
  );

  return (
    <>
      <button
        {...pop.buttonProps}
        aria-haspopup="dialog"
        className={`${popButton} ${
          current.length > 0
            ? "border-accent text-text"
            : "border-control-border text-text-muted hover:border-accent hover:text-text"
        }`}
      >
        <span>
          {label}: <span className={current.length > 0 ? "font-medium" : ""}>{summary}</span>
        </span>
        <Chevron />
      </button>
      <div {...pop.panelProps} role="dialog" aria-label={label} className="pop w-64">
        {options.length >= SEARCH_FROM && (
          <div className="border-border border-b p-2">
            <input
              data-autofocus
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t("ui.searchIn", { label })}
              placeholder={t("ui.search")}
              className="border-control-border bg-surface-2 placeholder:text-text-faint text-ui-sm min-h-10 w-full border px-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
          </div>
        )}
        <ul aria-label={label} className="py-1">
          {!multiple && option("", all, current.length === 0, () => choose([]))}
          {options.map((o) =>
            option(o.value, o.label, current.includes(o.value), () =>
              multiple ? toggle(o.value) : choose([o.value])
            )
          )}
        </ul>
        {query && shown.length === 0 && (
          <p className="text-text-muted text-ui-sm px-3 pb-3">{t("ui.noMatches")}</p>
        )}
        {multiple && current.length > 0 && (
          <div className="border-border flex items-center justify-between gap-2 border-t px-3 py-2">
            <span className="text-text-muted text-ui-xs">
              {t("ui.selected", { count: current.length })}
            </span>
            <button
              type="button"
              onClick={() => choose([], false)}
              className="text-accent text-ui-sm min-h-10 underline underline-offset-4"
            >
              {t("ui.clear")}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
