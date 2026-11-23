"use client";

import { useId, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * One choice among a few (five at most), as joined square segments. The segments are native radios
 * (arrow keys move and choose, as in any radio group) named `name`, so inside a GET form they travel
 * with it; `submitOnChange` sends that form at once. Controlled with `value` and `onChange`, or left
 * to itself from `defaultValue`.
 */
export function Segmented({
  label,
  hideLabel = false,
  stacked = false,
  name,
  options,
  value,
  defaultValue,
  onChange,
  submitOnChange = false,
}: {
  label: string;
  /** The label stays for assistive technology only (the options speak for themselves). */
  hideLabel?: boolean;
  /** Label above the segments instead of beside them. */
  stacked?: boolean;
  name?: string;
  options: { value: string; label: string }[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  submitOnChange?: boolean;
}) {
  const id = useId();
  const [own, setOwn] = useState(defaultValue ?? options[0]?.value ?? "");
  const current = value ?? own;
  return (
    <div
      role="radiogroup"
      aria-labelledby={`${id}-label`}
      className={cn("flex", stacked ? "flex-col gap-2" : "flex-wrap items-center gap-2")}
    >
      <span
        id={`${id}-label`}
        className={
          hideLabel ? "sr-only" : stacked ? "text-ui text-text font-medium" : "eyebrow mr-1"
        }
      >
        {label}
      </span>
      <span className="seg-box border-control-border inline-flex flex-wrap self-start border">
        {options.map((o) => (
          <label key={o.value} className="relative cursor-pointer">
            <input
              type="radio"
              name={name ?? id}
              value={o.value}
              checked={current === o.value}
              onChange={(e) => {
                if (value === undefined) setOwn(o.value);
                onChange?.(o.value);
                if (submitOnChange) e.currentTarget.form?.requestSubmit();
              }}
              // Over its segment, transparent: a click or a tap lands on the radio itself.
              className="peer absolute inset-0 cursor-pointer opacity-0"
            />
            <span className="seg-opt text-ui-sm text-text-muted peer-hover:text-text peer-checked:bg-accent peer-checked:text-on-accent peer-focus-visible:outline-accent inline-flex min-h-10 items-center px-3 whitespace-nowrap peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2">
              {o.label}
            </span>
          </label>
        ))}
      </span>
    </div>
  );
}
