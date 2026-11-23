export interface PackResult {
  name: string;
  version: string;
  filename: string;
  files: Array<{ path: string }>;
}

function isPackResult(value: unknown): value is PackResult {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<PackResult>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.version === "string" &&
    typeof candidate.filename === "string" &&
    Array.isArray(candidate.files)
  );
}

export function parsePackResult(output: string, packageName: string): PackResult {
  // Lifecycle scripts (prepack copies the root LICENSE) echo their command to
  // stdout before the JSON, so parse from the first line that opens it.
  const start = output.search(/^[[{]/m);
  const parsed: unknown = JSON.parse(start === -1 ? output : output.slice(start));
  const candidate = Array.isArray(parsed)
    ? parsed.find((entry: unknown) => isPackResult(entry) && entry.name === packageName)
    : isPackResult(parsed) && parsed.name === packageName
      ? parsed
      : parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)[packageName]
        : undefined;

  if (!isPackResult(candidate)) throw new TypeError(`Missing pack result for ${packageName}`);
  return candidate;
}

export function runAvailabilityBranch<Result>(
  available: boolean,
  branches: { registry: () => Result; unpacked: () => Result }
): Result {
  return available ? branches.registry() : branches.unpacked();
}
