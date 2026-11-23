// Structural wire type, kept local so public harness declarations remain free
// of the server domain package. Classification is shared via harness-runtime.
export type TurnOrigin =
  "human" | "agent_message" | "task_notification" | "pasted_content" | "assistant" | "unknown";
