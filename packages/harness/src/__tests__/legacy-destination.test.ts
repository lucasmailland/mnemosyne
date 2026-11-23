import { beforeEach, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("../fs-security.js", () => ({
  ensureSecureHarnessPaths: async () => ({ state: "/state", mnemoRoot: "/mnemo" }),
  withExclusiveFileLock: async (_paths: unknown, _name: string, operation: () => unknown) =>
    operation(),
  atomicWritePrivateFile: async (path: string, content: string) => {
    files.set(path, content);
  },
  readPrivateFile: async (path: string) => {
    if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return files.get(path);
  },
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  mkdir: async () => undefined,
  readdir: async () =>
    [...files.keys()]
      .filter((path) => path.startsWith("/state/"))
      .map((path) => path.slice("/state/".length)),
}));
import { captureLegacyHook, drainLegacySpools } from "../legacy-capture.js";

beforeEach(() => {
  files.clear();
  files.set(
    "/home/test/.mnemo/harness/capture/claude-code.json",
    JSON.stringify({ version: 1, host: "claude-code", mode: "user-only" })
  );
});

it.each(["replacement credential", "unbound old spool"])(
  "refuses ambiguous delivery for %s",
  async (scenario) => {
    const options = { home: "/home/test", url: "https://memory.test", apiKey: "workspace-A-key" };
    const payload = { session_id: "host-session", prompt: "private to workspace A" };
    await captureLegacyHook("UserPromptSubmit", payload, {
      ...options,
      request: async () => {
        throw new Error("offline");
      },
    });
    if (scenario === "unbound old spool") {
      const path = [...files.keys()].find((path) => path.startsWith("/state/legacy-"))!;
      const state = JSON.parse(files.get(path)!);
      delete state.destination.credentialFingerprint;
      files.set(path, JSON.stringify(state));
    }
    const request = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/start")
        ? Response.json({ id: "session" }, { status: 201 })
        : new Response(null, { status: 204 })
    );
    const destination = {
      ...options,
      request,
      apiKey: scenario === "replacement credential" ? "workspace-B-key" : options.apiKey,
    };
    expect(await captureLegacyHook("Stop", payload, destination)).toMatchObject({ pending: 1 });
    expect(await drainLegacySpools(destination)).toEqual({ delivered: 0, remaining: 1 });
    expect(request).not.toHaveBeenCalled();
    if (scenario === "replacement credential")
      expect(await drainLegacySpools({ ...options, request })).toEqual({
        delivered: 1,
        remaining: 0,
      });
  }
);
