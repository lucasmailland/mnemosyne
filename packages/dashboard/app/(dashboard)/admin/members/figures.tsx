import { Band } from "@/components/charts/band";
import { ChartCard } from "@/components/charts/chart-card";
import { SegmentedBar } from "@/components/charts/segmented-bar";
import { StatTile } from "@/components/charts/stat-tile";
import type { T } from "@/lib/i18n/core";
import { roleLabel, type WorkspaceRole } from "@/lib/roles";

const DAY = 86_400_000;
const ROLES: WorkspaceRole[] = ["owner", "admin", "write", "read"];

/**
 * The workspace's people in figures, from the whole GET /workspace/members answer: members,
 * those active in the last 7 days (their latest audit entry), pending invitations and the ones
 * that expire within 7 days; then members by role.
 */
export function MemberFigures({
  t,
  members,
  invitations,
  now = Date.now(),
}: {
  t: T;
  members: Array<{ role: WorkspaceRole; lastActiveAt?: string | null }>;
  invitations: Array<{ expiresAt: string }>;
  now?: number;
}) {
  const known = members.some((m) => m.lastActiveAt !== undefined);
  const active = members.filter(
    (m) => m.lastActiveAt && now - new Date(m.lastActiveAt).getTime() <= 7 * DAY
  ).length;
  const expiring = invitations.filter((i) => {
    const left = new Date(i.expiresAt).getTime() - now;
    return left >= 0 && left <= 7 * DAY;
  }).length;
  return (
    <div className="mb-6 space-y-6">
      <Band title={t("metrics.title")} cols={4}>
        <StatTile
          label={t("metrics.members.members")}
          definition={t("metrics.members.membersDef")}
          value={members.length}
        />
        <StatTile
          label={t("metrics.members.active")}
          definition={t("metrics.members.activeDef")}
          value={known ? active : null}
        />
        <StatTile
          label={t("metrics.members.pending")}
          definition={t("metrics.members.pendingDef")}
          value={invitations.length}
        />
        <StatTile
          label={t("metrics.members.expiring")}
          definition={t("metrics.members.expiringDef")}
          value={expiring}
        />
      </Band>
      <ChartCard
        title={t("metrics.members.byRole")}
        period={t("metrics.liveNow")}
        definition={t("metrics.members.byRoleDef")}
      >
        <SegmentedBar
          label={t("metrics.members.byRole")}
          parts={ROLES.map((role) => ({
            name: roleLabel(t, role),
            value: members.filter((m) => m.role === role).length,
          }))}
        />
      </ChartCard>
    </div>
  );
}
