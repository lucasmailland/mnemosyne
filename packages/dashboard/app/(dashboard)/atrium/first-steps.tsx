"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { CopyFailed, ghostButton, useCopy } from "@/components/form-bits";
import { useT } from "@/lib/i18n/client";
import { loadSignal } from "@/lib/load";

/** The first read after this long, then each wait 1.5 times the last, up to MAX_POLL_MS. */
export const FIRST_POLL_MS = 5_000;
const MAX_POLL_MS = 60_000;

/** The server's address on the machine that runs it (the MCP guide's default). */
const SERVER_URL = "http://localhost:3939";
/** `mnemo install` rejects a bare --capture: it needs a host (cli/src/install-args.ts, APP-042). */
const CLI_COMMAND = "mnemo install --capture claude-code";

const mcpCommand = (key: string) =>
  `claude mcp add --scope user mnemosyne -e MNEMO_URL=${SERVER_URL} -e MNEMO_KEY=${key} -- npx -y @mnemo-ai/mcp`;

/**
 * An empty workspace's first steps (APP-040, 5.2): get a key, connect an agent (the MCP server or
 * the CLI, each copyable), then wait for the first memory. The last step polls the stats read with
 * backoff and turns done, once, when a live fact appears; then the page refreshes into Home.
 */
export function FirstSteps({ canCreateKey }: { canCreateKey: boolean }) {
  const t = useT();
  const placeholder = t("home.first.keyPlaceholder");
  const mcp = mcpCommand(placeholder);
  return (
    <section
      aria-labelledby="first-steps-title"
      data-testid="first-steps"
      className="border-border bg-surface border p-4 sm:p-6"
    >
      <h2 id="first-steps-title" className="text-text text-ui-lg font-semibold">
        {t("home.first.title")}
      </h2>
      <ol className="mt-4 space-y-6">
        <Step n={1} title={t("home.first.createKey")}>
          {canCreateKey ? (
            <>
              <p>{t("home.first.keyBody")}</p>
              <Link href="/admin/keys?create=1" className={`${ghostButton} mt-2`}>
                {t("home.first.createKey")}
              </Link>
            </>
          ) : (
            <p>{t("home.first.keyNoScope")}</p>
          )}
        </Step>
        <Step n={2} title={t("home.first.connect")}>
          <p>{t("home.first.mcpLead")}</p>
          <Command text={mcp} copyLabel={t("home.first.copyMcp")} />
          <p className="mt-3">{t("home.first.cliLead")}</p>
          <Command text={CLI_COMMAND} copyLabel={t("home.first.copyCli")} />
          <p className="text-ui-xs mt-2">{t("home.first.connectNote", { placeholder })}</p>
        </Step>
        <Step n={3} title={t("home.first.wait")}>
          <FirstMemoryWait />
        </Step>
      </ol>
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span aria-hidden="true" className="font-display text-display-6 text-accent w-6 shrink-0">
        {n}
      </span>
      <div className="text-text-muted text-ui min-w-0 flex-1 leading-relaxed">
        <h3 className="text-text text-ui font-semibold">{title}</h3>
        <div className="mt-1">{children}</div>
      </div>
    </li>
  );
}

function Command({ text, copyLabel }: { text: string; copyLabel: string }) {
  const t = useT();
  const { copied, failed, copy } = useCopy();
  return (
    <div className="mt-2">
      <div className="border-border bg-surface-2 flex items-start gap-2 border px-3 py-2">
        <code className="text-text min-w-0 flex-1 font-mono text-mono break-all">{text}</code>
        <button
          type="button"
          onClick={() => copy(text)}
          aria-label={copyLabel}
          className={`${ghostButton} shrink-0`}
        >
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <CopyFailed show={failed} />
    </div>
  );
}

function FirstMemoryWait() {
  const t = useT();
  const router = useRouter();
  // The router's identity is not stable in every host (tests): the poll must not restart with it.
  const routerRef = useRef(router);
  routerRef.current = router;
  const [arrived, setArrived] = useState(false);

  useEffect(() => {
    let stopped = false;
    let delay = FIRST_POLL_MS;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch("/dashboard/api/admin/stats", {
          cache: "no-store",
          signal: loadSignal(),
        });
        const body = res.ok ? ((await res.json()) as { facts?: { live?: unknown } }) : null;
        const live = body?.facts?.live;
        if (!stopped && typeof live === "number" && live > 0) {
          setArrived(true);
          routerRef.current.refresh();
          return;
        }
      } catch {
        // A failed read is not an answer: keep waiting.
      }
      if (stopped) return;
      delay = Math.min(delay * 1.5, MAX_POLL_MS);
      timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  return (
    <>
      <p role="status" className={arrived ? "text-green font-medium" : "text-text"}>
        {arrived ? t("home.first.arrived") : t("home.first.waiting")}
      </p>
      <p className="text-ui-xs mt-1">{t("home.first.waitNote")}</p>
    </>
  );
}
