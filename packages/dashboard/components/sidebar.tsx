"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { PALETTE_NAVIGATE, PaletteTrigger } from "@/components/palette/palette-trigger";
import { Wordmark } from "@/components/brand/wordmark";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { useT } from "@/lib/i18n/client";
import type { WorkspaceRole } from "@/lib/roles";
import { ROOMS, roomForPath, type Room } from "@/lib/rooms";
import { cn } from "@/lib/utils";

export interface SidebarProps {
  /** What the session may do (from its scopes): decides the Admin group. */
  role: "admin" | "contributor" | "viewer";
  /** The membership role, shown under the workspace name when known (password sessions). */
  workspaceRole?: WorkspaceRole | null;
  workspaceName?: string | null;
  /** The signed-in account (password sessions); an API key session has none. */
  email?: string | null;
  /** Shows the Installation group. */
  isSuperadmin?: boolean;
}

const inGroup = (...groups: Room["group"][]) => ROOMS.filter((r) => groups.includes(r.group));

/**
 * The rooms outside the palace (Installation) carry no Roman numeral of their own: the index
 * marks them with Greek capitals, in order, so every line of the index has a mark.
 */
const GREEK = ["Α", "Β", "Γ", "Δ", "Ε", "Ζ"];

/** What Tab cycles through while the phone drawer is open (the scrim has tabIndex -1). */
const FOCUSABLE = "a[href], button:not([disabled])";

/** One line of the index: the numeral in Didot, right-aligned in its column, then the room. */
function NavLink({
  room,
  marker,
  active,
  onNavigate,
}: {
  room: Room;
  marker: string;
  active: boolean;
  onNavigate: () => void;
}) {
  const t = useT();
  return (
    <Link
      href={room.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex items-baseline gap-3 py-2 pl-1 pr-3 text-ui transition-colors",
        active
          ? "bg-surface font-medium text-text shadow-sm ring-1 ring-border-soft"
          : "text-text-muted hover:bg-surface/60 hover:text-text"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "w-10 shrink-0 text-right font-display text-ui-sm",
          active ? "text-accent" : "text-text-faint group-hover:text-text-muted"
        )}
      >
        {marker}
      </span>
      <span className="min-w-0 flex-1 truncate">{t(room.nav)}</span>
    </Link>
  );
}

/** A group title: small capitals followed by a hairline to the edge. */
function GroupHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 pb-1 pl-3 pr-1 pt-5">
      <span className="eyebrow">{children}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}

