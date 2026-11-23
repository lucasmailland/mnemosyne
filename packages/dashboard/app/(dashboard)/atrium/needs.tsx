"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";

interface NeedsApi {
  /** True while the page refreshes after a resolution. */
  refreshing: boolean;
  /** Refreshes the page; once the refresh lands, `message` is announced and focus moves to the heading. */
  resolved: (message: string) => void;
}

const NeedsContext = createContext<NeedsApi | null>(null);

export function useNeeds(): NeedsApi {
  const api = useContext(NeedsContext);
  if (!api) throw new Error("useNeeds needs a <Needs> around it");
  return api;
}

/**
 * "One thing needs you": the heading, a polite status region and the card under it. It owns the
 * refresh after a resolution, because the conflict card it refreshes may be gone once it lands
 * (WCAG 4.1.3 and 2.4.3: the outcome is said, and focus lands on the heading, not on <body>).
 */
export function Needs({ title, children }: { title: string; children: ReactNode }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [said, setSaid] = useState("");
  const pending = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (refreshing || pending.current === null) return;
    setSaid(pending.current);
    pending.current = null;
    heading.current?.focus();
  }, [refreshing]);

  const resolved = useCallback(
    (message: string) => {
      pending.current = message;
      setSaid("");
      startRefresh(() => router.refresh());
    },
    [router]
  );

  return (
    <NeedsContext.Provider value={{ refreshing, resolved }}>
      <h2
        ref={heading}
        id="atrium-needs"
        tabIndex={-1}
        className="text-text text-ui border-border-soft border-b pb-2 font-semibold"
      >
        {title}
      </h2>
      <p role="status" className="sr-only">
        {said}
      </p>
      {children}
    </NeedsContext.Provider>
  );
}
