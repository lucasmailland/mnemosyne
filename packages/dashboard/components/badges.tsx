import type { MessageKey, T } from "@/lib/i18n/core";
import { cn } from "@/lib/utils";

/** Translated text for an API value, falling back to the raw value when the dictionary has no entry. */
export function labelOr(t: T, key: string, raw: string): string {
  const out = t(key as MessageKey);
  return out === key ? raw : out;
}

/** A quiet outline tag: the kind is a label, not a status, so it never carries a tinted fill. */
export function KindPill({ label }: { label: string }) {
  return (
    <span className="border-border text-text-muted border px-2 py-1 font-mono text-mono-xs">
      {label}
    </span>
  );
}

const SENSITIVITY_COLOR: Record<string, string> = {
  public: "text-green border-green/40",
  internal: "text-text-muted border-border",
  confidential: "text-yellow border-yellow/40",
  restricted: "text-red border-red/40",
};

export function SensitivityBadge({ tier, label }: { tier?: string | null; label: string }) {
  if (!tier) return null;
  return (
    <span
      className={cn(
        "border px-2 py-1 font-mono text-mono-xs uppercase",
        SENSITIVITY_COLOR[tier] ?? "text-text-muted border-border"
      )}
    >
      {label}
    </span>
  );
}

export function WorthBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="inline-flex items-center gap-2 text-xs text-text-muted">
      <span className="inline-block h-2 w-16 overflow-hidden bg-surface-2">
        <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
      {label}
    </span>
  );
}
