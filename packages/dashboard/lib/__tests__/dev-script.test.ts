/**
 * APP-071: `pnpm dev` from a clean clone. The workspace packages the dashboard imports resolve
 * through their built `dist/` (their `exports` point there), so `next dev` alone answers 500
 * "Can't resolve '@mnemo-ai/types'" until someone builds them. The dev script builds them first.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

it("builds the workspace packages it depends on before `next dev`", () => {
  const [build, dev] = pkg.scripts.dev!.split(" && ");
  expect(build).toBe('pnpm --filter "@mnemo-ai/dashboard^..." build');
  expect(dev).toBe("next dev");
});

it("every workspace package the source imports is a dependency, so that build covers it", () => {
  const imported = new Set<string>();
  for (const file of ["app", "components", "lib"].flatMap((d) => sources(join(ROOT, d))))
    for (const m of readFileSync(file, "utf8").matchAll(/from "(@mnemo-ai\/[a-z0-9-]+)/g))
      imported.add(m[1]!);
  expect(imported.size).toBeGreaterThan(0);
  for (const name of imported) expect(pkg.dependencies[name], name).toBe("workspace:*");
});
