/**
 * MNEMO_SENSITIVE_TEXT_TO_PROVIDERS, and which configured providers are local
 * (SECURITY.md §7).
 *
 * Confidential and restricted text is stored encrypted; this decides which
 * providers may still receive its plaintext. A provider the operator runs on
 * its own machine or private network is not egress and receives it under any
 * value.
 *
 * "Local" is read only from the operator's environment (MNEMO_LLM_*,
 * MNEMO_EMBED_*), never from provider settings stored through the API, and
 * only from what cannot be redirected after boot: an IP literal in loopback or
 * a private range, or `localhost` (RFC 6761: always loopback). Any other host
 * name, a Docker service name included, resolves through DNS at request time,
 * so it counts as external. Bedrock ignores the base URL and always calls AWS.
 */
import { BlockList, isIP } from "node:net";
import type { LLMTask, SensitiveTextPolicy } from "@mnemo-ai/types";
import { routeFor, type LlmTaskRoutes } from "./llm-router.js";

const POLICIES: readonly SensitiveTextPolicy[] = ["none", "embed", "all"];

/** Unset = "embed" (the behaviour before the variable existed). A typo is fatal. */
export function parseSensitiveTextPolicy(
  env: Record<string, string | undefined>
): SensitiveTextPolicy {
  const raw = env["MNEMO_SENSITIVE_TEXT_TO_PROVIDERS"]?.trim();
  if (!raw) return "embed";
  if ((POLICIES as readonly string[]).includes(raw)) return raw as SensitiveTextPolicy;
  throw new Error(`MNEMO_SENSITIVE_TEXT_TO_PROVIDERS must be none, embed or all (got "${raw}")`);
}

const PRIVATE_RANGES = new BlockList();
PRIVATE_RANGES.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_RANGES.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_RANGES.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_RANGES.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_RANGES.addAddress("::1", "ipv6");
PRIVATE_RANGES.addSubnet("fc00::", 7, "ipv6");

/** Whether `provider` with this base URL answers from the operator's own machine or network. */
export function isLocalProvider(provider: string, baseURL: string | undefined): boolean {
  const name = provider.trim().toLowerCase();
  if (name === "bedrock") return false;
  // Without a base URL only Ollama has a local default (http://localhost:11434).
  if (!baseURL) return name === "ollama";
  let host: string;
  try {
    host = new URL(baseURL).hostname;
  } catch {
    return false;
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost") return true;
  const family = isIP(host);
  if (family === 0) return false;
  return PRIVATE_RANGES.check(host, family === 4 ? "ipv4" : "ipv6");
}

const ALL_TASKS: readonly LLMTask[] = ["judge", "summary", "prefilter", "default"];

/**
 * The tasks the boot completion adapter answers from a local provider. Pass the
 * provider and base URL the default provider was created with and the routes
 * handed to applyLlmTaskRouting: each task is judged by the endpoint routeFor
 * picks, exactly as the router does. A completion without a task is never
 * local (sensitiveTextMayReachLlm).
 */
export function localLlmTasks(
  defaultEndpoint: { provider: string; baseURL?: string | undefined } | undefined,
  routes: LlmTaskRoutes
): LLMTask[] {
  if (!defaultEndpoint) return [];
  return ALL_TASKS.filter((task) => {
    const endpoint = routeFor(task, routes) ?? defaultEndpoint;
    return isLocalProvider(endpoint.provider, endpoint.baseURL);
  });
}
