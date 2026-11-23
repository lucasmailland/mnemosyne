"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { failureMessage } from "@/components/form-bits";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/core";
import { loadFailure, loadSignal } from "@/lib/load";
import { roleLabel, type WorkspaceRole } from "@/lib/roles";
import { cn } from "@/lib/utils";
import type { MyWorkspaces } from "@/app/(dashboard)/workspaces/workspaces-view";

const ERROR_COPY: Record<string, MessageKey> = {
  workspace_not_found: "workspaces.err.workspaceNotFound",
  password_session_required: "workspaces.err.passwordSessionRequired",
};

export interface WorkspaceSwitcherProps {
  role: "admin" | "contributor" | "viewer";
  workspaceRole?: WorkspaceRole | null;
  workspaceName?: string | null;
  /** Called before leaving for another page (closes the phone drawer). */
  onNavigate: () => void;
}

/**
 * The workspace at the top of the sidebar: its name in Didot, the reader's role under it.
 * A password session opens a list of its workspaces and switches in place; an API key session
 * is bound to one workspace, so it shows the name only.
 */
export function WorkspaceSwitcher({
  role,
  workspaceRole,
  workspaceName,
  onNavigate,
}: WorkspaceSwitcherProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<MyWorkspaces | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const canSwitch = workspaceRole != null;

  const name = workspaceName ?? t("nav.workspaceFallback");
  const roleText = workspaceRole ? roleLabel(t, workspaceRole) : t(`nav.scope.${role}`);

  // One request per opening (or per Try again), never from an effect: an effect keyed on
  // "no data yet" asked again after every failure, forever, while the menu stayed open.
  function load() {
    setLoading(true);
    setError(null);
    fetch("/dashboard/api/my-workspaces", { signal: loadSignal() })
      .then(async (res) => {
        if (!res.ok) {
          setError(await failureMessage(t, res, ERROR_COPY));
          return;
        }
        setData((await res.json()) as MyWorkspaces);
      })
      .catch((e: unknown) => setError(loadFailure(t, e)))
      .finally(() => setLoading(false));
  }

  function toggle() {
    if (!open && !data && !loading) load();
    setOpen(!open);
  }

  // Escape and a click outside close it.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  async function switchTo(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/dashboard/api/my-workspaces/${encodeURIComponent(id)}/switch`, {
        method: "POST",
      });
      if (!res.ok) {
        setError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      // Every page reads the workspace from the cookie: reload into it.
      window.location.assign("/dashboard");
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(null);
    }
  }

  const label = (
    <>
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center bg-accent font-display text-display-6 text-on-accent"
      >
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span
          className="block truncate text-ui font-semibold text-text"
          title={workspaceName ?? undefined}
        >
          {name}
        </span>
        <span
          className="block truncate text-ui-xs text-text-muted"
          title={t("nav.workspaceRole", { name: workspaceName ?? t("nav.thisWorkspace") })}
        >
          {roleText}
        </span>
      </span>
    </>
  );

  const block = "flex w-full items-center gap-3 border border-border-soft bg-surface p-2 shadow-sm";

  if (!canSwitch)
    return (
      <div className="mx-3 mt-5">
        <div className={block}>{label}</div>
      </div>
    );

  return (
    <div ref={root} className="relative mx-3 mt-5">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
        className={cn(
          block,
          "group transition-colors hover:border-border focus-visible:outline-2 focus-visible:outline-accent",
          open && "border-border"
        )}
      >
        {label}
        <span className="sr-only">{t("nav.switchWorkspace")}</span>
        <span
          aria-hidden="true"
          className={cn("text-ui-sm text-text-faint group-hover:text-text", open && "text-accent")}
        >
          ⇅
        </span>
      </button>

      {open && (
        <div
          id={panelId}
          className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden border border-border bg-surface shadow-lg"
        >
          <p className="eyebrow border-b border-border-soft px-3 py-2">{t("nav.yourWorkspaces")}</p>
          {loading && <p className="px-3 py-3 text-ui-sm text-text-muted">{t("nav.loading")}</p>}
          {data && (
            <ul className="max-h-72 overflow-y-auto py-1">
              {data.workspaces.map((ws) => (
                <li key={ws.id}>
                  <button
                    type="button"
                    disabled={ws.current || busy !== null}
                    aria-current={ws.current ? "true" : undefined}
                    onClick={() => switchTo(ws.id)}
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-base disabled:cursor-default",
                      ws.current && "bg-base"
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "w-3 shrink-0 text-ui-sm",
                        ws.current ? "text-accent" : "text-transparent"
                      )}
                    >
                      ✓
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui text-text">{ws.name}</span>
                      <span className="block text-ui-xs text-text-muted">
                        {roleLabel(t, ws.role)}
                        {ws.isPersonal && <> · {t("workspaces.personal")}</>}
                        {busy === ws.id && <> · {t("nav.switching")}</>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="px-3 py-2 text-ui-sm text-red">
              {error}
            </p>
          )}
          {error && !data && !loading && (
            <button
              type="button"
              onClick={load}
              className="block px-3 pb-2 text-ui-sm text-accent hover:underline"
            >
              {t("common.retry")}
            </button>
          )}
          <Link
            href="/workspaces"
            onClick={() => {
              setOpen(false);
              onNavigate();
            }}
            className="block border-t border-border-soft px-3 py-2 text-ui-sm text-accent hover:underline"
          >
            {t("nav.manageWorkspaces")}
          </Link>
        </div>
      )}
    </div>
  );
}
