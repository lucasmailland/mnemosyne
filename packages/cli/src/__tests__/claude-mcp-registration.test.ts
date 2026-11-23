/**
 * APP-012 — `claude mcp add` was run at three sites (init, init --docker,
 * install) that checked only `r.error`, i.e. "could the binary be spawned".
 * A second add of the same name exits 1 with "already exists" and keeps the
 * OLD key, and every site printed success anyway.
 *
 * These run the real helper against a fake `claude` on a scratch PATH that
 * records its argv and keeps a file-per-name "registry", so "already exists" is the
 * fake's own state, not a canned answer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { registerClaudeMcpServer } from "../commands.js";

const KEY = "mns_live_SECRETKEY";
const INPUT = { url: "http://localhost:3939", key: KEY, mcpPath: "npx -y @mnemo-ai/mcp" };

// One registry file per server name (registry-<name>), holding the add argv so
// the test can see which key won. add: exits 1 "already exists" while that
// name's file exists. remove: deletes it, or exits 1 when there is nothing to
// remove. FAKE_ADD_EXIT forces add to fail — for every name, or only for
// FAKE_ADD_ONLY when that is set.
const FAKE_CLAUDE = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_DIR/argv.log"
if [ "$1 $2" = "mcp remove" ]; then
  [ -f "$FAKE_DIR/registry-$3" ] || { echo "No MCP server found with name: $3" >&2; exit 1; }
  rm -f "$FAKE_DIR/registry-$3"; exit 0
fi
if [ "$1 $2" = "mcp add" ]; then
  if [ -n "\${FAKE_ADD_EXIT:-}" ] && { [ -z "\${FAKE_ADD_ONLY:-}" ] || [ "$3" = "$FAKE_ADD_ONLY" ]; }; then
    echo "boom: rejected $*" >&2; exit "$FAKE_ADD_EXIT"
  fi
  [ -f "$FAKE_DIR/registry-$3" ] && { echo "MCP server $3 already exists in user config" >&2; exit 1; }
  printf '%s\\n' "$*" > "$FAKE_DIR/registry-$3"; exit 0
fi
exit 2
`;

describe("APP-012 — registerClaudeMcpServer", () => {
  let dir: string;
  const realPath = process.env.PATH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-fake-claude-"));
    writeFileSync(join(dir, "claude"), FAKE_CLAUDE, { mode: 0o755 });
    process.env.PATH = `${dir}${delimiter}${realPath}`;
    process.env.FAKE_DIR = dir;
  });
  afterEach(() => {
    process.env.PATH = realPath;
    delete process.env.FAKE_DIR;
    delete process.env.FAKE_ADD_EXIT;
    delete process.env.FAKE_ADD_ONLY;
    rmSync(dir, { recursive: true, force: true });
  });

  const registry = (name: string) => join(dir, `registry-${name}`);
  const ADD_ARGS = `--scope user -e MNEMO_URL=http://localhost:3939 -e MNEMO_KEY=${KEY} -- npx -y @mnemo-ai/mcp`;

  it("registers the new entry under a staging name first, then swaps it in", () => {
    expect(registerClaudeMcpServer(INPUT)).toEqual({ ok: true });
    expect(readFileSync(registry("mnemosyne"), "utf8").trim()).toBe(
      `mcp add mnemosyne ${ADD_ARGS}`
    );
    // The staging entry is gone once the real one is in place.
    expect(existsSync(registry("mnemosyne-new"))).toBe(false);
  });

  it("an existing registration is replaced, so the NEW key is the one Claude keeps", () => {
    expect(registerClaudeMcpServer({ ...INPUT, key: "mns_live_OLDKEY" }).ok).toBe(true);
    expect(registerClaudeMcpServer(INPUT)).toEqual({ ok: true });
    const entry = readFileSync(registry("mnemosyne"), "utf8");
    expect(entry).toContain(`MNEMO_KEY=${KEY}`);
    expect(entry).not.toContain("OLDKEY");
  });

  it("a failing add is a failure, with claude's stderr and without the key", () => {
    process.env.FAKE_ADD_EXIT = "3";
    const result = registerClaudeMcpServer(INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("boom: rejected");
    expect(result.reason).not.toContain(KEY);
    expect(existsSync(registry("mnemosyne"))).toBe(false);
  });

  it("a failing add never removes the registration the user already had", () => {
    expect(registerClaudeMcpServer({ ...INPUT, key: "mns_live_OLDKEY" }).ok).toBe(true);
    process.env.FAKE_ADD_EXIT = "3";
    expect(registerClaudeMcpServer(INPUT).ok).toBe(false);
    expect(readFileSync(registry("mnemosyne"), "utf8")).toContain("MNEMO_KEY=mns_live_OLDKEY");
  });

  it("when only the final add fails, the staged entry (new key) stays registered and the reason says so", () => {
    expect(registerClaudeMcpServer({ ...INPUT, key: "mns_live_OLDKEY" }).ok).toBe(true);
    process.env.FAKE_ADD_EXIT = "3";
    process.env.FAKE_ADD_ONLY = "mnemosyne";
    const result = registerClaudeMcpServer(INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(readFileSync(registry("mnemosyne-new"), "utf8")).toContain(`MNEMO_KEY=${KEY}`);
    expect(result.reason).toContain("mnemosyne-new");
    expect(result.reason).not.toContain(KEY);
  });

  it("a missing claude binary is a failure, not a success", () => {
    process.env.PATH = dir; // nothing named claude...
    rmSync(join(dir, "claude")); // ...anywhere on it
    const result = registerClaudeMcpServer(INPUT);
    expect(result.ok).toBe(false);
  });
});
