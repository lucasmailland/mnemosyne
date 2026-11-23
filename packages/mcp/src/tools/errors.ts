import { MnemosyneAPIError } from "@mnemo-ai/client-ts";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { t } from "../i18n/index.js";

export interface McpErrorResponse {
  [key: string]: unknown;
  isError: true;
  content: Array<{ type: "text"; text: string }>;
}

/**
 * Format errors caught by MCP tool handlers into structured MCP responses.
 * Preserves status, code, requestId, and retryable info for MnemosyneAPIError instances.
 * APP-023: a write that failed after it may have committed (`outcomeUnknown`,
 * set by client-ts on a mutation's timeout, network error or 5xx) says so.
 */
export function formatMcpError(
  prefix: string,
  err: unknown,
  locale: Locale = DEFAULT_LOCALE
): McpErrorResponse {
  const typed = err && typeof err === "object" ? (err as Record<string, unknown>) : null;
  const uncertain = typed?.outcomeUnknown === true ? ` ${t(locale, "out.outcomeUnknown")}` : "";
  const status = typeof typed?.status === "number" ? typed.status : undefined;
  if (err instanceof MnemosyneAPIError || status !== undefined) {
    const parts = [`status=${status}`];
    if (typed?.code) parts.push(`code=${typed.code}`);
    if (typed?.requestId) parts.push(`requestId=${typed.requestId}`);
    const retryable =
      typeof typed?.retryable === "boolean"
        ? typed.retryable
        : status === 429 || (status !== undefined && status >= 500 && status < 600);
    parts.push(`retryable=${retryable}`);
    const retryAfterSeconds = typed?.retryAfterSeconds ?? typed?.retryAfter;
    if (retryAfterSeconds !== undefined) parts.push(`retryAfterSeconds=${retryAfterSeconds}`);
    const message = err instanceof Error ? err.message : String(err);

    return {
      isError: true,
      content: [
        {
          type: "text",
          text: t(locale, "out.failedDetails", {
            tool: prefix,
            message,
            details: parts.join(", "),
          }) + uncertain,
        },
      ],
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      { type: "text", text: t(locale, "out.failed", { tool: prefix, message }) + uncertain },
    ],
  };
}
