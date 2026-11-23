import { describe, it, expect, afterEach } from "vitest";
import { createOtelTelemetry } from "../../telemetry/otel.js";

describe("createOtelTelemetry", () => {
  afterEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  it("returns null when OTEL endpoint is not set", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const t = await createOtelTelemetry({ serviceName: "test", serviceVersion: "0.0.0" });
    expect(t).toBeNull();
  });

  it("returns a Telemetry object with the right shape when endpoint is set", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    const t = await createOtelTelemetry({ serviceName: "test", serviceVersion: "0.0.0" });
    if (t === null) {
      // OTel packages not installed in CI — skip
      return;
    }
    const span = t.startSpan("test-span");
    expect(typeof span.setAttribute).toBe("function");
    expect(typeof span.setStatus).toBe("function");
    expect(typeof span.end).toBe("function");
    span.setAttribute("k", 1);
    span.setStatus("ok");
    span.end();
    expect(typeof t.shutdown).toBe("function");
    // shutdown may fail with ECONNREFUSED when no collector is running in test env
    await t.shutdown().catch(() => undefined);
    // Slow by nature: createOtelTelemetry dynamically imports sdk-node and the whole
    // auto-instrumentations bundle, about 9 s alone on a quiet machine. 60 s keeps
    // a loaded pre-push sweep from timing out.
  }, 60_000);
});
