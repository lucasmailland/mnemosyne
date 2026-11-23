export { createWebhookNotifyPlugin } from "./webhook-notify.js";
export { createFeedbackLoopPlugin } from "./feedback-loop.js";
export { createGitVerifierPlugin } from "./git-verifier.js";
export { createCalendarSyncPlugin } from "./calendar-sync.js";
export { createSlackEventsPlugin, handleSlackEvent } from "./slack-events.js";
export { createGithubEventsPlugin, handleGithubWebhook } from "./github-events.js";
export { createOutlineSyncPlugin } from "./outline-sync.js";
export { createObsidianExportPlugin, exportVault } from "./obsidian-export.js";
export { createClaudeImportPlugin, importClaudeMemory } from "./claude-import.js";
export { createEventReactionsPlugin } from "./event-reactions.js";

import { createWebhookNotifyPlugin } from "./webhook-notify.js";
import { createFeedbackLoopPlugin } from "./feedback-loop.js";
import { createGitVerifierPlugin } from "./git-verifier.js";
import { createCalendarSyncPlugin } from "./calendar-sync.js";
import { createSlackEventsPlugin } from "./slack-events.js";
import { createGithubEventsPlugin } from "./github-events.js";
import { createOutlineSyncPlugin } from "./outline-sync.js";
import { createObsidianExportPlugin } from "./obsidian-export.js";
import { createClaudeImportPlugin } from "./claude-import.js";
import { createEventReactionsPlugin } from "./event-reactions.js";
import type { MnemoPlugin } from "../index.js";

export const BUILTIN_FACTORIES: Record<string, () => MnemoPlugin> = {
  "webhook-notify": createWebhookNotifyPlugin,
  "feedback-loop": createFeedbackLoopPlugin,
  "git-verifier": createGitVerifierPlugin,
  "calendar-sync": createCalendarSyncPlugin,
  "slack-events": createSlackEventsPlugin,
  "github-events": createGithubEventsPlugin,
  "outline-sync": createOutlineSyncPlugin,
  "obsidian-export": createObsidianExportPlugin,
  "claude-import": createClaudeImportPlugin,
  "event-reactions": createEventReactionsPlugin,
};
