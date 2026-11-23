"use client";

import { useEffect, useState } from "react";

import { loadSignal } from "@/lib/load";

export const MIN_CHARS = 2;
const DEBOUNCE_MS = 200;
const PER_GROUP = 5;

export interface Found {
  id: string;
  label: string;
}
export interface Group {
  status: "idle" | "loading" | "ok" | "error";
  items: Found[];
}
export interface Search {
  facts: Group;
  entities: Group;
}

const IDLE: Search = {
  facts: { status: "idle", items: [] },
  entities: { status: "idle", items: [] },
};
const LOADING: Search = {
  facts: { status: "loading", items: [] },
  entities: { status: "loading", items: [] },
};

/** Reads `{ items: [{ id, <field> }] }`; anything else is null (the group shows its error). */
function parse(body: unknown, field: "statement" | "name"): Found[] | null {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  const out: Found[] = [];
  for (const item of items.slice(0, PER_GROUP)) {
    const r = item as Record<string, unknown> | null;
    if (typeof r?.id !== "string" || typeof r[field] !== "string") return null;
    out.push({ id: r.id, label: r[field] as string });
  }
  return out;
}

async function load(url: string, field: "statement" | "name", signal: AbortSignal): Promise<Group> {
  try {
    const res = await fetch(url, { signal: loadSignal(signal) });
    const items = res.ok ? parse(await res.json(), field) : null;
    return items ? { status: "ok", items } : { status: "error", items: [] };
  } catch {
    return { status: "error", items: [] };
  }
}

/**
 * Facts and entities for the palette: 200 ms after the last keystroke, from 2 characters,
 * one request per group, older ones aborted. It never calls recall.
 */
export function usePaletteSearch(text: string): Search {
  const [state, setState] = useState<{ for: string; search: Search }>({ for: "", search: IDLE });
  const q = text.trim().slice(0, 200);
  const active = q.length >= MIN_CHARS;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const { signal } = controller;
    const timer = setTimeout(() => {
      setState({ for: q, search: LOADING });
      const enc = encodeURIComponent(q);
      void load(`/dashboard/api/facts?q=${enc}&limit=${PER_GROUP}`, "statement", signal).then(
        (facts) => !signal.aborted && setState((s) => ({ for: q, search: { ...s.search, facts } }))
      );
      void load(`/dashboard/api/entities?q=${enc}&limit=${PER_GROUP}`, "name", signal).then(
        (entities) =>
          !signal.aborted && setState((s) => ({ for: q, search: { ...s.search, entities } }))
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, q]);

  // Results for an older text are not shown (and nothing shows below the minimum).
  return active && state.for === q ? state.search : IDLE;
}
