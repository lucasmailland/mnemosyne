"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  Alert,
  IssuedLink,
  failureMessage,
  inputClass,
  primaryButton,
  selectClass,
} from "@/components/form-bits";
import {
  ConfirmDialog,
  Field,
  RecordRow,
  Records,
  Section,
  useFocusSectionAfter,
} from "@/components/keeper";
import { InfoTip } from "@/components/ui/info-tip";
import { RowMenu } from "@/components/ui/row-menu";
import { useLocale, useT } from "@/lib/i18n/client";
import { formatDate, type MessageKey } from "@/lib/i18n/core";
import { ROLES, roleLabel, type WorkspaceRole } from "@/lib/roles";

export type Role = WorkspaceRole;

const ERROR_COPY: Record<string, MessageKey> = {
  last_owner: "members.err.lastOwner",
  role_not_allowed: "members.err.roleNotAllowed",
  not_workspace_admin: "members.err.notWorkspaceAdmin",
  forbidden: "members.err.notWorkspaceAdmin",
  already_member: "members.err.alreadyMember",
  invitations_disabled: "members.err.invitationsDisabled",
  personal_workspace: "members.err.personalWorkspace",
  member_not_found: "members.err.memberNotFound",
  invitation_not_found: "members.err.invitationNotFound",
  invalid_request: "members.err.invalidRequest",
};

