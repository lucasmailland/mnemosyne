import type { MessageKey, T } from "./core";

const BY_STATUS: Record<number, MessageKey> = {
  401: "errors.unauthorized",
  403: "errors.forbidden",
  404: "errors.notFound",
  409: "errors.conflict",
  429: "errors.rateLimited",
  503: "errors.unavailable",
};

const BY_CODE: Record<string, MessageKey> = { network: "errors.network" };

/** Known status or code → its message; anything else → generic plus the status or code. */
export function errorMessage(t: T, opts: { status?: number; code?: string }): string {
  const key =
    (opts.status !== undefined && BY_STATUS[opts.status]) ||
    (opts.code && Object.hasOwn(BY_CODE, opts.code) && BY_CODE[opts.code]);
  if (key) return t(key);
  const detail = opts.status ?? (opts.code || undefined);
  return detail === undefined ? t("errors.generic") : `${t("errors.generic")} (${detail})`;
}
