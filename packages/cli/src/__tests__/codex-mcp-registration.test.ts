/**
 * APP-011 — `mnemo install` registers the MCP server in `~/.codex/config.toml`.
 *
 * The first version removed the previous block with a regex whose body was
 * "anything that is not `[`", so it stopped at the `[` of
 * `args = ["-y", "@mnemo-ai/mcp"]`. The second install therefore left a dangling
 * `["-y", "@mnemo-ai/mcp"]` line (not TOML) and printed a green tick. The test
 * that claimed idempotence only searched the source for the word `replace`.
 *
 * Everything here EXECUTES the registration against real files in a scratch
 * directory. `legacyInstall` is the old code, kept verbatim, only to manufacture
 * the corrupted files real machines now have.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

import { registerCodexMcpServer, type CodexMcpServer } from "../codex-config.js";

const SERVER: CodexMcpServer = {
  command: "npx",
  args: ["-y", "@mnemo-ai/mcp"],
  url: "http://localhost:3939",
  key: "mns_live_FIRSTKEY",
};

const WANTED = {
  command: "npx",
  args: ["-y", "@mnemo-ai/mcp"],
  env: { MNEMO_URL: "http://localhost:3939", MNEMO_KEY: "mns_live_FIRSTKEY" },
};

/** The removed installer code, byte for byte. */
function legacyInstall(existingToml: string, server: CodexMcpServer): string {
  const tomlStr = (v: string) => JSON.stringify(v);
  const block = [
    "[mcp_servers.mnemosyne]",
    `command = ${tomlStr(server.command)}`,
    `args = [${server.args.map((a) => tomlStr(a)).join(", ")}]`,
    "",
    "[mcp_servers.mnemosyne.env]",
    `MNEMO_URL = ${tomlStr(server.url)}`,
    `MNEMO_KEY = ${tomlStr(server.key)}`,
  ].join("\n");
  const withoutOld = existingToml
    .replace(/\[mcp_servers\.mnemosyne(?:\.[a-z]+)?\][^[]*/g, "")
    .trimEnd();
  return (withoutOld ? withoutOld + "\n\n" : "") + block + "\n";
}

const USER_CONFIG = [
  "# my codex config — do not lose this",
  'model = "gpt-5" # the good one',
  "",
  "[features]",
  "hooks = true",
  "",
  "# the other server I use",
  "[mcp_servers.other]",
  'command = "node"',
  'args = ["/opt/other/index.js"]',
  "",
  "[mcp_servers.other.env]",
  'TOKEN = "abc"',
  "",
].join("\n");

const headerCount = (text: string) =>
  text.split("\n").filter((line) => line.trim() === "[mcp_servers.mnemosyne]").length;

const withoutMnemosyne = (text: string) => {
  const doc = parse(text) as { mcp_servers?: Record<string, unknown> };
  if (doc.mcp_servers) {
    delete doc.mcp_servers["mnemosyne"];
    if (Object.keys(doc.mcp_servers).length === 0) delete doc.mcp_servers;
  }
  return doc;
};

describe("APP-011 — registering the MCP server in Codex's config.toml", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function scratch(contents?: string, mode?: number): string {
    const dir = mkdtempSync(join(tmpdir(), "mnemo-codex-mcp-"));
    dirs.push(dir);
    const path = join(dir, "config.toml");
    if (contents !== undefined) writeFileSync(path, contents, mode ? { mode } : undefined);
    return path;
  }

  const mnemosyneOf = (path: string) =>
    (parse(readFileSync(path, "utf8")) as { mcp_servers: Record<string, unknown> }).mcp_servers[
      "mnemosyne"
    ];

  it("(a) creates the file when there is none, readable by the owner only", () => {
    const path = scratch();
    expect(registerCodexMcpServer({ configPath: path, server: SERVER })).toMatchObject({
      status: "installed",
    });
    expect(mnemosyneOf(path)).toEqual(WANTED);
    // It holds an API key.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("(b) a second install leaves valid TOML, one server, and the user's content intact", () => {
    const path = scratch(USER_CONFIG);
    expect(registerCodexMcpServer({ configPath: path, server: SERVER }).status).toBe("installed");
    const afterFirst = readFileSync(path, "utf8");
    const second = registerCodexMcpServer({ configPath: path, server: SERVER });
    const afterSecond = readFileSync(path, "utf8");

    expect(second.status).toBe("already-installed");
    expect(afterSecond).toBe(afterFirst);
    expect(headerCount(afterSecond)).toBe(1);
    expect(mnemosyneOf(path)).toEqual(WANTED);
    expect(withoutMnemosyne(afterSecond)).toEqual(parse(USER_CONFIG));
    // Byte-for-byte: everything the user wrote is still the head of the file.
    expect(afterSecond.startsWith(USER_CONFIG)).toBe(true);
  });

  it("(b) a reinstall with a new key replaces the old one instead of keeping both", () => {
    const path = scratch(USER_CONFIG);
    registerCodexMcpServer({ configPath: path, server: SERVER });
    const rotated = { ...SERVER, key: "mns_live_SECONDKEY" };
    expect(registerCodexMcpServer({ configPath: path, server: rotated }).status).toBe("installed");

    const text = readFileSync(path, "utf8");
    expect(headerCount(text)).toBe(1);
    expect(text).not.toContain("mns_live_FIRSTKEY");
    expect(mnemosyneOf(path)).toEqual({
      ...WANTED,
      env: { ...WANTED.env, MNEMO_KEY: "mns_live_SECONDKEY" },
    });
    expect(withoutMnemosyne(text)).toEqual(parse(USER_CONFIG));
  });

  it("(b) replaces a block that sits in the MIDDLE of the file without moving its neighbours", () => {
    // An older key, so there is something to replace.
    const before = legacyInstall('model = "gpt-5"\n', { ...SERVER, key: "mns_live_OLDKEY" });
    const original = `${before}\n# keep me with my table\n[profiles.fast]\nmodel = "o4-mini"\n`;
    const path = scratch(original);
    expect(registerCodexMcpServer({ configPath: path, server: SERVER }).status).toBe("installed");

    const text = readFileSync(path, "utf8");
    expect(text.startsWith('model = "gpt-5"\n\n[mcp_servers.mnemosyne]\n')).toBe(true);
    expect(text.endsWith('\n# keep me with my table\n[profiles.fast]\nmodel = "o4-mini"\n')).toBe(
      true
    );
    expect(mnemosyneOf(path)).toEqual(WANTED);
    expect(withoutMnemosyne(text)).toEqual({
      model: "gpt-5",
      profiles: { fast: { model: "o4-mini" } },
    });
  });

  it("(c) the old installer really did corrupt the file on its second run", () => {
    const corrupted = legacyInstall(legacyInstall(USER_CONFIG, SERVER), SERVER);
    expect(corrupted).toContain('\n["-y", "@mnemo-ai/mcp"]\n');
    expect(() => parse(corrupted)).toThrow();
  });

  it("(c) repairs a file the old installer corrupted, and says so", () => {
    // Three installs: two dangling lines.
    const corrupted = legacyInstall(
      legacyInstall(legacyInstall(USER_CONFIG, SERVER), SERVER),
      SERVER
    );
    const path = scratch(corrupted);
    const result = registerCodexMcpServer({ configPath: path, server: SERVER });

    expect(result).toMatchObject({ status: "installed", repaired: true });
    const text = readFileSync(path, "utf8");
    expect(text.split("\n")).not.toContain('["-y", "@mnemo-ai/mcp"]');
    expect(headerCount(text)).toBe(1);
    expect(mnemosyneOf(path)).toEqual(WANTED);
    expect(withoutMnemosyne(text)).toEqual(parse(USER_CONFIG));
    expect(text.startsWith(USER_CONFIG)).toBe(true);
  });

  it("(c) does not touch a file that is invalid for any other reason", () => {
    const broken = `${USER_CONFIG}\n[oops\nvalue = 1\n`;
    const path = scratch(broken);
    const result = registerCodexMcpServer({ configPath: path, server: SERVER });

    expect(result.status).toBe("failed");
    expect(readFileSync(path, "utf8")).toBe(broken);
  });

  it("(c) does not guess at a corrupted file the leftover line does not fully explain", () => {
    // With an IPv6 URL the old regex also cut the env table in half, leaving the
    // tail of the URL and a MNEMO_KEY line with no table of their own.
    const v6 = { ...SERVER, url: "http://[::1]:3939" };
    const corrupted = legacyInstall(legacyInstall(USER_CONFIG, v6), v6);
    const path = scratch(corrupted);
    const result = registerCodexMcpServer({ configPath: path, server: v6 });

    expect(result.status).toBe("failed");
    expect(readFileSync(path, "utf8")).toBe(corrupted);
    // The parser quotes the offending lines; the key must not ride along.
    expect(JSON.stringify(result)).not.toContain("mns_live_");
  });

  it("(d) an IPv6 URL survives a first and a second install", () => {
    const v6 = { ...SERVER, url: "http://[::1]:3939" };
    const path = scratch(USER_CONFIG);
    expect(registerCodexMcpServer({ configPath: path, server: v6 }).status).toBe("installed");
    expect(registerCodexMcpServer({ configPath: path, server: v6 }).status).toBe(
      "already-installed"
    );
    const rotated = { ...v6, key: "mns_live_SECONDKEY" };
    expect(registerCodexMcpServer({ configPath: path, server: rotated }).status).toBe("installed");

    const text = readFileSync(path, "utf8");
    expect(headerCount(text)).toBe(1);
    expect(mnemosyneOf(path)).toEqual({
      ...WANTED,
      env: { MNEMO_URL: "http://[::1]:3939", MNEMO_KEY: "mns_live_SECONDKEY" },
    });
    expect(withoutMnemosyne(text)).toEqual(parse(USER_CONFIG));
  });

  it("(e) keeps every comment the user wrote, across two installs", () => {
    const path = scratch(USER_CONFIG);
    registerCodexMcpServer({ configPath: path, server: SERVER });
    registerCodexMcpServer({ configPath: path, server: { ...SERVER, key: "mns_live_SECONDKEY" } });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# my codex config — do not lose this");
    expect(text).toContain('model = "gpt-5" # the good one');
    expect(text).toContain("# the other server I use\n[mcp_servers.other]");
  });

  it("narrows a config that was world-readable, since it now holds the key", () => {
    const path = scratch(USER_CONFIG, 0o644);
    registerCodexMcpServer({ configPath: path, server: SERVER });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses a mnemosyne entry it cannot edit without rewriting the user's file", () => {
    for (const shape of [
      'mcp_servers = { mnemosyne = { command = "old" } }\n',
      'mcp_servers.mnemosyne.command = "old"\n',
      '[mcp_servers]\nmnemosyne = { command = "old" }\n',
    ]) {
      const path = scratch(shape);
      const result = registerCodexMcpServer({ configPath: path, server: SERVER });
      expect(result.status, shape).toBe("failed");
      expect(readFileSync(path, "utf8"), shape).toBe(shape);
    }
  });

  it("is not fooled by a header-looking line inside a multi-line value", () => {
    // The line scanner would end the mnemosyne table at `[mcp_servers.other]`
    // inside the string. Whatever it does, the user's value must come out equal
    // or the file must be left alone.
    const original =
      '[mcp_servers.mnemosyne]\ncommand = "old"\nnote = """\n[mcp_servers.other]\n"""\n\n[keep]\nvalue = 1\n';
    const path = scratch(original);
    const result = registerCodexMcpServer({ configPath: path, server: SERVER });
    const text = readFileSync(path, "utf8");
    if (result.status === "failed") {
      expect(text).toBe(original);
    } else {
      expect(mnemosyneOf(path)).toEqual(WANTED);
      expect(withoutMnemosyne(text)).toEqual({ keep: { value: 1 } });
    }
  });

  // Round 2: a dotfiles-managed config is the user's own setup — the target is
  // written (atomically, 0600) and the link kept. Only a link with nothing
  // behind it is refused. secret-config-writes.test.ts covers the followed case.
  it("refuses a dangling symlink and creates nothing behind it", () => {
    const path = scratch();
    const real = join(path, "..", "dotfiles.toml");
    symlinkSync(real, path);
    expect(registerCodexMcpServer({ configPath: path, server: SERVER }).status).toBe("failed");
    expect(existsSync(real)).toBe(false);
  });

  it("leaves no temporary file behind", () => {
    const path = scratch(USER_CONFIG);
    registerCodexMcpServer({ configPath: path, server: SERVER });
    expect(existsSync(join(path, "..", `.config.toml.mnemo-${process.pid}.tmp`))).toBe(false);
  });
});
