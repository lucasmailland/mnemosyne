import { RecordRow, Records, Section, StatusTag } from "@/components/keeper";
import { formatDate } from "@/lib/i18n/core";
import { getLocale, getT, roomTitle } from "@/lib/i18n/server";
import { roleLabel } from "@/lib/roles";
import { apiGet, getSession } from "@/lib/server-api";

import { MemberFigures } from "./figures";
import { InvitationsSection, MemberControls, type Role } from "./member-actions";

/**
 * Admin — Members: who belongs to the session workspace, their roles, and the
 * pending invitations (accounts stage A). Owners and admins only; the role of
 * the viewer comes from the server's member list, not from the session scopes.
 */

interface Member {
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
  joinedAt: string;
  /** The member's latest audit entry here; null when none or unreadable. */
  lastActiveAt?: string | null;
}

interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

export const generateMetadata = roomTitle("members");

const isMember = (v: unknown): v is Member => {
  const m = v as Partial<Member> | null;
  return (
    typeof m === "object" &&
    m !== null &&
    typeof m.userId === "string" &&
    typeof m.email === "string" &&
    typeof m.role === "string" &&
    typeof m.joinedAt === "string"
  );
};
const isInvitation = (v: unknown): v is Invitation => {
  const i = v as Partial<Invitation> | null;
  return (
    typeof i === "object" &&
    i !== null &&
    typeof i.id === "string" &&
    typeof i.email === "string" &&
    typeof i.expiresAt === "string"
  );
};

/** The list, validated at the edge: a wrong shape is the load error, never a crash (APP-043). */
function parseMembers(v: unknown): { members: Member[]; invitations: Invitation[] } | null {
  const d = v as { members?: unknown; invitations?: unknown } | null;
  if (typeof d !== "object" || d === null || !Array.isArray(d.members)) return null;
  if (!Array.isArray(d.invitations)) return null;
  return { members: d.members.filter(isMember), invitations: d.invitations.filter(isInvitation) };
}

export default async function MembersPage() {
  const t = await getT();
  const locale = await getLocale();
  const [session, raw] = await Promise.all([getSession(), apiGet<unknown>("/workspace/members")]);
  const data = parseMembers(raw);

  if (session && session.role !== "admin") {
    return (
      <div className="w-full">
        <p className="mt-6 text-ui text-text-muted">{t("members.onlyAdmins")}</p>
      </div>
    );
  }

  // The members routes admit password sessions only: an API key gets no list, and the reason
  // is the sign-in, not a failed load (APP-040).
  if (session?.authMethod === "apiKey") {
    return (
      <div className="w-full">
        <p className="mt-6 text-ui text-text-muted">{t("members.apiKeySession")}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="w-full">
        <p className="mt-6 text-ui text-text-muted">{t("members.loadError")}</p>
      </div>
    );
  }

  const me = data.members.find((member) => member.userId === session?.userId);
  const myRole: Role = me?.role ?? "admin";
  const ownerCount = data.members.filter((member) => member.role === "owner").length;
  // A personal workspace takes no other members (the server refuses invites,
  // role changes and leaving there): show what it is instead of the controls.
  const personal = session?.workspaceIsPersonal === true;

  return (
    <div className="w-full">
      <MemberFigures t={t} members={data.members} invitations={data.invitations} />
      {personal && (
        <p
          role="note"
          className="mb-6 border border-border bg-surface-2 px-4 py-3 text-ui text-text-muted"
        >
          {t("members.personalNote")}
        </p>
      )}

      <Section
        title={t("members.listLabel")}
        info={t("lead.members", { workspace: session?.workspaceName ?? t("nav.thisWorkspace") })}
      >
        <Records label={t("members.listLabel")}>
          {data.members.map((member) => {
            const isSelf = member.userId === session?.userId;
            return (
              <RecordRow key={member.userId}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-words text-ui font-medium">{member.email}</span>
                    {isSelf && <StatusTag tone="accent">{t("members.you")}</StatusTag>}
                  </div>
                  <div className="text-ui-xs text-text-muted">
                    {member.displayName ? `${member.displayName} · ` : ""}
                    {t("members.joined", { date: formatDate(locale, member.joinedAt, "short") })}
                    {member.lastActiveAt &&
                      ` · ${t("metrics.members.lastActive", { date: formatDate(locale, member.lastActiveAt, "short") })}`}
                  </div>
                </div>
                {personal ? (
                  <StatusTag tone={member.role === "owner" ? "accent" : "neutral"}>
                    {roleLabel(t, member.role)}
                  </StatusTag>
                ) : (
                  <MemberControls
                    userId={member.userId}
                    email={member.email}
                    role={member.role}
                    viewerRole={myRole}
                    isSelf={isSelf}
                    soleOwner={member.role === "owner" && ownerCount === 1}
                  />
                )}
              </RecordRow>
            );
          })}
        </Records>
      </Section>

      {!personal && <InvitationsSection invitations={data.invitations} viewerRole={myRole} />}
    </div>
  );
}
