import { propagation, context, defaultTextMapSetter } from "@opentelemetry/api";
import type { Telemetry, Span, SpanOpts } from "@mnemo-ai/types";

/**
 * Injects the active W3C trace context (traceparent / tracestate) into an outbound
 * headers object. Safe to call when no span is active — the propagator is a no-op in
 * that case and the original headers are returned unchanged.
 */
export function injectTraceContext(headers: Record<string, string>): Record<string, string> {
  propagation.inject(context.active(), headers, defaultTextMapSetter);
  return headers;
}

/**
 * Boots the NodeSDK with OTLP/HTTP trace export + auto-instrumentation (http, pg, ioredis).
 * Returns a Telemetry implementation when OTEL_EXPORTER_OTLP_ENDPOINT is set, or null
 * (caller falls back to the no-op shim) when the env var is absent.
 *
 * shutdown() flushes the exporter — must be called during graceful shutdown.
 */
export async function createOtelTelemetry(opts: {
  serviceName: string;
  serviceVersion: string;
}): Promise<Telemetry | null> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return null;

  let NodeSDK: typeof import("@opentelemetry/sdk-node").NodeSDK;
  let getNodeAutoInstrumentations: typeof import("@opentelemetry/auto-instrumentations-node").getNodeAutoInstrumentations;
  let OTLPTraceExporter: typeof import("@opentelemetry/exporter-trace-otlp-http").OTLPTraceExporter;
  let ATTR_SERVICE_NAME: string;
  let ATTR_SERVICE_VERSION: string;
  let otelApi: typeof import("@opentelemetry/api");
  let SpanStatusCode: typeof import("@opentelemetry/api").SpanStatusCode;
  let resourceModule: any;

  try {
    ({ NodeSDK } = await import("@opentelemetry/sdk-node"));
    ({ getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node"));
    ({ OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http"));
    resourceModule = await import("@opentelemetry/resources");
    ({ ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } =
      await import("@opentelemetry/semantic-conventions"));
    otelApi = await import("@opentelemetry/api");
    ({ SpanStatusCode } = otelApi);
  } catch {
    // OTel packages not installed — degrade to null, caller uses no-op.
    return null;
  }

  // Support both v1 (Resource class) and v2 (resourceFromAttributes function)
  const attributes = {
    [ATTR_SERVICE_NAME]: opts.serviceName,
    [ATTR_SERVICE_VERSION]: opts.serviceVersion,
  };
  const resource = resourceModule.resourceFromAttributes
    ? resourceModule.resourceFromAttributes(attributes) // v2 API
    : new resourceModule.Resource(attributes); // v1 API

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();

  const tracer = otelApi.trace.getTracer(opts.serviceName, opts.serviceVersion);

  function wrapSpan(otelSpan: ReturnType<typeof tracer.startSpan>): Span {
    return {
      setAttribute: (k, v) => {
        otelSpan.setAttribute(k, v);
      },
      setStatus: (status, message) =>
        otelSpan.setStatus({
          code: status === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
          message,
        }),
      end: () => otelSpan.end(),
    };
  }

  return {
    startSpan: (name: string, spanOpts?: SpanOpts): Span => {
      const otelSpan = tracer.startSpan(
        name,
        { attributes: spanOpts?.attributes },
        otelApi.context.active()
      );
      return wrapSpan(otelSpan);
    },
    // Metrics flow through the Prometheus registry (metrics/index.ts), not OTel meters.
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {
      await sdk.shutdown();
    },
  };
}
