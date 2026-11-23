import type { MnemoPlugin, PluginContext } from "../index.js";

interface GithubPullRequestPayload {
  action?: string;
  pull_request?: { title?: string; html_url?: string; number?: number; state?: string };
  repository?: { full_name?: string };
}

interface GithubIssuePayload {
  action?: string;
  issue?: { title?: string; html_url?: string; number?: number; body?: string };
  repository?: { full_name?: string };
}

type GithubWebhookHeaders = { "x-github-event"?: string } & Record<string, string | undefined>;

/** Handle a GitHub webhook payload, mapping supported events to memory primitives. */
export async function handleGithubWebhook(
  headers: GithubWebhookHeaders,
  body: GithubPullRequestPayload | GithubIssuePayload,
  ctx: PluginContext,
): Promise<void> {
  const eventType = headers["x-github-event"] ?? "unknown";

  if (eventType === "pull_request") {
    const pr = (body as GithubPullRequestPayload).pull_request;
    if (!pr) return;
    await ctx.createEvent({
      type: "github.pull_request",
      payload: { title: pr.title, url: pr.html_url, number: pr.number, state: pr.state, action: (body as GithubPullRequestPayload).action },
    });
  } else if (eventType === "issues") {
    const issue = (body as GithubIssuePayload).issue;
    if (!issue) return;
    const issueBody = body as GithubIssuePayload;
    if (issueBody.action === "opened") {
      await ctx.createEvent({
        type: "github.issue",
        payload: { title: issue.title, url: issue.html_url, number: issue.number, action: issueBody.action },
      });
      await ctx.createFact({
        content: `GitHub issue opened: ${issue.title} (${issue.html_url ?? "no url"})`,
        subject: issue.title ?? "github issue",
        tags: ["github", "issue"],
        metadata: { url: issue.html_url, number: issue.number, body: issue.body },
      });
    } else {
      await ctx.createEvent({
        type: "github.issue",
        payload: { title: issue.title, url: issue.html_url, number: issue.number, action: issueBody.action },
      });
    }
  } else {
    ctx.log?.info?.(`github-events: unhandled event type ${eventType}, skipping`);
  }
}

export function createGithubEventsPlugin(): MnemoPlugin {
  return {
    id: "github-events", name: "GitHub Events", version: "1.0.0",
    description: "Parse GitHub webhook payloads to tasks and events.",
  };
}
