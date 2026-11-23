"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Dialog } from "@/components/dialog";
import {
  Alert,
  dangerGhostButton,
  ghostButton,
  inputClass,
  primaryButton,
  selectClass,
} from "@/components/form-bits";
import { ConfirmDialog } from "@/components/keeper";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/core";
import { errorMessage } from "@/lib/i18n/errors";

/** A workspace the fact can move to: one the person may write to, not this one. */
export interface MoveTarget {
  id: string;
  name: string;
}

type Asked = "pin" | "forget" | "correct" | "move" | null;

const enc = encodeURIComponent;

/** The server's code for a refused write: `code` (HttpError) or a string `error`. */
async function codeOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { code?: unknown; error?: unknown } | null;
  return typeof body?.code === "string"
    ? body.code
    : typeof body?.error === "string"
      ? body.error
      : "";
}

/**
 * The actions on a live fact (5.4): pin or unpin, correct, move to another workspace, forget.
 * Each goes through the route the bridge already serves (POST /facts/:id/pin, PATCH /facts/:id
 * with `expectedRevision`, POST /facts/:id/relocate, DELETE /facts/:id) and only after a
 * confirmation. An action the session cannot perform is not offered; a note says which
 * permission or sign-in it needs instead.
 */
export function FactActions({
  id,
  statement,
  pinned,
  revision,
  canWrite,
  canDelete,
  targets,
}: {
  id: string;
  statement: string;
  pinned: boolean;
  /** The fact's `revisionCount`, sent as `expectedRevision` so a stale correction is refused. */
  revision?: number;
  canWrite: boolean;
  canDelete: boolean;
  /** null: no password session, so the person's workspaces are unknown. */
  targets: MoveTarget[] | null;
}) {
  const t = useT();
  const router = useRouter();
  const ids = useId();
  const [asked, setAsked] = useState<Asked>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [text, setText] = useState(statement);
  const [target, setTarget] = useState(targets?.[0]?.id ?? "");

  const canMove = canWrite && !!targets?.length;
  const notes = [
    ...(canWrite ? [] : [t("browser.actions.needsWrite")]),
    ...(canDelete ? [] : [t("browser.actions.needsDelete")]),
    ...(canWrite && targets === null ? [t("browser.actions.movePassword")] : []),
    ...(canWrite && targets?.length === 0 ? [t("browser.actions.moveNone")] : []),
  ];

  const open = (a: Exclude<Asked, null>) => {
    setError(null);
    setSaid("");
    if (a === "correct") setText(statement);
    setAsked(a);
  };

  /**
   * Sends one write; on success refreshes the plate and says `done`. Returns the error, if any.
   * The method is its own argument so the server's bridge-contract scan can read it.
   */
  async function send(
    url: string,
    method: "POST" | "PATCH" | "DELETE",
    body: unknown,
    done: string,
    codes: Record<string, MessageKey> = {}
  ): Promise<string | null> {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) {
        setSaid(done);
        router.refresh();
        return null;
      }
      const code = await codeOf(res);
      const key = codes[`${res.status}:${code}`] ?? codes[String(res.status)];
      return key ? t(key) : errorMessage(t, { status: res.status });
    } catch {
      return errorMessage(t, { code: "network" });
    } finally {
      setBusy(false);
    }
  }
  const GONE = { "404": "browser.actions.gone" } as const;

  /** Pin and forget close the dialog either way; a failure is said under the buttons. */
  async function confirmSimple() {
    const failure =
      asked === "pin"
        ? await send(
            `/dashboard/api/facts/${enc(id)}/pin`,
            "POST",
            { pinned: !pinned },
            t(pinned ? "browser.actions.unpinned" : "browser.actions.pinned"),
            GONE
          )
        : await send(
            `/dashboard/api/facts/${enc(id)}`,
            "DELETE",
            undefined,
            t("browser.actions.forgotten"),
            GONE
          );
    setError(failure);
    setAsked(null);
  }

  /** Correct and move keep their dialog open on a failure, with what was typed or chosen. */
  async function confirmForm(e: React.FormEvent) {
    e.preventDefault();
    const failure =
      asked === "correct"
        ? await send(
            `/dashboard/api/facts/${enc(id)}`,
            "PATCH",
            {
              statement: text.trim(),
              ...(revision !== undefined ? { expectedRevision: revision } : {}),
            },
            t("browser.actions.corrected"),
            { ...GONE, "409": "browser.actions.revisionConflict" }
          )
        : await send(
            `/dashboard/api/facts/${enc(id)}/relocate`,
            "POST",
            { targetWorkspaceId: target },
            t("browser.actions.moved", {
              name: targets?.find((w) => w.id === target)?.name ?? "",
            }),
            {
              ...GONE,
              "403": "browser.actions.notWritable",
              "409:sensitivity_blocked": "browser.actions.cannotLeave",
            }
          );
    setError(failure);
    if (!failure) setAsked(null);
  }

  const simple = asked === "pin" || asked === "forget";
  const formOpen = asked === "correct" || asked === "move";

  return (
    <div className="border-border mt-4 border-b pb-4">
      {(canWrite || canDelete) && (
        <div
          role="group"
          aria-label={t("browser.actions.label")}
          className="flex flex-wrap gap-2"
        >
          {canWrite && (
            <>
              <button type="button" className={ghostButton} onClick={() => open("pin")}>
                {t(pinned ? "browser.actions.unpin" : "browser.actions.pin")}
              </button>
              <button type="button" className={ghostButton} onClick={() => open("correct")}>
                {t("browser.actions.correct")}
              </button>
            </>
          )}
          {canMove && (
            <button type="button" className={ghostButton} onClick={() => open("move")}>
              {t("browser.actions.move")}
            </button>
          )}
          {canDelete && (
            <button type="button" className={dangerGhostButton} onClick={() => open("forget")}>
              {t("browser.actions.forget")}
            </button>
          )}
        </div>
      )}
      {notes.length > 0 && (
        <p role="note" className="text-text-muted text-ui-xs mt-2">
          {notes.join(" ")}
        </p>
      )}
      <p role="status" className="text-text-muted text-ui-sm mt-2 empty:hidden">
        {said}
      </p>
      {!formOpen && <Alert message={error} />}

      <ConfirmDialog
        open={simple}
        title={
          asked === "forget"
            ? t("browser.actions.forgetTitle")
            : t(pinned ? "browser.actions.unpinTitle" : "browser.actions.pinTitle")
        }
        body={
          asked === "forget"
            ? t("browser.actions.forgetBody")
            : t(pinned ? "browser.actions.unpinBody" : "browser.actions.pinBody")
        }
        confirmLabel={
          asked === "forget"
            ? t("browser.actions.forget")
            : t(pinned ? "browser.actions.unpin" : "browser.actions.pin")
        }
        tone={asked === "forget" ? "danger" : undefined}
        busy={busy}
        onConfirm={() => void confirmSimple()}
        onClose={() => setAsked(null)}
      />

      <Dialog
        open={formOpen}
        title={t(asked === "move" ? "browser.actions.moveTitle" : "browser.actions.correctTitle")}
        onClose={() => !busy && setAsked(null)}
      >
        <form onSubmit={confirmForm} className="text-ui text-text-muted space-y-3">
          {asked === "correct" ? (
            <>
              <label htmlFor={`${ids}-text`} className="text-text block font-medium">
                {t("browser.actions.correctField")}
              </label>
              <textarea
                id={`${ids}-text`}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={5}
                required
                className={inputClass}
              />
              <p className="text-ui-xs">{t("browser.actions.correctNote")}</p>
            </>
          ) : (
            <>
              <p>{t("browser.actions.moveBody")}</p>
              <label htmlFor={`${ids}-target`} className="text-text block font-medium">
                {t("browser.actions.moveField")}
              </label>
              <select
                id={`${ids}-target`}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className={selectClass}
              >
                {targets?.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </>
          )}
          <Alert message={error} />
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setAsked(null)}
              disabled={busy}
              className={ghostButton}
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              disabled={
                busy ||
                (asked === "correct" && (!text.trim() || text.trim() === statement.trim()))
              }
              aria-busy={busy || undefined}
              className={primaryButton}
            >
              {t(asked === "move" ? "browser.actions.move" : "browser.actions.correctSave")}
            </button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
