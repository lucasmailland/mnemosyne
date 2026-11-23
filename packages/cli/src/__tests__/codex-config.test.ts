/**
 * The documents here are the bug report, not hypotheticals: each one was run
 * through the old regex reader and produced the wrong verdict.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enableCodexHooks, readCodexHooksGate } from "../codex-config.js";
import { resolveHostConfig } from "../harness-install.js";

/** The reader the parser replaced, kept only to prove these cases were real. */
const legacyRegexReader = (toml: string): boolean =>
  /^\s*hooks\s*=\s*true/m.test(toml.split("[features]")[1] ?? "");

describe("reading the features.hooks gate", () => {
  const cases: Array<{ name: string; toml: string; enabled: boolean }> = [
    { name: "the plain enabled form", toml: "[features]\nhooks = true\n", enabled: true },
    { name: "absent entirely", toml: "", enabled: false },
    { name: "a features table without hooks", toml: "[features]\nother = true\n", enabled: false },
    { name: "explicitly disabled", toml: "[features]\nhooks = false\n", enabled: false },
    { name: "commented out", toml: "[features]\n# hooks = true\n", enabled: false },
    {
      name: "B1: hooks belongs to a NESTED table, not features",
      toml: "[features]\nother = true\n\n[features.experimental]\nhooks = true\n",
      enabled: false,
    },
    {
      name: "B1: hooks belongs to an unrelated later table",
      toml: "[features]\nother = true\n\n[experimental]\nhooks = true\n",
      enabled: false,
    },
    {
      name: "B1: the inline-table form has no [features] header at all",
      toml: "features = { hooks = true }\n",
      enabled: true,
    },
    { name: "the dotted-key form", toml: "features.hooks = true\n", enabled: true },
    {
      name: "a string, which Codex does not read as enablement",
      toml: '[features]\nhooks = "true"\n',
      enabled: false,
    },
    { name: "an integer, likewise", toml: "[features]\nhooks = 1\n", enabled: false },
    { name: "features is not a table", toml: 'features = "on"\n', enabled: false },
  ];

  for (const { name, toml, enabled } of cases) {
    it(`${name} → ${enabled}`, () => {
      expect(readCodexHooksGate(toml)).toEqual({ status: "read", enabled });
    });
  }

  it("disagrees with the regex reader on exactly the shapes that were bugs", () => {
    const disagreements = cases
      .filter(({ toml, enabled }) => legacyRegexReader(toml) !== enabled)
      .map(({ name }) => name);
    expect(disagreements.sort()).toEqual([
      "B1: hooks belongs to a NESTED table, not features",
      "B1: hooks belongs to an unrelated later table",
      "B1: the inline-table form has no [features] header at all",
      "the dotted-key form",
    ]);
  });
});

describe("unreadable is not the same answer as disabled", () => {
  it("reports malformed TOML as malformed, never as enabled: false", () => {
    const result = readCodexHooksGate("[features\nhooks = true\n");
    expect(result.status).toBe("malformed");
    if (result.status === "malformed") expect(result.reason.length).toBeGreaterThan(0);
  });

  it("reports a duplicate table as malformed rather than picking one", () => {
    const result = readCodexHooksGate("[features]\nhooks = true\n\n[features]\nhooks = false\n");
    expect(result.status).toBe("malformed");
  });
});

describe("enabling features.hooks without rewriting the rest of the file", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function withConfig(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mnemo-codex-"));
    dirs.push(dir);
    const path = join(dir, "config.toml");
    writeFileSync(path, contents);
    return path;
  }

  it("replaces the value in place, keeping indentation and the trailing comment", () => {
    const path = withConfig(
      '# my codex config\nmodel = "gpt-5"\n\n[features]\n  hooks = false  # off for now\n  other = true\n'
    );
    expect(enableCodexHooks({ configPath: path })).toMatchObject({ status: "installed" });
    expect(readFileSync(path, "utf8")).toBe(
      '# my codex config\nmodel = "gpt-5"\n\n[features]\n  hooks = true  # off for now\n  other = true\n'
    );
  });

  it("inserts the key when [features] exists without it", () => {
    const path = withConfig('[features]\nother = true\n\n[other]\nkeep = "me"\n');
    expect(enableCodexHooks({ configPath: path })).toMatchObject({ status: "installed" });
    expect(readFileSync(path, "utf8")).toBe(
      '[features]\nhooks = true\nother = true\n\n[other]\nkeep = "me"\n'
    );
  });

  it("appends a table when there is no features table at all", () => {
    const path = withConfig('model = "gpt-5"\n');
    expect(enableCodexHooks({ configPath: path })).toMatchObject({ status: "installed" });
    expect(readFileSync(path, "utf8")).toBe('model = "gpt-5"\n\n[features]\nhooks = true\n');
  });

  it("appends after a nested table without capturing its keys", () => {
    // `[features.experimental]` is a different table; appending `[features]` last
    // must not swallow the keys that belong to it.
    const path = withConfig("[features.experimental]\nhooks = true\n");
    expect(enableCodexHooks({ configPath: path })).toMatchObject({ status: "installed" });
    const after = readCodexHooksGate(readFileSync(path, "utf8"));
    expect(after).toEqual({ status: "read", enabled: true });
  });

  it("reports an already-enabled config without touching it", () => {
    const path = withConfig("[features]\nhooks = true\n");
    const before = readFileSync(path, "utf8");
    expect(enableCodexHooks({ configPath: path })).toMatchObject({ status: "already-installed" });
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("the refusal set is explicit, and refusing writes nothing", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function withConfig(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mnemo-codex-refuse-"));
    dirs.push(dir);
    const path = join(dir, "config.toml");
    writeFileSync(path, contents);
    return path;
  }

  it.each([
    ["the dotted-key form", "features.hooks = false\n", /declared as a dotted key/],
    ["the inline-table form", "features = { hooks = false }\n", /declared as an inline table/],
    ["malformed TOML", "[features\nhooks = false\n", /malformed/],
  ])("refuses %s and leaves the file byte-identical", (_name, contents, reason) => {
    const path = withConfig(contents);
    const before = readFileSync(path, "utf8");
    const result = enableCodexHooks({ configPath: path });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toMatch(reason);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses a config it cannot read at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "mnemo-codex-missing-"));
    dirs.push(dir);
    const result = enableCodexHooks({ configPath: join(dir, "config.toml") });
    expect(result).toMatchObject({ status: "failed", reason: "config could not be read" });
  });
});

