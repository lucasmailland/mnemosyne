import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePackResult, runAvailabilityBranch } from "./pack-result.js";

interface PackResult {
  name: string;
  version: string;
  filename: string;
  files: Array<{ path: string }>;
}

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../../..", import.meta.url));
// TS 7 ships no JS API: `typescript` is the TS 6 compat alias, so the consumer
// typecheck runs the TS 7 binary from `@typescript/native`.
const tscPath = join(
  dirname(createRequire(import.meta.url).resolve("@typescript/native/package.json")),
  "lib",
  "tsc.js"
);

function isRegistryVersionAvailable(specifier: string): boolean {
  const injected = process.env.MNEMO_TYPES_REGISTRY_AVAILABLE;
  if (injected === "1") return true;
  if (injected === "0") return false;
  if (injected !== undefined) {
    throw new Error("MNEMO_TYPES_REGISTRY_AVAILABLE must be 0 or 1");
  }

  const result = spawnSync(
    "pnpm",
    ["view", specifier, "version", "--json", "--registry=https://registry.npmjs.org"],
    { encoding: "utf8" }
  );
  if (result.status === 0) return true;

  const diagnostic = `${result.stdout}\n${result.stderr}`;
  if (/ERR_PNPM_FETCH_404|E404|No matching version found/i.test(diagnostic)) return false;
  throw new Error(`Could not determine registry availability for ${specifier}: ${diagnostic}`);
}

function writeConsumer(consumerRoot: string, harnessDependency?: string): void {
  writeFileSync(
    join(consumerRoot, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      ...(harnessDependency === undefined
        ? {}
        : { dependencies: { "@mnemo-ai/harness": harnessDependency } }),
    })
  );
  writeFileSync(
    join(consumerRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: [],
      },
      include: ["consumer.mts", "consumer.cts"],
    })
  );
  const contract = [
    'import { computeTerminalDigest, normalizeVisibleMessage, type VisibleMessage } from "@mnemo-ai/harness";',
    'const message: VisibleMessage = { role: "user", content: "hello" };',
    "normalizeVisibleMessage(message);",
    'computeTerminalDigest([{ type: "M", hostMessageId: "m1", role: "user", contentHash: "aa" }]);',
    "// @ts-expect-error system messages are not public visible messages",
    'const hidden: VisibleMessage = { role: "system", content: "hidden" };',
    "void hidden;",
  ].join("\n");
  writeFileSync(join(consumerRoot, "consumer.mts"), contract);
  writeFileSync(
    join(consumerRoot, "consumer.cts"),
    [
      'import harness = require("@mnemo-ai/harness");',
      'const message: import("@mnemo-ai/harness").VisibleMessage = { role: "assistant", content: "hello" };',
      "harness.normalizeVisibleMessage(message);",
      'harness.computeTerminalDigest([{ type: "L", hostMessageId: "m1", role: "assistant", contentHash: "aa" }]);',
    ].join("\n")
  );
}

