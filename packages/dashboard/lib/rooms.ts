import type { BrandIconId, BrandImageId } from "@/lib/brand/images";
import type { MessageKey } from "@/lib/i18n/core";

export type RoomId =
  | "home"
  | "browser"
  | "recall"
  | "sessions"
  | "graph"
  | "config"
  | "workspaces"
  | "members"
  | "keys"
  | "health"
  | "audit"
  | "account"
  | "installation-users"
  | "installation-workspaces"
  | "installation-settings"
  | "installation-audit";

export interface Room {
  id: RoomId;
  href: string;
  /** Matches only `href` itself, not the pages below it. */
  exact?: boolean;
  numeral?: string;
  /** Draws its own full scene and its own h1: the layout renders no room header for it. */
  scene?: boolean;
  group: "palace" | "keepers" | "admin" | "installation" | "account";
  icon: BrandIconId;
  image: BrandImageId;
  nav: MessageKey;
  title: MessageKey;
  subtitle: MessageKey;
}

export const ROOMS: readonly Room[] = [
  {
    id: "home",
    href: "/",
    exact: true,
    scene: true,
    numeral: "I",
    group: "palace",
    icon: "store",
    image: "pano-palace",
    nav: "nav.home",
    title: "rooms.home.title",
    subtitle: "rooms.home.subtitle",
  },
  {
    id: "browser",
    href: "/browser",
    numeral: "II",
    group: "palace",
    icon: "search",
    image: "obj-card-catalog",
    nav: "nav.browser",
    title: "rooms.browser.title",
    subtitle: "rooms.browser.subtitle",
  },
  {
    id: "recall",
    href: "/recall",
    numeral: "III",
    group: "palace",
    icon: "recall",
    image: "pano-water",
    nav: "nav.recall",
    title: "rooms.recall.title",
    subtitle: "rooms.recall.subtitle",
  },
  {
    id: "sessions",
    href: "/sessions",
    numeral: "IV",
    group: "palace",
    icon: "session",
    image: "obj-columbarium",
    nav: "nav.sessions",
    title: "rooms.sessions.title",
    subtitle: "rooms.sessions.subtitle",
  },
  {
    id: "graph",
    href: "/relations",
    scene: true,
    numeral: "V",
    group: "palace",
    icon: "embed",
    image: "constellation",
    nav: "nav.graph",
    title: "rooms.graph.title",
    subtitle: "rooms.graph.subtitle",
  },
  {
    id: "config",
    href: "/config",
    numeral: "VI",
    group: "keepers",
    icon: "persist",
    image: "obj-astrolabe",
    nav: "nav.config",
    title: "rooms.config.title",
    subtitle: "rooms.config.subtitle",
  },
  {
    id: "workspaces",
    href: "/workspaces",
    numeral: "VII",
    group: "keepers",
    icon: "store",
    image: "plan-floor",
    nav: "nav.workspaces",
    title: "rooms.workspaces.title",
    subtitle: "rooms.workspaces.subtitle",
  },
  {
    id: "members",
    href: "/admin/members",
    numeral: "VIII",
    group: "admin",
    icon: "remember",
    image: "frieze",
    nav: "nav.members",
    title: "rooms.members.title",
    subtitle: "rooms.members.subtitle",
  },
  {
    id: "keys",
    href: "/admin/keys",
    numeral: "IX",
    group: "admin",
    icon: "forget",
    image: "seal",
    nav: "nav.keys",
    title: "rooms.keys.title",
    subtitle: "rooms.keys.subtitle",
  },
  {
    id: "health",
    href: "/admin/health",
    numeral: "X",
    group: "admin",
    icon: "persist",
    image: "obj-herbarium",
    nav: "nav.health",
    title: "rooms.health.title",
    subtitle: "rooms.health.subtitle",
  },
  {
    id: "audit",
    href: "/admin/audit",
    numeral: "XI",
    group: "admin",
    icon: "embed",
    image: "obj-quipu",
    nav: "nav.audit",
    title: "rooms.audit.title",
    subtitle: "rooms.audit.subtitle",
  },
  {
    id: "account",
    href: "/account",
    group: "account",
    icon: "remember",
    image: "bust-frieze",
    nav: "nav.account",
    title: "rooms.account.title",
    subtitle: "rooms.account.subtitle",
  },
  {
    id: "installation-users",
    href: "/installation/users",
    group: "installation",
    icon: "remember",
    image: "plan-section",
    nav: "nav.installationUsers",
    title: "rooms.installationUsers.title",
    subtitle: "rooms.installationUsers.subtitle",
  },
  {
    id: "installation-workspaces",
    href: "/installation/workspaces",
    group: "installation",
    icon: "store",
    image: "plan-elevation",
    nav: "nav.installationWorkspaces",
    title: "rooms.installationWorkspaces.title",
    subtitle: "rooms.installationWorkspaces.subtitle",
  },
  {
    id: "installation-settings",
    href: "/installation/settings",
    group: "installation",
    icon: "persist",
    image: "plan-axon",
    nav: "nav.installationSettings",
    title: "rooms.installationSettings.title",
    subtitle: "rooms.installationSettings.subtitle",
  },
  {
    id: "installation-audit",
    href: "/installation/audit",
    group: "installation",
    icon: "embed",
    image: "meander",
    nav: "nav.installationAudit",
    title: "rooms.installationAudit.title",
    subtitle: "rooms.installationAudit.subtitle",
  },
];

/** The room whose `href` is the longest match for `pathname` (equal, or a parent segment). */
export function roomForPath(pathname: string): Room | null {
  let best: Room | null = null;
  for (const room of ROOMS) {
    const hit = pathname === room.href || (!room.exact && pathname.startsWith(room.href + "/"));
    if (hit && (!best || room.href.length > best.href.length)) best = room;
  }
  return best;
}
