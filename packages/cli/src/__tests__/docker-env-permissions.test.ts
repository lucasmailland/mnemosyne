/**
 * CLI-1 — writeDockerEnv() writes docker/.env with MNEMO_LLM_API_KEY (and
 * other secrets) in plaintext. Before this fix the file inherited default
 * umask permissions (typically 0644 — group/world readable), so any other
 * local user on a shared machine could read the LLM key straight off disk.
 * The file must be owner-only (0600).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDockerEnv } from "../commands.js";

describe("writeDockerEnv", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("writes docker/.env with 0600 permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "mnemo-cli-env-"));
    dirs.push(dir);
    const composePath = join(dir, "docker-compose.yml");

    writeDockerEnv(composePath, { MNEMO_LLM_API_KEY: "sk-secret-value" });

    const envPath = join(dir, ".env");
    const mode = statSync(envPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