function probeConsumer(consumerRoot: string): void {
  // tsc reports type errors on STDOUT and exits non-zero. Letting execFileSync
  // throw hides every one of them behind "Command failed", which turns a one-line
  // signature problem into a bisect.
  const types = spawnSync(
    process.execPath,
    [tscPath, "--project", join(consumerRoot, "tsconfig.json")],
    { cwd: consumerRoot, encoding: "utf8" }
  );
  expect(types.status, `${types.stdout ?? ""}${types.stderr ?? ""}`).toBe(0);

  const esmProbe =
    'import { computePayloadHash, computeTerminalDigest } from "@mnemo-ai/harness"; process.stdout.write([computePayloadHash({ format: "esm" }), computeTerminalDigest([])].join(":"))';
  const cjsProbe =
    'const { computePayloadHash, computeTerminalDigest } = require("@mnemo-ai/harness"); process.stdout.write([computePayloadHash({ format: "cjs" }), computeTerminalDigest([])].join(":"))';
  const esm = spawnSync(process.execPath, ["--input-type=module", "--eval", esmProbe], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  const cjs = spawnSync(process.execPath, ["--eval", cjsProbe], {
    cwd: consumerRoot,
    encoding: "utf8",
  });

  expect.soft(esm.status, esm.stderr).toBe(0);
  expect.soft(cjs.status, cjs.stderr).toBe(0);

  // The capture decision must work FROM THE INSTALLED PACKAGE, which is the only
  // place a packaging or path bug can exist. Both such bugs produced a *safe*
  // wrong answer — every host permanently mcp-only — so nothing crashed and no
  // source-tree test could see it. Assert on the REASON, not the mode: a machine
  // legitimately resolves to mcp-only, but never because the package cannot find
  // its own records.
  const decisionProbe =
    'const { resolveHostCaptureMode } = require("@mnemo-ai/harness");' +
    'process.stdout.write(JSON.stringify(resolveHostCaptureMode({ host: "opencode", hostVersion: "0.0.0" })));';
  const decision = spawnSync(process.execPath, ["--eval", decisionProbe], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  expect.soft(decision.status, decision.stderr).toBe(0);
  const reason = String(JSON.parse(decision.stdout || "{}").reason ?? "");
  expect
    .soft(reason, "installed package cannot locate its qualification records")
    .not.toMatch(/no qualification record|no recorded fixture|package root not found/);
  expect.soft(esm.stdout).toMatch(/^[a-f0-9]{64}:[a-f0-9]{64}$/);
  expect.soft(cjs.stdout).toMatch(/^[a-f0-9]{64}:[a-f0-9]{64}$/);
}

describe("pack output parsing", () => {
  const result: PackResult = {
    name: "@mnemo-ai/harness",
    version: "3.6.1",
    filename: "/tmp/mnemo-ai-harness-3.6.1.tgz",
    files: [{ path: "package.json" }],
  };

  it("accepts npm's JSON array format", () => {
    expect(parsePackResult(JSON.stringify([result]), "@mnemo-ai/harness")).toEqual(result);
  });

  it("accepts package-name-keyed JSON object format", () => {
    expect(
      parsePackResult(JSON.stringify({ "@mnemo-ai/harness": result }), "@mnemo-ai/harness")
    ).toEqual(result);
  });

  it("accepts pnpm's direct JSON object format", () => {
    expect(parsePackResult(JSON.stringify(result), "@mnemo-ai/harness")).toEqual(result);
  });
});

describe("dependency availability branching", () => {
  it.each([
    [true, "registry"],
    [false, "unpacked"],
  ] as const)("selects the %s availability result branch", (available, expected) => {
    const calls: string[] = [];

    runAvailabilityBranch(available, {
      registry: () => calls.push("registry"),
      unpacked: () => calls.push("unpacked"),
    });

    expect(calls).toEqual([expected]);
  });
});

describe("package contents", () => {
  it("packs and validates consumers according to exact registry dependency availability", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "mnemo-harness-package-"));
    try {
      // `pnpm build` runs tsup with `clean: true`, which DELETES this package's
      // dist before rewriting it. Every other package in the monorepo resolves
      // `@mnemo-ai/harness` from that directory, and turbo runs their test tasks
      // in parallel with this one — so the deletion window made unrelated suites
      // fail to resolve a package they had not even imported yet, differently on
      // every run. `--no-clean` overwrites in place: dist is never absent.
      execFileSync("pnpm", ["exec", "tsup", "--no-clean"], { cwd: packageRoot, stdio: "pipe" });
      const harness = parsePackResult(
        execFileSync("pnpm", ["pack", "--json", "--pack-destination", temporaryRoot], {
          cwd: packageRoot,
          encoding: "utf8",
        }),
        "@mnemo-ai/harness"
      );
      const files = harness.files.map(({ path }) => path);

      const unpackedRoot = join(temporaryRoot, "unpacked");
      mkdirSync(unpackedRoot);
      execFileSync("tar", ["-xzf", harness.filename, "-C", unpackedRoot]);
      const unpackedPackage = join(unpackedRoot, "package");
      const packedManifest = JSON.parse(
        readFileSync(join(unpackedPackage, "package.json"), "utf8")
      ) as {
        dependencies: Record<string, string>;
        exports: Record<string, unknown>;
      };

      expect(files.sort()).toEqual(
        [
          "LICENSE",
          "README.es.md",
          "README.md",
          "dist/index.cjs",
          "dist/index.cjs.map",
          "dist/index.d.cts",
          "dist/index.d.ts",
          "dist/index.js",
          "dist/index.js.map",
          "package.json",
          "fixtures/claude-code-events.json",
          "fixtures/claude-code-subagent-stop.json",
          "fixtures/codex-events.json",
          "fixtures/opencode-events.json",
          "qualifications/claude-code.json",
          "qualifications/codex.json",
          "qualifications/opencode.json",
        ].sort()
      );
      expect(files.some((path) => path.includes("__tests__"))).toBe(false);

      expect(JSON.stringify(packedManifest)).not.toContain("workspace:*");
      expect(packedManifest.exports).toEqual({
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
          require: "./dist/index.cjs",
        },
        "./package.json": "./package.json",
      });
      for (const path of [
        "index.js",
        "index.cjs",
        "index.d.ts",
        "index.d.cts",
        "index.js.map",
        "index.cjs.map",
      ]) {
        expect(existsSync(join(unpackedPackage, "dist", path))).toBe(true);
      }

      const installedDist = join(unpackedPackage, "dist");
      const esmCode = readFileSync(join(installedDist, "index.js"), "utf8");
      const cjsCode = readFileSync(join(installedDist, "index.cjs"), "utf8");
      const declarations = readFileSync(join(installedDist, "index.d.ts"), "utf8");
      const cjsDeclarations = readFileSync(join(installedDist, "index.d.cts"), "utf8");
      expect(esmCode).not.toMatch(/from ["']@mnemo-ai\/types["']/);
      expect(cjsCode).not.toMatch(/require\(["']@mnemo-ai\/types["']\)/);
      expect(declarations).not.toMatch(/from ["']@mnemo-ai\/types(?:\/[^"']*)?["']/);
      expect(cjsDeclarations).not.toMatch(/from ["']@mnemo-ai\/types(?:\/[^"']*)?["']/);
      expect(declarations).toContain('role: "user" | "assistant"');

      for (const [entrypoint, mapName] of [
        [esmCode, "index.js.map"],
        [cjsCode, "index.cjs.map"],
      ] as const) {
        const sourceMap = JSON.parse(readFileSync(join(installedDist, mapName), "utf8")) as {
          sources: string[];
          sourcesContent: string[];
        };
        expect(entrypoint).toContain(`sourceMappingURL=${mapName}`);
        expect(sourceMap.sources).toEqual(
          expect.arrayContaining([
            "../src/adapters/capabilities.ts",
            "../src/adapters/claude-code.ts",
            "../src/adapters/codex.ts",
            "../src/adapters/opencode.ts",
            "../src/binding.ts",
            "../src/consent.ts",
            "../src/delivery.ts",
            "../src/doctor.ts",
            "../src/fs-security.ts",
            "../src/host-runtime.ts",
            "../src/host-version.ts",
            "../src/legacy-capture.ts",
            "../src/outbox.ts",
            "../src/protocol.ts",
            "../src/reconcile.ts",
            "../src/sanitize.ts",
            "../src/state.ts",
            "../../types/src/harness-runtime.ts",
            "../../types/src/session.ts",
          ])
        );
        expect(sourceMap.sources).toHaveLength(19);
        expect(sourceMap.sources.every((source) => !isAbsolute(source))).toBe(true);
        expect(sourceMap.sourcesContent).toHaveLength(sourceMap.sources.length);
      }

      const typesVersion = packedManifest.dependencies["@mnemo-ai/types"];
      const available = isRegistryVersionAvailable(`@mnemo-ai/types@${typesVersion}`);
      runAvailabilityBranch(available, {
        registry: () => {
          writeConsumer(temporaryRoot, `file:${harness.filename}`);
          execFileSync(
            "pnpm",
            [
              "install",
              "--ignore-workspace",
              "--config.dangerouslyAllowAllBuilds=true",
              "--registry=https://registry.npmjs.org",
            ],
            { cwd: temporaryRoot, stdio: "pipe" }
          );
          const dependencyTree = JSON.parse(
            execFileSync("pnpm", ["list", "--json", "--depth", "Infinity"], {
              cwd: temporaryRoot,
              encoding: "utf8",
            })
          ) as unknown;
          expect(JSON.stringify(dependencyTree)).toContain(
            `"@mnemo-ai/types":{"from":"@mnemo-ai/types","version":"${typesVersion}"`
          );
          probeConsumer(temporaryRoot);
        },
        unpacked: () => {
          const consumerRoot = join(temporaryRoot, "unpacked-consumer");
          const installedHarness = join(consumerRoot, "node_modules/@mnemo-ai/harness");
          mkdirSync(join(consumerRoot, "node_modules/@mnemo-ai"), { recursive: true });
          cpSync(unpackedPackage, installedHarness, { recursive: true });
          writeConsumer(consumerRoot);
          probeConsumer(consumerRoot);
        },
      });
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("ships the full Apache-2.0 license terms", () => {
    // prepack copies the root LICENSE into the package (the pack test above
    // checks it lands in the tarball), so the root file is the one to check.
    const license = readFileSync(join(workspaceRoot, "LICENSE"), "utf8");

    expect(license).toContain("1. Definitions.");
    expect(license).toContain("9. Accepting Warranty or Additional Liability.");
    expect(license).toContain("END OF TERMS AND CONDITIONS");
    expect(license).toContain("APPENDIX: How to apply the Apache License to your work.");
    expect(Buffer.byteLength(license, "utf8")).toBeGreaterThan(10_000);
  });
});

describe("release automation", () => {
  it("links harness releases to the workspace types package", () => {
    const config = JSON.parse(
      readFileSync(join(workspaceRoot, ".github/release-please-config.json"), "utf8")
    ) as {
      plugins: Array<{ type: string; components?: string[]; "always-link-local"?: boolean }>;
      packages: Record<string, { "package-name": string; component: string }>;
    };
    const manifest = JSON.parse(
      readFileSync(join(workspaceRoot, ".github/.release-please-manifest.json"), "utf8")
    ) as Record<string, string>;
    expect(config.plugins).toEqual([
      { type: "node-workspace", "always-link-local": true, merge: false },
      {
        type: "linked-versions",
        groupName: "mnemosyne-core",
        components: [
          "mnemosyne",
          "@mnemo-ai/core",
          "@mnemo-ai/server",
          "@mnemo-ai/client-ts",
          "@mnemo-ai/types",
          "@mnemo-ai/harness",
          "@mnemo-ai/adapter-postgres",
          "@mnemo-ai/adapter-redis",
          "@mnemo-ai/adapter-vector",
          "@mnemo-ai/adapter-llm",
          "@mnemo-ai/llm-providers",
          "@mnemo-ai/mcp",
          "@mnemo-ai/cli",
          "@mnemo-ai/consolidation",
          "@mnemo-ai/cup",
          "@mnemo-ai/federation",
          "@mnemo-ai/plugins",
          "@mnemo-ai/mock-server",
        ],
      },
    ]);
    expect(config.packages["packages/harness"]).toMatchObject({
      "package-name": "@mnemo-ai/harness",
      component: "@mnemo-ai/harness",
    });
    expect(manifest["packages/harness"]).toBe(manifest["packages/types"]);
  });
});
