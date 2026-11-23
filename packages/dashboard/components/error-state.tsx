"use client";

import { useT } from "@/lib/i18n/client";

export function ErrorState({
  title,
  body,
  retry,
}: {
  title: string;
  body: string;
  retry?: () => void;
}) {
  const t = useT();
  return (
    <div role="alert" className="border-red/40 bg-red/6 border p-4">
      <p className="font-display text-display-6 text-red">{title}</p>
      <p className="text-text-muted text-ui-sm mt-1">{body}</p>
      {retry && (
        <button
          type="button"
          onClick={retry}
          className="border-control-border bg-surface text-text text-ui-sm mt-3 min-h-11 border px-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t("common.retry")}
        </button>
      )}
    </div>
  );
}
