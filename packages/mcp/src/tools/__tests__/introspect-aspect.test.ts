// packages/mcp/src/tools/__tests__/introspect-aspect.test.ts
import { describe, it, expect, vi } from "vitest";
import { registerIntrospect } from "../introspect.js";

// Capture the registered handler + its declared input schema.
function captureTool() {
  let handler: any;
  let schema: any;
  const server = {
    registerTool(_name: string, def: any, fn: any) {
      schema = def.inputSchema;
      handler = fn;
    },
  } as any;
  const getSelfModel = vi.fn(async () => ({ ok: true }));
  const client = { getSelfModel } as any;
  registerIntrospect(server, client);
  return { handler, schema, getSelfModel };
}

describe("memory_introspect aspect acceptance (F22)", () => {
  it("accepts the §29 aspects without throwing (zod enum parse)", () => {
    const { schema } = captureTool();
    // The aspect schema must parse every §29 + §31 value.
    for (const a of [
      "health",
      "worth",
      "drift",
      "types",
      "recent_changes",
      "coverage",
      "trends",
      "gaps",
      "strengths",
      "all",
    ]) {
      expect(() => schema.aspect.parse(a)).not.toThrow();
    }
  });

  it("maps §29 aspect 'health' onto a §31 backend aspect for getSelfModel", async () => {
    const { handler, getSelfModel } = captureTool();
    await handler({ aspect: "health", limit: 10 });
    expect(getSelfModel).toHaveBeenCalledTimes(1);
    const passed = (getSelfModel.mock.calls[0] as unknown as [{ aspect: string }])[0].aspect;
    // 'health' must be translated to a backend aspect the client accepts.
    expect(["coverage", "trends", "gaps", "strengths", "all"]).toContain(passed);
  });

  it("passes §31 aspects through unchanged", async () => {
    const { handler, getSelfModel } = captureTool();
    await handler({ aspect: "trends", limit: 10 });
    expect((getSelfModel.mock.calls[0] as unknown as [{ aspect: string }])[0].aspect).toBe(
      "trends"
    );
  });
});
