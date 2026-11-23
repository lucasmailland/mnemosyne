"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Dialog } from "@/components/dialog";
import {
  Alert,
  IssuedLink,
  dangerButton,
  failureMessage,
  ghostButton,
  inputClass,
  primaryButton,
  selectClass,
  type IssuedLinkData,
} from "@/components/form-bits";
import { Field, RecordRow, Records, Section, StatusTag } from "@/components/keeper";
import { RowMenu } from "@/components/ui/row-menu";
import { useLocale, useT } from "@/lib/i18n/client";
import { formatDate, type MessageKey, type T } from "@/lib/i18n/core";
import { isRole, roleLabel } from "@/lib/roles";

export interface InstanceUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  disabledAt: string | null;
  isSuperadmin: boolean;
  workspaces: Array<{ id: string; name: string; role: string }>;
}

const ERROR_COPY: Record<string, MessageKey> = {
  invalid_credentials: "installation.users.err.invalidCredentials",
  last_superadmin: "installation.users.err.lastSuperadmin",
  self: "installation.users.err.self",
  user_disabled: "installation.users.err.userDisabled",
  email_taken: "installation.users.err.emailTaken",
  invalid_request: "installation.users.err.invalidRequest",
  invalid_new_owner: "installation.users.err.invalidNewOwner",
  last_owner: "installation.users.err.lastOwner",
  ambiguous_email: "installation.users.err.ambiguousEmail",
  instance_unavailable: "installation.users.err.instanceUnavailable",
};

const roleText = (t: T, role: string) => (isRole(role) ? roleLabel(t, role) : role);

