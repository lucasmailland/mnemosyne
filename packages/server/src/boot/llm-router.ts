/**
 * MNEMO_LLM_<TASK>_PROVIDER / _MODEL / _API_KEY — a completion provider per
 * engine task, built on @mnemo-ai/llm-providers' LLMRouter.
 *
 * Every completion the engine makes declares a task (LLMInput.task):
 *   judge     conflict classification, recall rerank, reminder conditions
 *   summary   session collapse, capture extraction, compression
 *   prefilter HyDE and anticipation queries, before retrieval
 *   default   replay query generation, warm-up and health checks
 * A task without its own variables runs on MNEMO_LLM_PROVIDER, so with none of
 * them set the server builds no router and behaves exactly as before.
 * Embeddings already have their own provider (MNEMO_EMBED_*), so there is no
 * MNEMO_LLM_EMBED_*.
 *
 * llm-providers is an optional peer dep, so the caller hands in the module it
 * already imported; this file only takes types from it.
 */
import type {
  CompleteRequest,
  CompletionTask,
  CreatedProvider,
  LLMProvider,
} from "@mnemo-ai/llm-providers";
import { providerRequiresApiKey } from "./embed-provider.js";

export type RoutedTask = Exclude<CompletionTask, "default">;
export const ROUTED_TASKS: readonly RoutedTask[] = ["judge", "summary", "prefilter"];

export interface LlmTaskRoute {
  provider: string;
  apiKey?: string;
  baseURL?: string;
  /** Unset = the provider's own default completion model. */
  model?: string;
}

export type LlmTaskRoutes = Partial<Record<RoutedTask, LlmTaskRoute>>;

/**
 * The route that answers `task`, or undefined for the default provider: the
 * same choice LLMRouter.complete makes (no task, `default` or an unrouted task
 * go to the default). Both the router wiring and the locality of each task
 * (boot/sensitive-egress.ts) read it, so they cannot disagree.
 */
export function routeFor(
  task: CompletionTask | undefined,
  routes: LlmTaskRoutes
): LlmTaskRoute | undefined {
  return task === undefined || task === "default" ? undefined : routes[task];
}

/**
 * The per-task routes the environment asks for, {} when it asks for none.
 * Throws on a route that cannot work, so a typo does not silently send the
 * task to the default provider.
 */
export function parseLlmTaskRoutes(env: Record<string, string | undefined>): LlmTaskRoutes {
  const read = (name: string): string | undefined => env[name]?.trim() || undefined;
  const defaultProvider = read("MNEMO_LLM_PROVIDER");
  const routes: LlmTaskRoutes = {};
  for (const task of ROUTED_TASKS) {
    const prefix = `MNEMO_LLM_${task.toUpperCase()}_`;
    const provider = read(`${prefix}PROVIDER`);
    const model = read(`${prefix}MODEL`);
    const apiKey = read(`${prefix}API_KEY`);
    if (!provider && !model && !apiKey) continue;
    if (!defaultProvider) {
      throw new Error(
        `${prefix}* needs MNEMO_LLM_PROVIDER, the provider for every task without its own`
      );
    }
    const name = provider ?? defaultProvider;
    // The default's key, base URL and model belong to its vendor: another
    // vendor never receives them.
    const sameVendor = name.toLowerCase() === defaultProvider.toLowerCase();
    const key = apiKey ?? (sameVendor ? read("MNEMO_LLM_API_KEY") : undefined);
    if (!key && providerRequiresApiKey(name)) {
      throw new Error(`${prefix}API_KEY is required for provider "${name}"`);
    }
    const baseURL = sameVendor ? read("MNEMO_LLM_BASE_URL") : undefined;
    const taskModel = model ?? (sameVendor ? read("MNEMO_LLM_MODEL") : undefined);
    routes[task] = {
      provider: name,
      ...(key ? { apiKey: key } : {}),
      ...(baseURL ? { baseURL } : {}),
      ...(taskModel ? { model: taskModel } : {}),
    };
  }
  return routes;
}

/**
 * Point `provider.complete` at an LLMRouter, in place, so every holder of the
 * provider (the collapse adapter, consolidation, the daily budget applied
 * after this) routes by task. A per-task provider answers with its own model:
 * the model in the request was picked for the default provider. Returns the
 * provider and model each routed task uses, [] when nothing is routed (the
 * provider is then left untouched).
 */
export function applyLlmTaskRouting(
  mod: Pick<typeof import("@mnemo-ai/llm-providers"), "createProvider" | "LLMRouter">,
  provider: CreatedProvider,
  routes: LlmTaskRoutes,
  extra: { numThread?: number } = {}
): Array<{ task: RoutedTask; provider: string; model?: string }> {
  const tasks = ROUTED_TASKS.filter((t) => routeFor(t, routes));
  if (tasks.length === 0) return [];

  const asSlot = (p: CreatedProvider, ownModel: boolean): LLMProvider => ({
    name: p.name,
    capabilities: p.capabilities,
    ...(p.complete
      ? {
          complete: ownModel
            ? ({ model: _callerModel, ...rest }: CompleteRequest) => p.complete!(rest)
            : p.complete,
        }
      : {}),
  });

  const perTask: Partial<Record<RoutedTask, LLMProvider>> = {};
  const summary: Array<{ task: RoutedTask; provider: string; model?: string }> = [];
  for (const task of tasks) {
    const route = routeFor(task, routes)!;
    const created = mod.createProvider({
      provider: route.provider,
      ...(route.apiKey ? { apiKey: route.apiKey } : {}),
      ...(route.baseURL ? { baseURL: route.baseURL } : {}),
      ...(route.model ? { model: route.model } : {}),
      ...extra,
    });
    perTask[task] = asSlot(created, true);
    summary.push({
      task,
      provider: created.name,
      ...(created.defaultCompleteModel ? { model: created.defaultCompleteModel } : {}),
    });
  }

  const router = new mod.LLMRouter({ default: asSlot(provider, false), perTask });
  provider.complete = (req) => router.complete(req);
  return summary;
}
