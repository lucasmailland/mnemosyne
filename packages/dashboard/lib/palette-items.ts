import type { MessageKey } from "@/lib/i18n/core";
import { ROOMS, type Room } from "@/lib/rooms";

/** A row in the palette: where it goes and how it reads. Labels are already localized. */
export interface PaletteItem {
  id: string;
  group: "rooms" | "actions" | "facts" | "entities";
  label: string;
  /** The kind tag ("Room", "Fact"…). */
  kind: string;
  /** The short id shown for facts and entities. */
  tail?: string;
  /** A room's title, matched as well as its label. */
  title?: string;
  href: string;
}

interface Action {
  id: string;
  href: string;
  label: MessageKey;
  admin?: boolean;
  /** Only where the workspace takes members (not a personal one, as on the Members page). */
  team?: boolean;
}

export const ACTIONS: readonly Action[] = [
  { id: "new-key", href: "/admin/keys?create=1", label: "palette.actionNewKey", admin: true },
  {
    id: "invite",
    href: "/admin/members#invite",
    label: "palette.actionInvite",
    admin: true,
    team: true,
  },
  { id: "language", href: "/account#preferences", label: "palette.actionLanguage" },
];

/** The rooms the sidebar would show for this session. */
export function visibleRooms(role: string, isSuperadmin: boolean): Room[] {
  return ROOMS.filter(
    (r) =>
      r.group === "palace" ||
      r.group === "keepers" ||
      r.group === "account" ||
      (r.group === "admin" && role === "admin") ||
      (r.group === "installation" && isSuperadmin)
  );
}

/** Lowercase without accents, so "configuracion" finds "Configuración". */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Whether any of the labels (a room's name and its title, say) contains the query. */
export const matches = (labels: string | readonly string[], query: string): boolean => {
  const q = fold(query.trim());
  return [labels].flat().some((label) => fold(label).includes(q));
};

/**
 * ⌘↵ is the only way a recall runs on arrival: the palette arms this one-shot token with the
 * text right before it opens /recall?q=…&run=1, and Recall runs only when the token equals `q`.
 * A hand-built or shared ?run=1 link only prefills (recall is metered).
 */
const RUN_TOKEN = "mnemo:palette-run";
/** ⌘↵ pressed while the recall page is already open: it runs the query itself, no token, no URL. */
export const RUN_RECALL = "mnemo:recall-run";

export function armRecall(q: string): void {
  try {
    sessionStorage.setItem(RUN_TOKEN, q);
  } catch {
    /* no storage: the link only prefills */
  }
}

/** Reads and spends the token; true when the palette armed it for exactly `q`. */
export function takeRecall(q: string): boolean {
  try {
    const armed = sessionStorage.getItem(RUN_TOKEN);
    sessionStorage.removeItem(RUN_TOKEN);
    return armed === q;
  } catch {
    return false;
  }
}