const call = (path: string, method: string, body?: unknown) =>
  fetch(`/dashboard/api/instance${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

type DialogState =
  | { kind: "create" }
  | { kind: "disable" | "grant" | "revoke" | "offboard"; user: InstanceUser }
  | { kind: "link"; title: string; label: string; issued: IssuedLinkData };

export function UsersView({ users, viewerId }: { users: InstanceUser[]; viewerId: string | null }) {
  const t = useT();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const close = () => setDialog(null);

  const title =
    dialog === null
      ? ""
      : dialog.kind === "create"
        ? t("installation.users.create")
        : dialog.kind === "link"
          ? dialog.title
          : dialog.kind === "disable"
            ? t("installation.users.disableAria", { email: dialog.user.email })
            : dialog.kind === "grant"
              ? t("installation.users.grantAria", { email: dialog.user.email })
              : dialog.kind === "revoke"
                ? t("installation.users.revokeAria", { email: dialog.user.email })
                : t("installation.users.offboardAria", { email: dialog.user.email });

  return (
    <>
      <Section
        title={t("installation.users.listLabel")}
        action={
          <button
            type="button"
            onClick={() => setDialog({ kind: "create" })}
            className={primaryButton}
          >
            {t("installation.users.create")}
          </button>
        }
      >
        <Records label={t("installation.users.listLabel")}>
          {users.map((user) => (
            <UserRow key={user.id} user={user} isSelf={user.id === viewerId} open={setDialog} />
          ))}
        </Records>
      </Section>

      <Dialog open={dialog !== null} title={title} onClose={close}>
        {dialog?.kind === "create" && <CreateUserForm onClose={close} open={setDialog} />}
        {dialog?.kind === "link" && (
          <IssuedLink label={dialog.label} issued={dialog.issued} onDone={close} bare />
        )}
        {dialog?.kind === "disable" && <DisableForm user={dialog.user} onClose={close} />}
        {(dialog?.kind === "grant" || dialog?.kind === "revoke") && (
          <SuperadminForm user={dialog.user} grant={dialog.kind === "grant"} onClose={close} />
        )}
        {dialog?.kind === "offboard" && (
          <OffboardForm user={dialog.user} users={users} onClose={close} />
        )}
      </Dialog>
    </>
  );
}

function UserRow({
  user,
  isSelf,
  open,
}: {
  user: InstanceUser;
  isSelf: boolean;
  open: (state: DialogState) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = user.disabledAt !== null;

  async function run(path: string, then: (res: Response) => Promise<void> | void) {
    setError(null);
    setBusy(true);
    try {
      const res = await call(path, "POST");
      if (!res.ok) {
        setError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      await then(res);
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <RecordRow>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-all text-ui font-medium">{user.email}</span>
          <StatusTag tone={disabled ? "bad" : "good"}>
            {disabled ? t("installation.users.disabled") : t("installation.users.active")}
          </StatusTag>
          {user.isSuperadmin && (
            <StatusTag tone="accent">{t("installation.users.superadmin")}</StatusTag>
          )}
          {isSelf && (
            <span className="text-ui-xs text-text-muted">{t("installation.users.you")}</span>
          )}
        </div>
        <div className="mt-1 text-ui-xs text-text-muted">
          {user.displayName ? `${user.displayName} · ` : ""}
          {user.lastLoginAt
            ? t("installation.users.lastSignIn", {
                when: formatDate(locale, user.lastLoginAt, "datetime"),
              })
            : t("installation.users.neverSignedIn")}
        </div>
        <div className="mt-1 break-words text-ui-xs text-text-muted">
          {user.workspaces.length === 0
            ? t("installation.users.noWorkspaces")
            : user.workspaces.map((w) => `${w.name} (${roleText(t, w.role)})`).join(", ")}
        </div>
      </div>

      <RowMenu
        name={user.email}
        actions={[
          disabled
            ? {
                label: t("installation.users.enable"),
                ariaLabel: t("installation.users.enableAria", { email: user.email }),
                disabled: busy,
                onSelect: () =>
                  run(`/users/${encodeURIComponent(user.id)}/enable`, () => router.refresh()),
              }
            : {
                label: t("installation.users.disable"),
                ariaLabel: t("installation.users.disableAria", { email: user.email }),
                danger: true,
                disabled: busy,
                onSelect: () => open({ kind: "disable", user }),
              },
          {
            label: user.isSuperadmin
              ? t("installation.users.revokeSuperadmin")
              : t("installation.users.grantSuperadmin"),
            ariaLabel: t(
              user.isSuperadmin ? "installation.users.revokeAria" : "installation.users.grantAria",
              { email: user.email }
            ),
            disabled: busy,
            onSelect: () => open({ kind: user.isSuperadmin ? "revoke" : "grant", user }),
          },
          {
            label: t("installation.users.resetLink"),
            ariaLabel: t("installation.users.resetLinkAria", { email: user.email }),
            disabled: busy || disabled,
            onSelect: () =>
              run(`/users/${encodeURIComponent(user.id)}/reset-link`, async (res) => {
                const body = (await res.json()) as { link: string; expiresAt: string };
                open({
                  kind: "link",
                  title: t("installation.users.resetTitle"),
                  label: t("installation.users.resetLabel", { email: user.email }),
                  issued: { email: user.email, link: body.link, expiresAt: body.expiresAt },
                });
              }),
          },
          {
            label: t("installation.users.offboard"),
            ariaLabel: t("installation.users.offboardAria", { email: user.email }),
            danger: true,
            disabled: busy || isSelf,
            onSelect: () => open({ kind: "offboard", user }),
          },
        ]}
      />
      <Alert message={error} />
    </RecordRow>
  );
}

function Buttons({
  busy,
  submit,
  onClose,
  danger = false,
}: {
  busy: boolean;
  submit: string;
  onClose: () => void;
  danger?: boolean;
}) {
  const t = useT();
  return (
    <div className="mt-5 flex flex-wrap justify-end gap-3">
      <button type="button" onClick={onClose} className={ghostButton}>
        {t("common.cancel")}
      </button>
      <button type="submit" disabled={busy} className={danger ? dangerButton : primaryButton}>
        {submit}
      </button>
    </div>
  );
}

function CreateUserForm({
  onClose,
  open,
}: {
  onClose: () => void;
  open: (state: DialogState) => void;
}) {
  const t = useT();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await call("/users", "POST", {
        email: email.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      if (!res.ok) {
        setError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      const body = (await res.json()) as { link: string; expiresAt: string };
      const address = email.trim().toLowerCase();
      open({
        kind: "link",
        title: t("installation.users.setupTitle"),
        label: t("installation.users.setupLabel", { email: address }),
        issued: { email: address, link: body.link, expiresAt: body.expiresAt },
      });
      router.refresh();
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="mb-4 text-ui text-text-muted">{t("installation.users.createLead")}</p>
      <div className="flex flex-col gap-4">
        <Field label={t("installation.users.email")} htmlFor="new-user-email">
          <input
            id="new-user-email"
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            className={inputClass}
          />
        </Field>
        <Field label={t("installation.users.nameOptional")} htmlFor="new-user-name">
          <input
            id="new-user-name"
            autoComplete="off"
            maxLength={200}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={busy}
            className={inputClass}
          />
        </Field>
      </div>
      <Alert message={error} />
      <Buttons
        busy={busy || !email.trim()}
        submit={busy ? t("installation.users.creating") : t("installation.users.create")}
        onClose={onClose}
      />
    </form>
  );
}

function DisableForm({ user, onClose }: { user: InstanceUser; onClose: () => void }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await call(`/users/${encodeURIComponent(user.id)}/disable`, "POST");
      if (!res.ok) {
        setError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      router.refresh();
      onClose();
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="text-ui text-text-muted">{t("installation.users.disableLead")}</p>
      <Alert message={error} />
      <Buttons
        busy={busy}
        submit={busy ? t("installation.users.disabling") : t("installation.users.disable")}
        onClose={onClose}
        danger
      />
    </form>
  );
}

function SuperadminForm({
  user,
  grant,
  onClose,
}: {
  user: InstanceUser;
  grant: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await call(
        `/users/${encodeURIComponent(user.id)}/superadmin`,
        grant ? "POST" : "DELETE",
        { password }
      );
      if (!res.ok) {
        setPassword("");
        setError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      router.refresh();
      onClose();
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="mb-4 text-ui text-text-muted">
        {grant ? t("installation.users.grantLead") : t("installation.users.revokeLead")}{" "}
        {t("installation.users.confirmPassword")}
      </p>
      <Field label={t("installation.users.yourPassword")} htmlFor="reentry-password">
        <input
          id="reentry-password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          className={inputClass}
        />
      </Field>
      <Alert message={error} />
      <Buttons
        busy={busy || !password}
        submit={
          busy
            ? t("installation.users.confirming")
            : grant
              ? t("installation.users.grantSuperadmin")
              : t("installation.users.revokeSuperadmin")
        }
        onClose={onClose}
        danger={!grant}
      />
    </form>
  );
}

function OffboardForm({
  user,
  users,
  onClose,
}: {
  user: InstanceUser;
  users: InstanceUser[];
  onClose: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needed, setNeeded] = useState<Array<{ id: string; name: string }>>([]);
  const [owners, setOwners] = useState<Record<string, string>>({});
  const candidates = users
    .filter((u) => u.id !== user.id && u.disabledAt === null)
    .sort((a, b) => a.email.localeCompare(b.email));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await call(`/users/${encodeURIComponent(user.id)}/offboard`, "POST", {
        newOwners: owners,
      });
      if (res.status === 409) {
        const body = (await res
          .clone()
          .json()
          .catch(() => ({}))) as {
          error?: string;
          workspaces?: Array<{ id: string; name: string }>;
        };
        if (body.error === "owner_required" && body.workspaces?.length) {
          setNeeded(body.workspaces);
          setError(
            t(
              body.workspaces.length === 1
                ? "installation.users.onlyOwnerOne"
                : "installation.users.onlyOwnerMany",
              { email: user.email }
            )
          );
          return;
        }
      }
      if (!res.ok) {
        setError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      router.refresh();
      onClose();
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="text-ui text-text-muted">{t("installation.users.offboardLead")}</p>
      {needed.map((workspace) => (
        <div key={workspace.id} className="mt-4">
          <Field
            label={t("installation.users.newOwnerOf", { name: workspace.name })}
            htmlFor={`owner-${workspace.id}`}
          >
            <select
              id={`owner-${workspace.id}`}
              required
              value={owners[workspace.id] ?? ""}
              onChange={(e) => setOwners({ ...owners, [workspace.id]: e.target.value })}
              disabled={busy}
              className={selectClass}
            >
              <option value="" disabled>
                {t("installation.users.chooseUser")}
              </option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.email}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ))}
      <Alert message={error} />
      <Buttons
        busy={busy}
        submit={busy ? t("installation.users.offboarding") : t("installation.users.offboard")}
        onClose={onClose}
        danger
      />
    </form>
  );
}
