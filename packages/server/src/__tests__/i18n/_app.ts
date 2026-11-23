/** createApp with one throwing route per error class, for the localization tests. */
import bcrypt from "bcrypt";
import { Hono } from "hono";
import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  HttpError,
  InternalServerError,
  NotFoundError,
  NotImplementedError,
  RateLimitedError,
  ServiceUnavailableError,
  UnauthorizedError,
  UnprocessableEntityError,
} from "../../errors.js";
import { StorageConflictError } from "@mnemo-ai/types";

export const KEY = "mns_live_i18ntestkey0000000000001";
const WS_ID = "00000000-0000-0000-0000-000000000042";
export const DASH_SECRET = "i18n-test-dashboard-secret-0123456789abcdef";

/** One throw per class; the value builds the error with its default message. */
export const THROWERS: Record<string, () => Error> = {
  bad: () => new BadRequestError(undefined, { field: "x" }, "x"),
  unauthorized: () => new UnauthorizedError(),
  forbidden: () => new ForbiddenError(),
  notfound: () => new NotFoundError(),
  conflict: () => new ConflictError(),
  ratelimited: () => new RateLimitedError(),
  unprocessable: () => new UnprocessableEntityError(),
  unavailable: () => new ServiceUnavailableError(),
  internal: () => new InternalServerError(),
  notimpl: () => new NotImplementedError(),
  custom: () => new HttpError(400, "custom", "A message nobody translated"),
  storage: () => new StorageConflictError("Entity e-1 is already closed"),
  breaker: () => Object.assign(new Error("x"), { code: "EOPENBREAKER" }),
};

export async function buildApp(): Promise<Hono> {
  process.env.MNEMO_DASHBOARD_SECRET = DASH_SECRET;
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps = {
    apiKeys: {
      listActive: async () => [
        { id: "key-i18n", keyHash, workspaceId: WS_ID, scopes: ["memory:read", "memory:write"] },
      ],
      findByLookupHash: undefined,
      setLookupHash: undefined,
      touch: async () => {},
    } as unknown as ApiKeyLookup,
    rateLimitBackend: {
      healthy: true,
      consumeToken: async () => ({ allowed: true, remaining: 99, resetSeconds: 60 }),
      acquireSlot: async () => ({ acquired: true, inFlight: 1 }),
      releaseSlot: async () => {},
    },
    llm: undefined,
    embedModel: "text-embedding-3-small",
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  } as unknown as ServerDeps;
  const app = createApp({ deps, version: "0.0.0-test" });
  for (const [name, make] of Object.entries(THROWERS))
    app.get(`/__t/${name}`, () => {
      throw make();
    });
  app.get("/__t/text", (c) => c.text("plain failure", 500));
  app.get("/__t/okjson", (c) => c.json({ error: { message: "Not found" } }, 200));
  return app;
}

export const authed = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
export const reqId = { "x-request-id": "req-i18n-1" };
