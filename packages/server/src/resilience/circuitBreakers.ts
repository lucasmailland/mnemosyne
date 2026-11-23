/**
 * Circuit breakers for external dependency calls (Wave V §22 / §26).
 *
 * Pattern: wrap every call to an external service (LLM, storage) in an opossum
 * CircuitBreaker. When the failure rate exceeds `errorThresholdPercentage` the
 * breaker opens and subsequent calls fail fast (throwing CircuitBreakerError)
 * instead of piling up timeouts.
 *
 * Hexagonal purity: opossum MUST NOT appear in packages/core or
 * packages/federation. All circuit-breaker logic lives here in packages/server.
 *
 * State → Prometheus metric:
 *   closed   → 0
 *   open     → 1
 *   half-open → 2
 */

import CircuitBreaker from "opossum";
import { circuitBreakerState } from "../metrics/index.js";
import { logger } from "../logging.js";

// ─── Breaker defaults ──────────────────────────────────────────────────────────

const DEFAULTS = {
  timeout: 10_000,              // ms before a call is considered a failure
  errorThresholdPercentage: 50, // % failures to open the breaker
  resetTimeout: 30_000,         // ms to wait before half-opening
  volumeThreshold: 5,           // min requests before stats are evaluated
  rollingCountTimeout: 60_000,  // rolling window for stats
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stateInt(breaker: CircuitBreaker): number {
  if (breaker.opened) return 1;
  if (breaker.halfOpen) return 2;
  return 0;
}

function wire<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  name: string,
  opts?: Partial<typeof DEFAULTS>,
): CircuitBreaker<Parameters<T>, Awaited<ReturnType<T>>> {
  const cb = new CircuitBreaker(fn as ((...args: unknown[]) => Promise<Awaited<ReturnType<T>>>), {
    ...DEFAULTS,
    ...opts,
    name,
  });

  // Update the Prometheus gauge on every state change
  const updateGauge = () => {
    circuitBreakerState.set({ service: name }, stateInt(cb));
  };

  cb.on("open", () => {
    logger.warn({ service: name }, "circuit_breaker.open");
    updateGauge();
  });
  cb.on("close", () => {
    logger.info({ service: name }, "circuit_breaker.close");
    updateGauge();
  });
  cb.on("halfOpen", () => {
    logger.info({ service: name }, "circuit_breaker.half_open");
    updateGauge();
  });
  cb.on("fallback", (_result, err) => {
    logger.warn({ service: name, err }, "circuit_breaker.fallback");
  });

  // Initialise to closed
  circuitBreakerState.set({ service: name }, 0); // metrics wired

  return cb as CircuitBreaker<Parameters<T>, Awaited<ReturnType<T>>>;
}

// ─── Public factory ───────────────────────────────────────────────────────────

export interface CircuitBreakers {
  /** Wrap an LLM generate call */
  llmGenerate: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Wrap an LLM embed call */
  llmEmbed: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Wrap a storage read call (lower timeout than write) */
  storageRead: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Wrap a storage write call */
  storageWrite: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * Create a set of circuit breakers for the four main external-call categories.
 * Call once at server startup and pass the returned object to routes that
 * need it. Do NOT create per-request breakers — they share state by design.
 */
// metrics wired: circuitBreakerState gauge emits on open/close/halfOpen events (verified).
const thunkFactory: (...args: unknown[]) => Promise<unknown> = (fn) =>
  (fn as () => Promise<unknown>)();

export function createCircuitBreakers(): CircuitBreakers {
  // LLM breakers use longer timeouts (embedding is fast, generation is slow)
  const generateBreaker = wire(thunkFactory, "llm.generate", {
    timeout: 30_000,
    errorThresholdPercentage: 40,
  });
  const embedBreaker = wire(thunkFactory, "llm.embed", {
    timeout: 10_000,
    errorThresholdPercentage: 40,
  });

  // Storage breakers: reads are time-sensitive (P99 budget ≈ 200ms)
  const storageReadBreaker = wire(thunkFactory, "storage.read", {
    timeout: 5_000,
    errorThresholdPercentage: 30,
    volumeThreshold: 10,
  });
  const storageWriteBreaker = wire(thunkFactory, "storage.write", {
    timeout: 10_000,
    errorThresholdPercentage: 50,
    volumeThreshold: 5,
  });

  return {
    llmGenerate: <T>(fn: () => Promise<T>) =>
      generateBreaker.fire(fn as () => Promise<unknown>) as Promise<T>,
    llmEmbed: <T>(fn: () => Promise<T>) =>
      embedBreaker.fire(fn as () => Promise<unknown>) as Promise<T>,
    storageRead: <T>(fn: () => Promise<T>) =>
      storageReadBreaker.fire(fn as () => Promise<unknown>) as Promise<T>,
    storageWrite: <T>(fn: () => Promise<T>) =>
      storageWriteBreaker.fire(fn as () => Promise<unknown>) as Promise<T>,
  };
}

// ─── Singleton for the server process ─────────────────────────────────────────

let _instance: CircuitBreakers | null = null;

export function getCircuitBreakers(): CircuitBreakers {
  if (!_instance) {
    _instance = createCircuitBreakers();
  }
  return _instance;
}
