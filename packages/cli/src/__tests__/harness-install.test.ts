import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installOpencodeCapture, resolveOpencodeConfig } from "../harness-install.js";

const roots: string[] = [];

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mnemo-install-")));
  roots.push(root);
  mkdirSync(join(root, "global"), { recursive: true });
  mkdirSync(join(root, "project"), { recursive: true });
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const read = (path: string) => readFileSync(path, "utf8");

describe("finding the config OpenCode actually loads", () => {
  it("prefers the project config over the global one", () => {
    const root = workspace();
    writeFileSync(join(root, "global", "opencode.json"), "{}");
    writeFileSync(join(root, "project", "opencode.json"), "{}");

    const resolved = resolveOpencodeConfig({
      candidates: [join(root, "project", "opencode.json"), join(root, "global", "opencode.json")],
    });

    expect(resolved).toMatchObject({
      status: "resolved",
      path: join(root, "project", "opencode.json"),
    });
  });

  it("picks the only file that exists", () => {
    const root = workspace();
    writeFileSync(join(root, "global", "opencode.jsonc"), "{}");

    expect(
      resolveOpencodeConfig({
        candidates: [
          join(root, "project", "opencode.json"),
          join(root, "global", "opencode.jsonc"),
        ],
      })
    ).toMatchObject({ status: "resolved" });
  });

  it("refuses when two configs compete in the same directory", () => {
    const root = workspace();
    writeFileSync(join(root, "project", "opencode.json"), "{}");
    writeFileSync(join(root, "project", "opencode.jsonc"), "{}");

    const resolved = resolveOpencodeConfig({
      candidates: [join(root, "project", "opencode.json"), join(root, "project", "opencode.jsonc")],
    });

    // Editing the wrong one silently does nothing; the user must disambiguate.
    expect(resolved.status).toBe("ambiguous");
  });

  it("refuses a config that is a symlink", () => {
    const root = workspace();
    const real = join(root, "global", "real.json");
    writeFileSync(real, "{}");
    const link = join(root, "project", "opencode.json");
    symlinkSync(real, link);

    // Following it would write outside the directory we checked.
    expect(resolveOpencodeConfig({ candidates: [link] }).status).toBe("unsafe");
  });

  it("reports when there is nothing to edit yet", () => {
    const root = workspace();
    expect(
      resolveOpencodeConfig({ candidates: [join(root, "project", "opencode.json")] })
    ).toMatchObject({ status: "absent" });
  });
});

describe("merging into the config without destroying it", () => {
  it("adds the plugin and leaves every unrelated key alone", () => {
    const root = workspace();
    const path = join(root, "project", "opencode.json");
    writeFileSync(
      path,
      JSON.stringify({ theme: "dark", model: "anthropic/claude", mcp: { some: "server" } }, null, 2)
    );

    const result = installOpencodeCapture({ configPath: path, pluginPath: "./mnemosyne.ts" });

    expect(result.status).toBe("installed");
    const after = JSON.parse(read(path));
    expect(after).toMatchObject({
      theme: "dark",
      model: "anthropic/claude",
      mcp: { some: "server" },
    });
    expect(after.plugin).toContain("./mnemosyne.ts");
  });

  it("preserves comments, which a parse-and-restringify would erase", () => {
    const root = workspace();
    const path = join(root, "project", "opencode.jsonc");
    const original = [
      "{",
      "  // the user explained this on purpose",
      '  "theme": "dark"',
      "}",
      "",
    ].join("\n");
    writeFileSync(path, original);

    installOpencodeCapture({ configPath: path, pluginPath: "./mnemosyne.ts" });

    expect(read(path)).toContain("the user explained this on purpose");
  });

  it("keeps plugins that were already installed", () => {
    const root = workspace();
    const path = join(root, "project", "opencode.json");
    writeFileSync(path, JSON.stringify({ plugin: ["./someone-elses.ts"] }, null, 2));

    installOpencodeCapture({ configPath: path, pluginPath: "./mnemosyne.ts" });

    const after = JSON.parse(read(path));
    expect(after.plugin).toEqual(expect.arrayContaining(["./someone-elses.ts", "./mnemosyne.ts"]));
  });

  it("is idempotent, so a re-run does not duplicate the entry", () => {
    const root = workspace();
    const path = join(root, "project", "opencode.json");
    writeFileSync(path, JSON.stringify({ plugin: ["./mnemosyne.ts"] }, null, 2));

    const result = installOpencodeCapture({ configPath: path, pluginPath: "./mnemosyne.ts" });

    expect(result.status).toBe("already-installed");
    expect(JSON.parse(read(path)).plugin).toEqual(["./mnemosyne.ts"]);
  });

  it("fails closed on a malformed config, writing nothing", () => {
    const root = workspace();
    const path = join(root, "project", "opencode.json");
    const before = '{ "theme": "dark", ';
    writeFileSync(path, before);

    const result = installOpencodeCapture({ configPath: path, pluginPath: "./mnemosyne.ts" });

    // Rewriting a file we could not parse would destroy whatever the user meant.
    expect(result.status).toBe("failed");
    expect(read(path)).toBe(before);
  });

  it("refuses a config whose plugin key is not a list", () => {
    const root = workspace();
    const path = join(root, "project", "opencode.json");
    const before = JSON.stringify({ plugin: "a-single-string" }, null, 2);
    writeFileSync(path, before);

    expect(installOpencodeCapture({ configPath: path, pluginPath: "./x.ts" }).status).toBe(
      "failed"
    );
    expect(read(path)).toBe(before);
  });

  it("leaves the original intact when the plugin path is unusable", () => {
    const root = workspace();
    const path = join(root, "project", "opencode.json");
    const before = JSON.stringify({ theme: "dark" }, null, 2);
    writeFileSync(path, before);

    const result = installOpencodeCapture({ configPath: path, pluginPath: " " });
    expect(result.status).toBe("failed");
    expect(read(path)).toBe(before);
  });
});
