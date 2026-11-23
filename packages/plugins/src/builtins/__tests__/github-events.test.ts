import { describe, it, expect, vi } from "vitest";
import { handleGithubWebhook } from "../github-events.js";
import type { PluginContext } from "../../index.js";

function makeCtx() {
  const createEvent = vi.fn(async () => ({ id: "e-1" }));
  const createFact = vi.fn(async () => ({ id: "f-1" }));
  const ctx = {
    workspaceId: "ws", config: {},
    createEvent, createFact,
    log: { info: vi.fn() },
  } as unknown as PluginContext;
  return { ctx, createEvent, createFact };
}

describe("github-events handleGithubWebhook", () => {
  it("PR opened -> one event", async () => {
    const { ctx, createEvent } = makeCtx();
    await handleGithubWebhook(
      { "x-github-event": "pull_request" },
      { action: "opened", pull_request: { title: "Fix bug", html_url: "https://github.com/x/y/pull/1", number: 1, state: "open" } },
      ctx,
    );
    expect(createEvent).toHaveBeenCalledOnce();
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "github.pull_request" }));
  });

  it("issue opened -> event + fact", async () => {
    const { ctx, createEvent, createFact } = makeCtx();
    await handleGithubWebhook(
      { "x-github-event": "issues" },
      { action: "opened", issue: { title: "Bug report", html_url: "https://github.com/x/y/issues/2", number: 2, body: "It breaks" } },
      ctx,
    );
    expect(createEvent).toHaveBeenCalledOnce();
    expect(createFact).toHaveBeenCalledOnce();
    expect(createFact).toHaveBeenCalledWith(expect.objectContaining({ tags: expect.arrayContaining(["github", "issue"]) }));
  });

  it("unhandled X-GitHub-Event -> skip", async () => {
    const { ctx, createEvent } = makeCtx();
    await handleGithubWebhook({ "x-github-event": "push" }, {}, ctx);
    expect(createEvent).not.toHaveBeenCalled();
  });
});
