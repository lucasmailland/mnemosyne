import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const REPO_ROOT = new URL("../../../../", import.meta.url);

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, REPO_ROOT), "utf8")) as Record<string, unknown>;
}

function contractsJob(ci: string): string {
  const start = ci.search(/^  contracts:\s*(?:#.*)?$/m);
  if (start === -1) throw new Error("CI contracts job not found");

  const remaining = ci.slice(start + 1);
  const nextJob = remaining.search(/^  (?!#)[^ \n][^:\n]*:\s*(?:#.*)?$/m);
  return nextJob === -1 ? ci.slice(start) : ci.slice(start, start + 1 + nextJob);
}

function runCommands(job: string): string[] {
  const lines = job.split("\n");
  const commands: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line?.match(/^(\s+)run:\s*(.*?)\s*$/);
    if (!match) continue;

    const indent = match[1]?.length ?? 0;
    const value = match[2] ?? "";
    if (!/^[|>][-+]?\d?$/.test(value)) {
      commands.push(value.replace(/\s+/g, " ").trim());
      continue;
    }

    const block: string[] = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (next === undefined) break;
      if (next.trim() !== "" && (next.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
      index += 1;
      if (next.trim() !== "") block.push(next.trim());
    }
    commands.push(block.join(" ").replace(/\s+/g, " ").trim());
  }

  return commands;
}

describe("MCP contract gate configuration", () => {
  it("composes strict typechecking and every focused runtime suite", () => {
    const packageJson = readJson("packages/mcp/package.json");
    const scripts = packageJson.scripts as Record<string, string>;
    const runtimeSuites = [
      "src/__tests__/contracts/schema-normalizer.test.ts",
      "src/__tests__/contracts/schema-contracts.test.ts",
      "src/__tests__/contract.test.ts",
      "src/__tests__/tool-contracts.test.ts",
      "src/__tests__/registry.test.ts",
      "src/__tests__/contracts/output-foundations.test.ts",
      "src/__tests__/contracts/output-primitives.test.ts",
      "src/__tests__/contracts/output-cognitive.test.ts",
      "src/__tests__/contracts/output-admin.test.ts",
      "src/__tests__/contracts/output-completeness.test.ts",
      "src/__tests__/doctor.test.ts",
      "src/__tests__/idempotency.contract.test.ts",
      "src/__tests__/recall.stdio.test.ts",
      "src/__tests__/contracts-config.test.ts",
      // tool-promise-remediation Fases 3–16: los 7 contract tests de las tools
      // que estaban UNAUDITED. Van en el gate, no sólo en `pnpm test` — un
      // contract test que no corre donde se decide el merge es un test que no
      // existe.
      "src/__tests__/contracts/purge.test.ts",
      "src/__tests__/contracts/judge.test.ts",
      "src/__tests__/contracts/doctor.test.ts",
      "src/__tests__/contracts/pin.test.ts",
      "src/__tests__/contracts/skill.test.ts",
      "src/__tests__/contracts/workflow.test.ts",
      "src/__tests__/contracts/workspace.test.ts",
      // tool-promise-remediation Fase 2: las disclosures y el verdicto real de
      // memory_episode_end. Mismo motivo que arriba — una advertencia que nadie
      // verifica en el merge se borra sola en el próximo rewrite.
      "src/__tests__/contracts/disclosures.test.ts",
      "src/__tests__/contracts/episode-end-status.test.ts",
      // Fases 3–16, las 7 tools restantes: timeline, search, decide,
      // status, strategy, stats, compare.
      "src/__tests__/contracts/timeline-search-decide.test.ts",
      "src/__tests__/contracts/status-strategy-stats-compare.test.ts",
    ];

    expect(scripts).not.toHaveProperty("pretest");
    expect(scripts).not.toHaveProperty("test:contracts:structural");
    expect(scripts["test:contracts:typecheck"]).toBe(
      "tsc -p tsconfig.contract-tests.json --noEmit"
    );
    expect(scripts["test:contracts:runtime"]).toBe(
      `NO_COVERAGE=1 vitest run ${runtimeSuites.join(" ")}`
    );
    expect(scripts["test:contracts"]).toBe(
      "pnpm run test:contracts:typecheck && pnpm run test:contracts:runtime"
    );
  });

  it("orders MCP tests after local and dependency builds without cache", () => {
    const turbo = readJson("turbo.json");
    const tasks = turbo.tasks as Record<string, Record<string, unknown>>;

    expect(tasks["@mnemo-ai/mcp#test"]).toEqual({
      dependsOn: ["build", "^build"],
      outputs: ["coverage/**"],
      cache: false,
    });
  });

  it("builds once and invokes the composed MCP gate once in CI", () => {
    const ci = readFileSync(new URL(".github/workflows/ci.yml", REPO_ROOT), "utf8");
    const job = contractsJob(ci);
    const commands = runCommands(job);
    const buildCommand = "pnpm --filter @mnemo-ai/mcp... --filter @mnemo-ai/server... build";
    const gateCommand = "pnpm --filter @mnemo-ai/mcp run test:contracts";
    const mcpClosureFilter = /(?:--filter(?:=|\s+)|-F\s+)@mnemo-ai\/mcp\.\.\.(?:\s|$)/;
    const serverClosureFilter = /(?:--filter(?:=|\s+)|-F\s+)@mnemo-ai\/server\.\.\.(?:\s|$)/;
    const mcpFilter = /(?:--filter(?:=|\s+)|-F\s+)@mnemo-ai\/mcp(?:\s|$)/;

    const builds = commands.filter(
      (command) =>
        mcpClosureFilter.test(command) &&
        serverClosureFilter.test(command) &&
        /(?:^|\s)build(?:\s|$)/.test(command)
    );
    const gates = commands.filter(
      (command) =>
        mcpFilter.test(command) && /(?:^|\s)(?:run\s+)?test:contracts(?:\s|$)/.test(command)
    );

    expect(builds).toEqual([buildCommand]);
    expect(gates).toEqual([gateCommand]);
    expect(job).toContain("MCP contracts (33 schemas + 95 outputs + stdio)");
    expect(commands.some((command) => command.includes("test:contracts:typecheck"))).toBe(false);
  });
});
