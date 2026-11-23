/**
 * @mnemo-ai/llm-providers — public entry point.
 *
 * Consumers import everything from "@mnemo-ai/llm-providers". Deep
 * imports like "@mnemo-ai/llm-providers/openai" are intentionally NOT
 * supported — keeping a single entry point lets us reorganize internals
 * without breaking semver.
 */

// Types & contract
export type {
  LLMProvider,
  LLMCapabilities,
  EmbedRequest,
  EmbedResponse,
  CompleteRequest,
  CompleteResponse,
  ProviderConfig,
} from "./types.js";

// Errors
export {
  LLMProviderError,
  RateLimitedError,
  ContextOverflowError,
  BudgetExceededError,
  CapabilityNotSupportedError,
} from "./errors.js";

// Pricing (exposed so consumers can override / read rates for their own dashboards)
export {
  PRICING,
  estimateEmbedCost,
  estimateCompleteCost,
  type ModelRate,
} from "./pricing.js";

// Providers
export { OpenAIProvider } from "./openai/index.js";
export { AnthropicProvider } from "./anthropic/index.js";
export { BedrockProvider } from "./bedrock/index.js";
export { GoogleProvider } from "./google/index.js";
export { CohereProvider } from "./cohere/index.js";
export { MistralProvider } from "./mistral/index.js";
export { VoyageProvider } from "./voyage/index.js";
export { OllamaProvider } from "./ollama/index.js";

// Router + Budget
export { LLMRouter, type LLMRouterConfig, type CompletionTask } from "./router.js";
export { BudgetGuard, type BudgetGuardConfig } from "./budget.js";

// Factory — one-call provider construction by vendor name. Used by
// @mnemo-ai/server's boot path so the host only forwards a single
// (provider, apiKey) pair from env vars instead of picking a class.
export {
  createProvider,
  type ProviderName,
  type CreateProviderOptions,
  type CreatedProvider,
  type EmbedWithUsageResult,
} from "./factory.js";