const api = (path: string, method: string, body?: unknown) =>
  fetch(`/dashboard/api/workspace${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

/** Role select and remove button of one member row. */
export function MemberControls({
  userId,
  email,
  role,
  viewerRole,
  isSelf,
  soleOwner = false,
}: {
  userId: string;
  email: string;
  role: Role;
  viewerRole: Role;
  isSelf: boolean;
  /** This member is the workspace's only owner: no role change, no leaving. */
  soleOwner?: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [value, setValue] = useState<Role>(role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Removing a member takes the row away: focus goes to the list's heading.
  const focus = useFocusSectionAfter<HTMLDivElement>(confirming);
  useEffect(() => setValue(role), [role]);

  // An admin neither promotes to owner nor touches an owner (the server decides too).
  const locked = viewerRole !== "owner" && role === "owner";
  const choices = viewerRole === "owner" ? ROLES : ROLES.filter((r) => r !== "owner");

  if (soleOwner) {
    // The role, and why it cannot change yet behind the (i).
    return (
      <p className="flex items-center gap-1 text-ui-sm text-text-muted">
        {roleLabel(t, role)}
        <InfoTip
          label={roleLabel(t, role)}
          text={t(isSelf ? "members.soleOwnerSelf" : "members.soleOwnerOther", {
            role: roleLabel(t, role),
          })}
        />
      </p>
    );
  }

  async function change(next: Role) {
    setError(null);
    setBusy(true);
    const previous = value;
    setValue(next);
    try {
      const res = await api(`/members/${encodeURIComponent(userId)}`, "PATCH", { role: next });
      if (!res.ok) {
        setValue(previous);
        setError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      router.refresh();
    } catch {
      setValue(previous);
      setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setError(null);
    setBusy(true);
    try {
      const res = await api(`/members/${encodeURIComponent(userId)}`, "DELETE");
      if (!res.ok) {
        setError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      if (isSelf) window.location.assign("/dashboard");
      else {
        focus.moved();
        router.refresh();
      }
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div ref={focus.ref} className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <label className="sr-only" htmlFor={`role-${userId}`}>
        {t("members.roleOf", { email })}
      </label>
      <div className="w-full sm:w-44">
        <select
          id={`role-${userId}`}
          value={value}
          disabled={busy || locked}
          onChange={(e) => change(e.target.value as Role)}
          className={selectClass}
        >
          {(choices.includes(value) ? choices : [value, ...choices]).map((r) => (
            <option key={r} value={r}>
              {roleLabel(t, r)}
            </option>
          ))}
        </select>
      </div>
      {!locked && (
        <RowMenu
          name={email}
          actions={[
            {
              label: t(isSelf ? "members.leave" : "members.remove"),
              ariaLabel: t(isSelf ? "members.leaveAria" : "members.removeAria", { email }),
              danger: true,
              disabled: busy,
              onSelect: () => setConfirming(true),
            },
          ]}
        />
      )}
      <ConfirmDialog
        open={confirming}
        title={t(isSelf ? "members.leaveAria" : "members.removeAria", { email })}
        body={t(isSelf ? "members.confirmLeave" : "members.confirmRemove", { email })}
        confirmLabel={t(isSelf ? "members.leave" : "members.remove")}
        tone="danger"
        busy={busy}
        onConfirm={remove}
        onClose={() => setConfirming(false)}
      />
      <Alert message={error} />
    </div>
  );
}

interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

interface Issued {
  email: string;
  link: string;
  expiresAt: string;
}

/** The invite form, the link shown after issuing one, and the pending invitations. */
export function InvitationsSection({
  invitations,
  viewerRole,
}: {
  invitations: Invitation[];
  viewerRole: Role;
}) {
  const t = useT();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const choices = viewerRole === "owner" ? ROLES : ROLES.filter((r) => r !== "owner");

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api("/invitations", "POST", { email: email.trim(), role });
      if (!res.ok) {
        setError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      const body = (await res.json()) as { link: string; expiresAt: string };
      setIssued({ email: email.trim().toLowerCase(), link: body.link, expiresAt: body.expiresAt });
      setEmail("");
      router.refresh();
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section id="invite" title={t("members.invitations")}>
      <form onSubmit={invite} className="border border-border bg-surface p-4">
        {/* One row: email, role, the button; it wraps on a phone. */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <Field label={t("members.email")} htmlFor="invite-email">
              <input
                id="invite-email"
                type="email"
                required
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                className={inputClass}
              />
            </Field>
          </div>
          <Field label={t("members.role")} htmlFor="invite-role">
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              disabled={busy}
              className={selectClass}
            >
              {choices.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(t, r)}
                </option>
              ))}
            </select>
          </Field>
          <button type="submit" disabled={busy || !email.trim()} className={primaryButton}>
            {busy ? t("members.creating") : t("members.createInvitation")}
          </button>
        </div>
        <Alert message={error} />
      </form>

      {issued && (
        <IssuedLink
          label={t("members.invitationLinkFor", { email: issued.email })}
          issued={issued}
          onDone={() => setIssued(null)}
        />
      )}

      <div className="mt-4">
        {invitations.length === 0 ? (
          <p className="text-ui text-text-muted">{t("members.noPending")}</p>
        ) : (
          <Records label={t("members.pendingLabel")}>
            {invitations.map((invitation) => (
              <PendingInvitation
                key={invitation.id}
                invitation={invitation}
                locked={viewerRole !== "owner" && invitation.role === "owner"}
                onIssued={setIssued}
              />
            ))}
          </Records>
        )}
      </div>
    </Section>
  );
}

function PendingInvitation({
  invitation,
  locked,
  onIssued,
}: {
  invitation: Invitation;
  locked: boolean;
  onIssued: (issued: Issued) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Revoking takes the row away: focus goes to the list's heading.
  const focus = useFocusSectionAfter<HTMLDivElement>(confirming);

  async function run(action: "regenerate" | "revoke") {
    setError(null);
    setBusy(true);
    try {
      const id = encodeURIComponent(invitation.id);
      const res =
        action === "regenerate"
          ? await api(`/invitations/${id}/regenerate`, "POST")
          : await api(`/invitations/${id}`, "DELETE");
      if (!res.ok) {
        setError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      if (action === "regenerate") {
        const body = (await res.json()) as { link: string; expiresAt: string };
        onIssued({ email: invitation.email, link: body.link, expiresAt: body.expiresAt });
      } else focus.moved();
      router.refresh();
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <RecordRow>
      <div ref={focus.ref} className="min-w-0 flex-1">
        <div className="break-words text-ui font-medium">{invitation.email}</div>
        <div className="text-ui-xs text-text-muted">
          {t("members.invitationMeta", {
            role: roleLabel(t, invitation.role),
            date: formatDate(locale, invitation.expiresAt, "short"),
          })}
        </div>
      </div>
      {!locked && (
        <RowMenu
          name={invitation.email}
          actions={[
            {
              label: t("members.newLink"),
              ariaLabel: t("members.newLinkAria", { email: invitation.email }),
              disabled: busy,
              onSelect: () => run("regenerate"),
            },
            {
              label: t("members.revoke"),
              ariaLabel: t("members.revokeAria", { email: invitation.email }),
              danger: true,
              disabled: busy,
              onSelect: () => setConfirming(true),
            },
          ]}
        />
      )}
      <ConfirmDialog
        open={confirming}
        title={t("members.revokeAria", { email: invitation.email })}
        body={t("members.confirmRevoke", { email: invitation.email })}
        confirmLabel={t("members.revoke")}
        tone="danger"
        busy={busy}
        onConfirm={() => run("revoke")}
        onClose={() => setConfirming(false)}
      />
      <Alert message={error} />
    </RecordRow>
  );
}