export function Sidebar({
  role,
  workspaceRole,
  workspaceName,
  email,
  isSuperadmin = false,
}: SidebarProps) {
  const t = useT();
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [signingOut, setSigningOut] = useState(false);
  const room = roomForPath(pathname);

  const [signOutFailed, setSignOutFailed] = useState(false);

  // The login screen is shown only once the server has closed the session: after a
  // network error or a refusal the cookie is still valid, and saying otherwise would lie.
  async function logout() {
    setSigningOut(true);
    setSignOutFailed(false);
    const ok = await fetch("/dashboard/auth/logout", { method: "POST" }).then(
      (res) => res.ok,
      () => false
    );
    if (ok) return router.replace("/login");
    setSigningOut(false);
    setSignOutFailed(true);
  }

  const close = () => {
    if (menuOpen) menuButton.current?.focus();
    setMenuOpen(false);
  };
  const link = (r: Room, marker: string) => (
    <NavLink key={r.id} room={r} marker={marker} active={r.id === room?.id} onNavigate={close} />
  );
  const numbered = (r: Room) => link(r, r.numeral ?? "");
  const accountActive = room?.id === "account";

  // The open phone drawer is modal: focus moves in, the page behind is inert,
  // Escape closes it from anywhere, and it closes if the window widens past
  // the phone layout (the drawer becomes the sidebar there).
  const drawer = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const main = document.querySelector("main");
    main?.setAttribute("inert", "");
    drawer.current?.querySelector<HTMLElement>("a[href]")?.focus();
    const onKey = (event: KeyboardEvent) => {
      // Escape inside a modal dialog (the palette opened from here) closes only that dialog.
      if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    const wide = window.matchMedia?.("(min-width: 768px)");
    const onWide = () => wide?.matches && setMenuOpen(false);
    document.addEventListener("keydown", onKey);
    wide?.addEventListener("change", onWide);
    return () => {
      main?.removeAttribute("inert");
      document.removeEventListener("keydown", onKey);
      wide?.removeEventListener("change", onWide);
    };
  }, [menuOpen]);

  // Any navigation closes the drawer, not only its own links (a palette result, Back); focus
  // left inside it goes to the Menu button rather than into a hidden drawer.
  const shownPath = useRef(pathname);
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    if (!menuOpen) return;
    if (drawer.current?.contains(document.activeElement)) menuButton.current?.focus();
    setMenuOpen(false);
  }, [pathname, menuOpen]);

  // A palette pick that keeps the path (only the search or hash changes) closes it too.
  useEffect(() => {
    if (!menuOpen) return;
    const onPick = () => {
      if (drawer.current?.contains(document.activeElement)) menuButton.current?.focus();
      setMenuOpen(false);
    };
    window.addEventListener(PALETTE_NAVIGATE, onPick);
    return () => window.removeEventListener(PALETTE_NAVIGATE, onPick);
  }, [menuOpen]);

  return (
    <div
      className="shrink-0 md:w-61"
      onKeyDown={(event) => {
        // Tab wraps between the Menu button and the drawer while it is open.
        if (!menuOpen || event.key !== "Tab") return;
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
          (el) => el.tabIndex >= 0
        );
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      {/* Above the scrim, so the Close menu button stays visible and clickable. */}
      <div className="relative z-40 flex items-center justify-between border-b border-border bg-surface-2 px-4 py-3 md:hidden">
        <Wordmark className="text-accent" height={21} />
        <button
          ref={menuButton}
          type="button"
          aria-expanded={menuOpen}
          aria-controls="dashboard-navigation"
          onClick={() => setMenuOpen(!menuOpen)}
          className="min-h-11 border border-border px-3 text-ui text-text hover:bg-base focus-visible:outline-2 focus-visible:outline-accent"
        >
          {menuOpen ? t("nav.closeMenu") : t("nav.menu")}
        </button>
      </div>

      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        data-open={menuOpen}
        onClick={() => {
          setMenuOpen(false);
          menuButton.current?.focus();
        }}
        className="scrim fixed inset-0 z-30 md:hidden"
      />

      <aside
        ref={drawer}
        id="dashboard-navigation"
        data-open={menuOpen}
        className="drawer fixed inset-y-0 left-0 z-40 flex w-61 flex-col overflow-y-auto border-r border-border bg-surface-2 md:sticky md:top-0 md:z-auto md:h-screen"
      >
        <div className="hidden px-4 pt-6 md:block">
          <Wordmark className="text-accent" height={21} />
        </div>

        <WorkspaceSwitcher
          role={role}
          workspaceRole={workspaceRole}
          workspaceName={workspaceName}
          onNavigate={close}
        />

        <PaletteTrigger returnTo={() => (menuOpen ? menuButton.current : null)} />

        <nav aria-label={t("nav.primary")} className="space-y-px px-3 pb-4">
          <GroupHeading>{t("nav.groupPalace")}</GroupHeading>
          {inGroup("palace").map(numbered)}
          <GroupHeading>{t("nav.groupKeepers")}</GroupHeading>
          {inGroup("keepers").map(numbered)}
          {role === "admin" && inGroup("admin").map(numbered)}
          {isSuperadmin && (
            <>
              <GroupHeading>{t("nav.groupInstallation")}</GroupHeading>
              {inGroup("installation").map((r, i) => link(r, GREEK[i] ?? ""))}
            </>
          )}
        </nav>

        {/* Who is reading, and the way out. */}
        <div className="mt-auto space-y-1 border-t border-border px-3 py-3">
          <Link
            href="/account"
            onClick={close}
            aria-current={accountActive ? "page" : undefined}
            className={cn(
              "group flex items-center gap-3 px-2 py-2 transition-colors",
              accountActive ? "bg-surface shadow-sm ring-1 ring-border-soft" : "hover:bg-surface/60"
            )}
          >
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center bg-text font-display text-ui text-surface"
            >
              {(email ?? t("nav.account")).charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              {email && (
                <span className="block truncate text-ui-sm text-text" title={email}>
                  {email}
                </span>
              )}
              <span
                className={cn(
                  "block text-ui-xs",
                  accountActive ? "text-accent" : "text-text-muted group-hover:text-text"
                )}
              >
                {t("nav.account")}
              </span>
            </span>
          </Link>
          <button
            type="button"
            onClick={logout}
            disabled={signingOut}
            className="flex w-full items-center gap-3 px-2 py-2 text-left text-ui-sm text-text-muted transition-colors hover:bg-surface/60 hover:text-red disabled:opacity-50"
          >
            <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center">
              ⎋
            </span>
            {signingOut ? t("nav.signingOut") : t("common.signOut")}
          </button>
          {signOutFailed && (
            <p role="alert" className="px-2 py-1 text-ui-sm text-red">
              {t("nav.signOutFailed")}
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
