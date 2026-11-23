import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keyFingerprint, readBinding, resolveBinding } from "../binding.js";

const roots: string[] = [];

function temporaryHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mnemo-harness-test-")));
  roots.push(home);
  return home;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const BINDING = {
  serverUrl: "https://memory.example.com/",
  workspaceId: "workspace-a",
  apiKey: "mns_live_supersecretkeyvalue0001",
};

describe("harness binding", () => {
  it("records where capture is bound before anything is captured", async () => {
    const home = temporaryHome();
    const result = await resolveBinding(BINDING, { home });

    expect(result).toMatchObject({ status: "bound", changed: false });
    const stored = await readBinding({ home });
    expect(stored).toMatchObject({
      // Normalized, so the same server reached two ways is one binding.
      serverUrl: "https://memory.example.com",
      workspaceId: "workspace-a",
    });
    expect(stored!.installationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("never writes the API key, only a fingerprint of it", async () => {
    const home = temporaryHome();
    await resolveBinding(BINDING, { home });

    const stored = await readBinding({ home });
    expect(stored!.keyFingerprint).toBe(keyFingerprint(BINDING.apiKey));
    expect(stored!.keyFingerprint).not.toContain("supersecret");

    // Belt and braces: the secret must not appear anywhere in the file.
    const raw = readFileSync(join(home, ".mnemo", "harness", "state", "binding.json"), "utf8");
    expect(raw).not.toContain(BINDING.apiKey);
    expect(raw).not.toContain("supersecret");
  });

  it("keeps the same installation identity across restarts", async () => {
    const home = temporaryHome();
    const first = await resolveBinding(BINDING, { home });
    const second = await resolveBinding(BINDING, { home });

    expect(second).toMatchObject({ status: "bound", changed: false });
    expect(second.binding.installationId).toBe(first.binding.installationId);
  });

  it("treats equivalent URLs as the same binding rather than a rebind", async () => {
    const home = temporaryHome();
    await resolveBinding(BINDING, { home });

    const again = await resolveBinding(
      { ...BINDING, serverUrl: "https://memory.example.com:443//" },
      { home }
    );
    expect(again.changed).toBe(false);
  });

  for (const [label, override] of [
    ["server", { serverUrl: "https://other.example.com" }],
    ["workspace", { workspaceId: "workspace-b" }],
    ["key", { apiKey: "mns_live_adifferentkeyvalue000002" }],
  ] as const) {
    it(`reports a changed binding when the ${label} changes`, async () => {
      const home = temporaryHome();
      const first = await resolveBinding(BINDING, { home });

      const rebound = await resolveBinding({ ...BINDING, ...override }, { home });

      expect(rebound).toMatchObject({ status: "rebound", changed: true });
      // Queued events belong to the old binding; the caller has to decide, so the
      // previous binding is reported rather than silently overwritten.
      expect(rebound.previous).toMatchObject({ workspaceId: first.binding.workspaceId });
      // A rebind is a new installation: the old identity must not follow the queue
      // to a different server.
      expect(rebound.binding.installationId).not.toBe(first.binding.installationId);
    });
  }

  it("rejects a binding with no server or workspace instead of writing a useless one", async () => {
    const home = temporaryHome();
    for (const bad of [
      { ...BINDING, serverUrl: "" },
      { ...BINDING, workspaceId: "" },
      { ...BINDING, apiKey: "" },
      { ...BINDING, serverUrl: "not a url" },
    ]) {
      await expect(resolveBinding(bad, { home })).rejects.toThrow();
    }
    expect(await readBinding({ home })).toBeNull();
  });

  it("reports no binding at all before the first resolve", async () => {
    expect(await readBinding({ home: temporaryHome() })).toBeNull();
  });

  it("treats an unreadable binding as absent rather than crashing capture", async () => {
    const home = temporaryHome();
    await resolveBinding(BINDING, { home });
    writeFileSync(join(home, ".mnemo", "harness", "state", "binding.json"), "{not json", {
      mode: 0o600,
    });

    // A corrupt binding must not wedge the host; it rebinds on the next resolve.
    expect(await readBinding({ home })).toBeNull();
    expect((await resolveBinding(BINDING, { home })).status).toBe("bound");
  });
});
