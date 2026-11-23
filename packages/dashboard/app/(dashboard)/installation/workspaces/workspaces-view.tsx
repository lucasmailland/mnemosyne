"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Dialog } from "@/components/dialog";
import {
  Alert,
  dangerButton,
  dangerGhostButton,
  failureMessage,
  ghostButton,
  inputClass,
  primaryButton,
  inputShort,
} from "@/components/form-bits";
import { Chevron } from "@/components/ui/popover";
import { RowMenu } from "@/components/ui/row-menu";
import { Field, Records, Section, StatusTag } from "@/components/keeper";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/core";
import { ROLES, roleLabel, type WorkspaceRole } from "@/lib/roles";

export interface InstanceWorkspace {
  id: string;
  name: string;
  tenantName: string;
  isPersonal: boolean;
  visibility: string;
  memberCount: number;
  owners: Array<{ id: string; email: string; displayName: string | null }>;
  /** Live memories under the caller's ceiling; null when unreadable. */
  factsLive?: number | null;
  lastWriteAt?: string | null;
}

type Role = WorkspaceRole;

interface Member {
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
  joinedAt: string;
}

const ERROR_COPY: Record<string, MessageKey> = {
  last_owner: "installation.workspaces.err.lastOwner",
  unknown_email: "installation.workspaces.err.unknownEmail",
  already_member: "installation.workspaces.err.alreadyMember",
  user_disabled: "installation.workspaces.err.userDisabled",
  ambiguous_email: "installation.workspaces.err.ambiguousEmail",
  personal_workspace: "installation.workspaces.err.personalWorkspace",
  instance_unavailable: "installation.workspaces.err.instanceUnavailable",
};

