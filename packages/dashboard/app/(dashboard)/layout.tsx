import Link from "next/link";

import { Palette } from "@/components/palette/palette";
import { RouteStage } from "@/components/motion/route-stage";
import { RoomHeaderForPath } from "@/components/room-header-for-path";
import { SessionGuard } from "@/components/session-guard";
import { Sidebar } from "@/components/sidebar";
import { getT } from "@/lib/i18n/server";
import { getSession, redirectToLogin } from "@/lib/server-api";

/**
 * Authenticated shell: session guard, sidebar, the room header and the page.
 * Every page inside the (dashboard) group renders below the header.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  // Back to this address after signing in again (APP-041).
  if (!session) return redirectToLogin();
  const t = await getT();

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* First stop for a keyboard: past the sidebar to the room (APP-058). */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-surface focus:px-4 focus:py-2 focus:text-ui focus:text-accent focus:outline-2 focus:outline-accent"
      >
        {t("common.skipToContent")}
      </a>
      <SessionGuard />
      <Sidebar
        role={session.role}
        workspaceRole={session.workspaceRole ?? null}
        workspaceName={session.workspaceName}
        email={session.email ?? null}
        isSuperadmin={session.isSuperadmin === true}
      />
      <Palette
        role={session.role}
        isSuperadmin={session.isSuperadmin === true}
        personal={session.workspaceIsPersonal === true}
      />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-w-0 flex-1 overflow-x-hidden outline-none"
      >
        <RoomHeaderForPath isSuperadmin={session.isSuperadmin === true} />
        <div className="p-4 sm:p-6 lg:p-10">
          {session.viaInstance && session.role === "viewer" && (
            <div
              role="status"
              className="mb-5 border border-gold/40 bg-gold/10 px-3 py-2 text-ui text-gold"
            >
              {t("nav.viewingAsSuperadmin")}{" "}
              <Link href="/installation/workspaces" className="underline">
                {t("nav.backToAllWorkspaces")}
              </Link>
            </div>
          )}
          <RouteStage>{children}</RouteStage>
        </div>
      </main>
    </div>
  );
}
