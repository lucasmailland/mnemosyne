"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { useT } from "@/lib/i18n/client";
import {
  ACTIONS,
  armRecall,
  RUN_RECALL,
  matches,
  visibleRooms,
  type PaletteItem,
} from "@/lib/palette-items";
import { shortId } from "@/lib/short-id";
import { cn } from "@/lib/utils";

import { isApple, OPEN_PALETTE, PALETTE_NAVIGATE, useModKey } from "./palette-trigger";
import { MIN_CHARS, usePaletteSearch, type Group } from "./use-palette-search";

/**
 * The ⌘K palette: a top-anchored dialog with a combobox over a grouped listbox. It is not
 * in the DOM while closed. Typing only filters rooms/actions and searches facts/entities;
 * recall runs only from ⌘↵ (Ctrl+↵ off Apple platforms): elsewhere it arms a one-shot token and
 * opens /recall?q=…&run=1 (Recall runs once because the token matches; the link alone only
 * prefills); on /recall it dispatches mnemo:recall-run and the page runs once, with no navigation.
 */
export function Palette({
  role,
  isSuperadmin,
  personal = false,
}: {
  role: string;
  isSuperadmin: boolean;
  /** A personal workspace: no "Invite a member". */
  personal?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const opener = useRef<HTMLElement | null>(null);

  const show = useCallback((from?: HTMLElement | null) => {
    // Another modal dialog (a confirmation) owns the page: no palette over it.
    if (document.querySelector("dialog[open]")) return;
    opener.current = from ?? (document.activeElement as HTMLElement | null);
    openRef.current = true;
    setOpen(true);
  }, []);
  const hide = useCallback(() => {
    openRef.current = false;
    setOpen(false);
  }, []);

  // Focus goes back to whatever opened the palette only once the modal dialog is gone:
  // while it is open the opener is inert and focus() would do nothing.
  useEffect(() => {
    if (open) return;
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected) back.focus();
  }, [open]);

  useEffect(() => {
    // ⌘K on Apple platforms, Ctrl+K elsewhere (Ctrl+K is a text-editing key on macOS), read
    // by the physical key so any keyboard layout works.
    const onKey = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.repeat ||
        event.shiftKey ||
        event.altKey ||
        event.code !== "KeyK" ||
        !(isApple() ? event.metaKey : event.ctrlKey)
      )
        return;
      event.preventDefault();
      if (openRef.current) hide();
      else show();
    };
    const onOpen = (event: Event) => show((event as CustomEvent<HTMLElement | null>).detail);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE, onOpen);
    };
  }, [show, hide]);

  return open ? (
    <PaletteDialog role={role} isSuperadmin={isSuperadmin} personal={personal} onClose={hide} />
  ) : null;
}

