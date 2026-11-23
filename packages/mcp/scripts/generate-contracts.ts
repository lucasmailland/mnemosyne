import { mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MCP_TOOL_COUNT } from "../src/registry.js";
import { normalizeSchema } from "../src/__tests__/contracts/schema-normalizer.js";
import {
  listBuiltTools,
  type BuiltToolsFixture,
} from "../src/__tests__/contracts/stdio-tools.js";

const CONTRACTS_DIR = fileURLToPath(new URL("../contracts/", import.meta.url));
const CONTRACTS_PARENT = dirname(CONTRACTS_DIR);

async function replaceArtifacts(stagingDir: string, fileNames: readonly string[]): Promise<void> {
  const backupDir = await mkdtemp(join(CONTRACTS_PARENT, ".contracts-backup-"));
  const existingFiles = (await readdir(CONTRACTS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name);
  const backedUp: string[] = [];
  const installed: string[] = [];
  let preserveBackup = false;

  try {
    for (const file of existingFiles) {
      await rename(join(CONTRACTS_DIR, file), join(backupDir, file));
      backedUp.push(file);
    }
    for (const file of fileNames) {
      await rename(join(stagingDir, file), join(CONTRACTS_DIR, file));
      installed.push(file);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const file of installed) {
      await rm(join(CONTRACTS_DIR, file), { force: true }).catch((rollbackError) => {
        rollbackErrors.push(rollbackError);
      });
    }
    for (const file of backedUp) {
      await rename(join(backupDir, file), join(CONTRACTS_DIR, file)).catch((rollbackError) => {
        rollbackErrors.push(rollbackError);
      });
    }
    if (rollbackErrors.length > 0) {
      preserveBackup = true;
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Contract replacement and rollback failed; recovery files remain in ${backupDir}`,
      );
    }
    throw error;
  } finally {
    if (!preserveBackup) {
      await rm(backupDir, { recursive: true, force: true });
    }
  }
}

async function generateContracts(): Promise<void> {
  let fixture: BuiltToolsFixture | undefined;
  let stagingDir: string | undefined;

  try {
    fixture = await listBuiltTools();
    const names = fixture.tools.map(({ name }) => name);
    if (names.length !== MCP_TOOL_COUNT) {
      throw new Error(`Expected ${MCP_TOOL_COUNT} tools, received ${names.length}`);
    }
    if (new Set(names).size !== names.length) {
      throw new Error("Built tools/list returned duplicate tool names");
    }
    if (fixture.httpRequestCount() !== 0) {
      throw new Error("Built tools/list made an unexpected HTTP request");
    }

    const artifacts = fixture.tools.map((tool) => {
      if (!tool.name.startsWith("memory_")) {
        throw new Error(`Unexpected tool name: ${tool.name}`);
      }
      const suffix = tool.name.slice("memory_".length);
      if (!/^[a-z_]+$/.test(suffix)) {
        throw new Error(`Invalid contract filename suffix: ${suffix}`);
      }
      return {
        file: `${suffix}.json`,
        value: {
          formatVersion: 1,
          tool: tool.name,
          inputSchema: normalizeSchema(tool.inputSchema),
        },
      };
    }).sort((left, right) => left.file.localeCompare(right.file));

    if (new Set(artifacts.map(({ file }) => file)).size !== artifacts.length) {
      throw new Error("Built tools/list produced duplicate contract filename suffixes");
    }

    const createdStagingDir = await mkdtemp(join(CONTRACTS_PARENT, ".contracts-stage-"));
    stagingDir = createdStagingDir;
    await Promise.all(artifacts.map(({ file, value }) =>
      writeFile(join(createdStagingDir, file), `${JSON.stringify(value, null, 2)}\n`, "utf8")
    ));
    await replaceArtifacts(createdStagingDir, artifacts.map(({ file }) => file));
    console.log(`Generated ${artifacts.length} MCP contract artifacts.`);
  } finally {
    try {
      await fixture?.close();
    } finally {
      if (stagingDir) {
        await rm(stagingDir, { recursive: true, force: true });
      }
    }
  }
}

await generateContracts();