const call = (path: string, method: string, body?: unknown) =>
  fetch(`/dashboard/api/instance${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

export function WorkspacesView({
  workspaces,
  info,
}: {
  workspaces: InstanceWorkspace[];
  /** About the list, behind the (i) beside its heading. */
  info?: string;
}) {
  const t = useT();
  if (workspaces.length === 0)
    return <p className="text-ui text-text-muted">{t("installation.workspaces.empty")}</p>;
  return (
    <Section title={t("installation.workspaces.listLabel")} info={info}>
      <Records label={t("installation.workspaces.listLabel")}>
        {workspaces.map((workspace) => (
          <WorkspaceRow key={workspace.id} workspace={workspace} />
        ))}
      </Records>
    </Section>
  );
}

function WorkspaceRow({ workspace }: { workspace: InstanceWorkspace }) {
  const t = useT();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = `members-${workspace.id}`;

  async function loadMembers() {
    setError(null);
    try {
      const res = await call(`/workspaces/${encodeURIComponent(workspace.id)}/members`, "GET");
      if (!res.ok) {
        setError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      setMembers(((await res.json()) as { members: Member[] }).members);
    } catch {
      setError(t("errors.network"));
    }
  }

  async function toggle() {
    const next = !showMembers;
    setShowMembers(next);
    if (next) await loadMembers();
  }

  async function open() {
    setError(null);
    setBusy(true);
    try {
      const res = await call(`/workspaces/${encodeURIComponent(workspace.id)}/open`, "POST");
      if (!res.ok) {
        setError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      // A full navigation: the layout and the sidebar read the new session.
      window.location.assign("/dashboard");
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    // The members panel lives inside the record, so the row is its own block, not a flex Record.
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-words text-ui font-medium">{workspace.name}</span>
            {workspace.isPersonal && <StatusTag>{t("installation.workspaces.personal")}</StatusTag>}
          </div>
          <div className="mt-1 break-words text-ui-xs text-text-muted">
            {/* The member count opens the members below (a disclosure, not a menu item). */}
            <button
              type="button"
              aria-expanded={showMembers}
              aria-controls={panelId}
              aria-label={t("installation.workspaces.membersAria", { name: workspace.name })}
              onClick={toggle}
              className="inline-flex min-h-6 items-center gap-1 text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t("installation.workspaces.memberCount", { count: workspace.memberCount })}
              <span className={showMembers ? "rotate-180" : undefined}>
                <Chevron />
              </span>
            </button>{" "}
            · {t("installation.workspaces.ownerWord", { count: workspace.owners.length })}:{" "}
            {workspace.owners.map((o) => o.email).join(", ") || t("installation.workspaces.none")}
          </div>
          {workspace.owners.length === 0 && !workspace.isPersonal && (
            <p className="mt-1 text-ui-xs text-yellow">{t("installation.workspaces.noOwner")}</p>
          )}
        </div>
        <RowMenu
          name={workspace.name}
          actions={[
            {
              label: t("installation.workspaces.open"),
              ariaLabel: t("installation.workspaces.openAria", { name: workspace.name }),
              disabled: busy,
              onSelect: open,
            },
          ]}
        />
      </div>
      <Alert message={error} />
      {showMembers && (
        <div id={panelId} className="mt-4 border-t border-border pt-4">
          {members === null ? (
            <p className="text-ui-xs text-text-muted">{t("common.loadingEllipsis")}</p>
          ) : (
            <>
              {members.length === 0 ? (
                <p className="text-ui-xs text-text-muted">
                  {t("installation.workspaces.noMembers")}
                </p>
              ) : (
                <ul
                  className="divide-y divide-border"
                  aria-label={t("installation.workspaces.membersAria", { name: workspace.name })}
                >
                  {members.map((member) => (
                    <MemberRow
                      key={member.userId}
                      workspace={workspace}
                      member={member}
                      reload={loadMembers}
                    />
                  ))}
                </ul>
              )}
              {!workspace.isPersonal && (
                <AddMemberForm
                  workspace={workspace}
                  firstOwner={!members.some((m) => m.role === "owner")}
                  reload={loadMembers}
                />
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

function MemberRow({
  workspace,
  member,
  reload,
}: {
  workspace: InstanceWorkspace;
  member: Member;
  reload: () => Promise<void>;
}) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const base = `/workspaces/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(member.userId)}`;

  async function change(role: Role) {
    setError(null);
    setBusy(true);
    try {
      const res = await call(base, "PATCH", { role });
      if (!res.ok) setError(await failureMessage(t, res, ERROR_COPY));
      else {
        await reload();
        router.refresh();
      }
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setRemoveError(null);
    setBusy(true);
    try {
      const res = await call(base, "DELETE");
      if (!res.ok) {
        setRemoveError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      setConfirming(false);
      await reload();
      router.refresh();
    } catch {
      setRemoveError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  const id = `role-${workspace.id}-${member.userId}`;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
      <span className="min-w-0 flex-1 break-all text-ui">{member.email}</span>
      <label htmlFor={id} className="sr-only">
        {t("installation.workspaces.roleIn", { email: member.email, name: workspace.name })}
      </label>
      <select
        id={id}
        value={member.role}
        disabled={busy}
        onChange={(e) => change(e.target.value as Role)}
        className={inputShort}
      >
        {ROLES.map((role) => (
          <option key={role} value={role}>
            {roleLabel(t, role)}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setRemoveError(null);
          setConfirming(true);
        }}
        aria-label={t("installation.workspaces.removeAria", {
          email: member.email,
          name: workspace.name,
        })}
        className={dangerGhostButton}
      >
        {t("installation.workspaces.remove")}
      </button>
      <Alert message={error} />
      <Dialog
        open={confirming}
        title={t("installation.workspaces.removeTitle", { email: member.email })}
        onClose={() => setConfirming(false)}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void remove();
          }}
        >
          <p className="text-ui text-text-muted">
            {t("installation.workspaces.removeLead", {
              email: member.email,
              workspace: workspace.name,
            })}
          </p>
          <Alert message={removeError} />
          <div className="mt-5 flex flex-wrap justify-end gap-3">
            <button type="button" onClick={() => setConfirming(false)} className={ghostButton}>
              {t("common.cancel")}
            </button>
            <button type="submit" disabled={busy} className={dangerButton}>
              {busy
                ? t("installation.workspaces.removing")
                : t("installation.workspaces.removeMember")}
            </button>
          </div>
        </form>
      </Dialog>
    </li>
  );
}

/**
 * Add an existing account to the workspace by email. With no owner yet the
 * role starts at Owner: that is how an ownerless workspace gets one.
 */
function AddMemberForm({
  workspace,
  firstOwner,
  reload,
}: {
  workspace: InstanceWorkspace;
  firstOwner: boolean;
  reload: () => Promise<void>;
}) {
  const t = useT();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>(firstOwner ? "owner" : "write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailId = `add-email-${workspace.id}`;
  const roleId = `add-role-${workspace.id}`;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await call(`/workspaces/${encodeURIComponent(workspace.id)}/members`, "POST", {
        email: email.trim(),
        role,
      });
      if (!res.ok) {
        setError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      setEmail("");
      setRole("write");
      await reload();
      router.refresh();
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={add}
      aria-label={t("installation.workspaces.addAria", { name: workspace.name })}
      className="mt-4 border-t border-border pt-4"
    >
      <p className="text-ui-xs text-text-muted">{t("installation.workspaces.addLead")}</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <Field label={t("installation.workspaces.email")} htmlFor={emailId}>
            <input
              id={emailId}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
              autoComplete="off"
            />
          </Field>
        </div>
        <Field label={t("installation.workspaces.role")} htmlFor={roleId}>
          <select
            id={roleId}
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className={inputShort}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(t, r)}
              </option>
            ))}
          </select>
        </Field>
        <button type="submit" disabled={busy || !email.trim()} className={primaryButton}>
          {busy ? t("installation.workspaces.adding") : t("installation.workspaces.addMember")}
        </button>
      </div>
      <Alert message={error} />
    </form>
  );
}