function PaletteDialog({
  role,
  isSuperadmin,
  personal,
  onClose,
}: {
  role: string;
  isSuperadmin: boolean;
  personal: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const mod = useModKey();
  const base = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const search = usePaletteSearch(text);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    }
  }, []);

  const close = useCallback(() => {
    const d = dialog.current;
    if (d?.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
    onClose();
  }, [onClose]);

  // While open the page behind does not scroll, and browser Back closes the palette.
  useEffect(() => {
    const body = document.body;
    const previous = body.style.overflow;
    body.style.overflow = "hidden";
    window.addEventListener("popstate", close);
    return () => {
      body.style.overflow = previous;
      window.removeEventListener("popstate", close);
    };
  }, [close]);

  const optionId = (item: PaletteItem) => `${base}-${item.group}-${encodeURIComponent(item.id)}`;
  const q = text.trim();
  const rooms: PaletteItem[] = visibleRooms(role, isSuperadmin)
    .map((r) => ({
      id: r.id,
      group: "rooms" as const,
      label: t(r.nav),
      kind: t("palette.kindRoom"),
      href: r.href,
      // Also found by its title ("The waters of Lethe").
      title: t(r.title),
    }))
    .filter((i) => matches([i.label, i.title], q));
  const actions: PaletteItem[] = ACTIONS.filter(
    (a) => (!a.admin || role === "admin") && !(a.team && personal)
  )
    .map((a) => ({
      id: a.id,
      group: "actions" as const,
      label: t(a.label),
      kind: t("palette.kindAction"),
      href: a.href,
    }))
    .filter((i) => matches(i.label, q));
  const facts: PaletteItem[] = search.facts.items.map((f) => ({
    id: f.id,
    group: "facts",
    label: f.label,
    kind: t("palette.kindFact"),
    tail: shortId(f.id),
    href: `/browser?open=${encodeURIComponent(f.id)}`,
  }));
  const entities: PaletteItem[] = search.entities.items.map((e) => ({
    id: e.id,
    group: "entities",
    label: e.label,
    kind: t("palette.kindEntity"),
    tail: shortId(e.id),
    // The Browser reads its tab from `type`.
    href: `/browser?type=entities&q=${encodeURIComponent(e.label)}`,
  }));
  const groups: {
    key: PaletteItem["group"];
    title: string;
    items: PaletteItem[];
    state?: Group;
  }[] = [
    { key: "rooms", title: t("palette.groupRooms"), items: rooms },
    { key: "actions", title: t("palette.groupActions"), items: actions },
    { key: "facts", title: t("palette.groupFacts"), items: facts, state: search.facts },
    {
      key: "entities",
      title: t("palette.groupEntities"),
      items: entities,
      state: search.entities,
    },
  ];
  const flat = groups.flatMap((g) => g.items);
  const current = flat.length ? flat[Math.min(active, flat.length - 1)] : undefined;
  const listId = `${base}-list`;
  const activeId = current ? optionId(current) : undefined;

  // The arrows can move past the visible part of the list: keep the active option in view.
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  // Facts and entities settle together once both groups answered (ok or error).
  const settled = (g: Group) => g.status === "ok" || g.status === "error";
  const searching = q.length >= MIN_CHARS && !(settled(search.facts) && settled(search.entities));
  const noMatches = q.length >= MIN_CHARS && !searching && flat.length === 0;
  const announcement = searching
    ? t("palette.searching")
    : q.length >= MIN_CHARS
      ? flat.length === 0
        ? t("palette.empty")
        : t("palette.count", { count: flat.length })
      : "";

  const go = (href: string) => {
    close();
    // Carries the address: a page already open at it (the keys page for "New API key") acts on it.
    window.dispatchEvent(new CustomEvent(PALETTE_NAVIGATE, { detail: href }));
    router.push(href);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!flat.length) return;
      const at = flat.indexOf(current!);
      setActive((at + (event.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      // The same platform rule as ⌘K: ⌘ on Apple platforms, Ctrl elsewhere.
      if (isApple() ? event.metaKey : event.ctrlKey) {
        if (!q) return;
        if (location.pathname.endsWith("/recall")) {
          // The page is already open: whatever its URL reads, a token would never be spent
          // (nothing remounts), so the page is told to run the query once instead.
          close();
          window.dispatchEvent(new CustomEvent(RUN_RECALL, { detail: q }));
          window.dispatchEvent(new CustomEvent(PALETTE_NAVIGATE, { detail: "/recall" }));
        } else {
          armRecall(q);
          go(`/recall?q=${encodeURIComponent(q)}&run=1`);
        }
      } else if (current) go(current.href);
    }
  };

  return (
    <dialog
      ref={dialog}
      // showModal() makes it modal; older screen readers only learn that from the attribute.
      aria-modal="true"
      aria-label={t("palette.title")}
      onKeyDown={onKeyDown}
      // Escape: the browser's own cancel event.
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => event.target === event.currentTarget && close()}
      className="modal mx-auto mb-auto mt-16 w-11/12 max-w-xl overflow-hidden border border-border bg-base p-0 text-text backdrop:bg-black/60"
    >
      <input
        autoFocus
        role="combobox"
        aria-expanded={flat.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-label={t("palette.title")}
        placeholder={t("palette.placeholder")}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
        }}
        className="min-h-12 w-full border-b border-border bg-surface px-4 text-ui text-text placeholder:text-text-faint focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      />
      <div
        id={listId}
        role="listbox"
        aria-label={t("palette.title")}
        // scroll-py-2: an option scrolled into view clears the input's edge, as at the top.
        className="max-h-96 scroll-py-2 overflow-y-auto py-2"
      >
        {groups
          .filter((g) => g.items.length > 0 || g.state?.status === "error")
          .map((g) => (
            <div key={g.key} role="group" aria-label={g.title}>
              <div aria-hidden="true" className="eyebrow px-4 pb-1 pt-2">
                {g.title}
              </div>
              {g.items.map((item) => (
                <div
                  key={item.id}
                  id={optionId(item)}
                  role="option"
                  aria-selected={item === current}
                  onMouseMove={() => setActive(flat.indexOf(item))}
                  onClick={() => go(item.href)}
                  // Marked like the sidebar's current room: an accent rule (3:1 or more), not only a fill.
                  className={cn(
                    "flex cursor-pointer items-baseline gap-3 border-l-2 px-4 py-2 text-ui",
                    item === current ? "border-accent bg-surface-2 text-text" : "border-transparent"
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <span className="text-ui-xs text-text-muted">{item.kind}</span>
                  {item.tail && (
                    <span className="font-mono text-mono-xs text-text-faint">{item.tail}</span>
                  )}
                </div>
              ))}
              {g.state?.status === "error" && (
                <p className="px-4 py-2 text-ui-sm text-text-muted">{t("palette.error")}</p>
              )}
            </div>
          ))}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {(searching || noMatches) && (
        <p aria-hidden="true" className="px-4 pb-3 text-ui-sm text-text-muted">
          {searching ? t("palette.searching") : t("palette.empty")}
        </p>
      )}
      <p className="border-t border-border-soft px-4 py-2 text-ui-xs text-text-muted">
        {t("palette.hint", { key: mod === "⌘" ? "⌘↵" : "Ctrl+↵" })}
      </p>
    </dialog>
  );
}
