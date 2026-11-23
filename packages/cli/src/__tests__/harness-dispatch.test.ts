import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ harness: vi.fn(), project: vi.fn() }));
vi.mock("../commands.js", () => ({
  COMMANDS: { harness: calls.harness },
  getCmdHelp: () => "",
  setGlobalWorkspaceId: vi.fn(),
}));
vi.mock("../project-config.js", () => ({ findProjectConfig: calls.project }));
import { main } from "../index.js";

const argv = process.argv;
beforeEach(() => {
  calls.harness.mockReset();
  calls.project.mockReset().mockReturnValue(null);
  for (const name of ["MNEMO_URL", "MNEMO_KEY", "MNEMO_WORKSPACE_ID"]) vi.stubEnv(name, undefined);
});
afterEach(() => {
  process.argv = argv;
  vi.unstubAllEnvs();
});

it.each(["flag", "env", "project"])(
  "forwards %s workspace selection into harness lifecycle dispatch",
  async (selection) => {
    const workspaceId = "00000000-0000-4000-8000-000000000456";
    calls.project.mockReturnValue({
      path: "/project/.mnemo.json",
      config: { workspaceId: "project" },
    });
    vi.stubEnv("MNEMO_URL", "https://memory.test");
    vi.stubEnv("MNEMO_KEY", "test-key");
    vi.stubEnv("MNEMO_WORKSPACE_ID", selection === "env" ? workspaceId : undefined);
    if (selection === "project")
      calls.project.mockReturnValue({ path: "/project/.mnemo.json", config: { workspaceId } });
    process.argv = [
      "node",
      "mnemo",
      ...(selection === "flag" ? ["--workspace", workspaceId] : []),
      "harness",
      "quiesce",
      "--yes",
    ];
    await main();
    expect(calls.harness).toHaveBeenCalledWith(
      ["quiesce", "--yes"],
      expect.objectContaining({
        workspaceId,
        url: "https://memory.test",
        apiKey: "test-key",
      })
    );
  }
);

it("still dispatches host hooks without server configuration", async () => {
  process.argv = ["node", "mnemo", "harness", "hook", "claude-code", "Stop"];
  await main();
  expect(calls.harness).toHaveBeenCalledWith(["hook", "claude-code", "Stop"], expect.any(Object));
  expect(calls.harness.mock.calls[0]![1].url).toBeUndefined();
  expect(calls.harness.mock.calls[0]![1].apiKey).toBeUndefined();
});
