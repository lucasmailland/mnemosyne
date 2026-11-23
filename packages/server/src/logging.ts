import pino, { type Logger } from "pino";
import { trace } from "@opentelemetry/api";

/**
 * Why a dedicated logging module:
 *
 * The server runs in many shapes (local dev, docker, k8s, lambda-ish).
 * We centralise pino setup here so every route, middleware, and the boot
 * sequence share one configured instance with the same redaction rules
 * and the same `service` field for cross-service log correlation.
 *
 * Production defaults to JSON (one line per event, ingest-friendly).
 * In dev, if pino-pretty is available we make it human-readable, but we
 * don't hard-require it — production images shouldn't ship dev deps.
 */

const isProd = process.env.NODE_ENV === "production";

// Redact common credential fields so we never leak a bearer token into a
// downstream log aggregator. Add to this list defensively. Exported for the
// redaction test.
export const REDACT_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  'req.headers["x-mnemo-key"]',
  'req.headers["x-mnemo-inherited-ctx"]',
  'req.headers["x-mnemo-client-cert"]',
  'headers["authorization"]',
  'headers["x-mnemo-key"]',
  'headers["x-mnemo-inherited-ctx"]',
  'headers["x-mnemo-client-cert"]',
  'headers["cookie"]',
  'headers["set-cookie"]',
  // No log carries these today; they are here so a future one can't
  // leak a credential by naming its field plainly (top level or one deep).
  "password",
  "token",
  "secret",
  "*.password",
  "*.token",
  "*.secret",
  "apiKey",
  "api_key",
  "key_hash",
  "lookup_hash",
];

/**
 * Build the root logger. Exposed as a function (not a const) so tests can
 * spin up isolated loggers with their own destination and level.
 */
export function createLogger(opts?: { level?: string }): Logger {
  return pino({
    name: "mnemosyne-server",
    level: opts?.level ?? process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
    redact: {
      paths: [...REDACT_PATHS],
      remove: true,
    },
    base: {
      service: "mnemosyne-server",
      // Useful for log correlation across replicas in k8s; falls back to
      // a synthetic instance id if HOSTNAME isn't set.
      instance: process.env.HOSTNAME ?? `local-${process.pid}`,
    },
    // §22 log↔trace correlation: stamp the active OTel span's ids on every line
    // so logs join their distributed trace in Tempo/Grafana. Returns {} when no
    // span is active (e.g. boot, crons without a span) — zero overhead otherwise.
    mixin() {
      const span = trace.getActiveSpan();
      if (!span) return {};
      const sc = span.spanContext();
      return sc?.traceId ? { trace_id: sc.traceId, span_id: sc.spanId } : {};
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport:
      !isProd && process.env.PINO_PRETTY === "1"
        ? {
            target: "pino-pretty",
            options: { colorize: true, singleLine: false },
          }
        : undefined,
  });
}

/**
 * Singleton logger — the typical entrypoint. Use `logger.child({ ... })`
 * to add per-request context rather than creating multiple roots.
 */
export const logger: Logger = createLogger();