describe("no stringify round-trip", () => {
  it("never reformats the document through smol-toml's stringifier", () => {
    // D8 rejects parse → mutate → stringify: it drops every comment and reorders
    // the file. This is a source assertion because the property is structural —
    // a behavioural test would only catch it on documents that happen to differ.
    const source = readFileSync(join(import.meta.dirname, "..", "codex-config.ts"), "utf8");
    // Match a CALL or an import, not the word — the header explains at length
    // why the round-trip is rejected, and that prose is not a violation.
    expect(source).not.toMatch(/(?<!JSON\.)stringify\s*\(/);
    expect(source).not.toMatch(/import\s*\{[^}]*\bstringify\b[^}]*\}\s*from\s*"smol-toml"/);
  });
});

describe("refusing shapes a line splice cannot make unique", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function withConfig(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mnemo-codex-dup-"));
    dirs.push(dir);
    const path = join(dir, "config.toml");
    writeFileSync(path, contents);
    return path;
  }

  it("refuses a [features] table declared twice", () => {
    // TOML forbids this, so the parse rejects it first — the point is that the
    // answer is a refusal with the file intact, never a guess at which one wins.
    const path = withConfig("[features]\nother = 1\n\n[features]\nhooks = false\n");
    const before = readFileSync(path, "utf8");
    expect(enableCodexHooks({ configPath: path }).status).toBe("failed");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("preserves an entire surrounding document byte for byte", () => {
    const path = withConfig(
      [
        "# leading comment",
        'model = "gpt-5"',
        "big = 9007199254740991",
        "when = 1979-05-27T07:32:00Z",
        "",
        "[mcp_servers.mnemosyne]",
        'command = "npx"',
        'args = ["-y", "@mnemo-ai/mcp"]  # trailing',
        "",
        "[features]",
        "hooks = false",
        "other = true",
        "",
        "[profiles.work]",
        'model = "gpt-5-codex"',
        "",
      ].join("\n")
    );
    const before = readFileSync(path, "utf8");
    expect(enableCodexHooks({ configPath: path })).toMatchObject({ status: "installed" });
    const after = readFileSync(path, "utf8");
    // Exactly one line differs, and it is the one we came to change. The date is
    // in there on purpose: smol-toml returns a `TomlDate`, and the "nothing else
    // moved" comparison has to handle it rather than throw on the document.
    const changed = after
      .split("\n")
      .map((line, i) => (line === before.split("\n")[i] ? null : [before.split("\n")[i], line]))
      .filter(Boolean);
    expect(changed).toEqual([["hooks = false", "hooks = true"]]);
  });
});

describe("resolving Codex's config, with the host-agnostic rules", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "mnemo-codex-resolve-"));
    dirs.push(dir);
    return dir;
  }

  it("reports an absent config rather than inventing one", () => {
    const dir = scratch();
    expect(resolveHostConfig({ candidates: [join(dir, "config.toml")] })).toMatchObject({
      status: "absent",
    });
  });

  it("refuses a symlinked config", () => {
    const dir = scratch();
    const real = join(dir, "real.toml");
    const link = join(dir, "config.toml");
    writeFileSync(real, "[features]\n");
    symlinkSync(real, link);
    expect(resolveHostConfig({ candidates: [link] })).toMatchObject({
      status: "unsafe",
      reason: "config is a symbolic link",
    });
  });

  it("does not treat a stray config.json as a competing candidate", () => {
    // The OLD installer left a config.json on many machines. Including it in the
    // candidate list would declare ambiguity on exactly the machines that had
    // already run this tool — Codex never reads it.
    const dir = scratch();
    writeFileSync(join(dir, "config.toml"), "[features]\nhooks = false\n");
    writeFileSync(join(dir, "config.json"), "{}");
    expect(resolveHostConfig({ candidates: [join(dir, "config.toml")] })).toMatchObject({
      status: "resolved",
      path: join(dir, "config.toml"),
    });
  });

  it("declares ambiguity when two real candidates share a directory", () => {
    const dir = scratch();
    writeFileSync(join(dir, "config.toml"), "");
    writeFileSync(join(dir, "config.toml.bak"), "");
    expect(
      resolveHostConfig({
        candidates: [join(dir, "config.toml"), join(dir, "config.toml.bak")],
      })
    ).toMatchObject({ status: "ambiguous" });
  });
});
