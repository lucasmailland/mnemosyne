import { describe, it, expect } from "vitest";
import { injectTraceContext } from "../../telemetry/otel.js";

describe("injectTraceContext", () => {
  it("is a function that returns the headers object (no-op safe when no active span)", () => {
    const h = injectTraceContext({ "content-type": "application/json" });
    expect(h).toBeTypeOf("object");
    expect(h["content-type"]).toBe("application/json");
  });
});
