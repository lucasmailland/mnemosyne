/**
 * Shrinks the tools/list payload without changing what any tool accepts.
 *
 * Every byte of tools/list is paid at the top of every request by hosts that
 * do not defer tools. The SDK's zod → JSON Schema conversion emits things a
 * client never needs: `$schema` on every tool, the full ISO date-time and
 * UUID regexes next to `format` (≈235 bytes each), ±Number.MAX_SAFE_INTEGER
 * bounds on every integer, `propertyNames: {type: "string"}` and
 * `additionalProperties: {}` on free-form objects, `execution.taskSupport:
 * "forbidden"` (the MCP default), annotation hints equal to their MCP defaults
 * and the hints the spec says mean nothing on a read-only tool. Arguments are
 * still validated by the zod schemas, so dropping them from the advertised
 * JSON is free.
 */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/** MCP ToolAnnotations defaults: a hint equal to its default says nothing. */
const ANNOTATION_DEFAULTS: Record<string, boolean> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const isEmptyObject = (v: unknown): boolean =>
  v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
const isStringType = (v: unknown): boolean =>
  v !== null &&
  typeof v === "object" &&
  Object.keys(v).length === 1 &&
  (v as { type?: unknown }).type === "string";

export function compactSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compactSchema);
  if (node === null || typeof node !== "object") return node;
  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "$schema") continue;
    if (key === "pattern" && typeof source.format === "string") continue;
    if (key === "minimum" && value === -MAX_SAFE) continue;
    if (key === "maximum" && value === MAX_SAFE) continue;
    // JSON object keys are always strings, and {} allows anything: both are no-ops.
    if (key === "propertyNames" && isStringType(value)) continue;
    if (key === "additionalProperties" && isEmptyObject(value)) continue;
    out[key] = compactSchema(value);
  }
  return out;
}

function compactTool(tool: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...tool };
  if (out.inputSchema) out.inputSchema = compactSchema(out.inputSchema);
  if (out.outputSchema) out.outputSchema = compactSchema(out.outputSchema);
  const execution = out.execution as Record<string, unknown> | undefined;
  if (execution && Object.keys(execution).length === 1 && execution.taskSupport === "forbidden")
    delete out.execution;
  if (out.annotations && typeof out.annotations === "object") {
    const hints = out.annotations as Record<string, unknown>;
    // destructiveHint and idempotentHint mean something only when readOnlyHint is false.
    const kept = Object.entries(hints).filter(
      ([key, value]) =>
        ANNOTATION_DEFAULTS[key] !== value &&
        !(hints.readOnlyHint === true && (key === "destructiveHint" || key === "idempotentHint"))
    );
    if (kept.length > 0) out.annotations = Object.fromEntries(kept);
    else delete out.annotations;
  }
  return out;
}

/** Applied to the SDK's tools/list result (see registerAllTools). */
export function compactToolList(result: unknown): unknown {
  const list = result as { tools?: unknown[] } | null;
  if (!list || !Array.isArray(list.tools)) return result;
  return {
    ...list,
    tools: list.tools.map((tool) => compactTool(tool as Record<string, unknown>)),
  };
}
