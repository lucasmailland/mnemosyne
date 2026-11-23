/**
 * MNEMO_SENSITIVE_TEXT_TO_PROVIDERS parsing and the "local provider" rule
 * (SECURITY.md §7): only an IP literal in loopback or a private range, or
 * `localhost`, counts as local; a host name resolves through DNS at request
 * time and counts as external.
 */
import { describe, it, expect } from "vitest";
import {
  isLocalProvider,
  localLlmTasks,
  parseSensitiveTextPolicy,
} from "../boot/sensitive-egress.js";
import { LLMRouter, type CreatedProvider } from "@mnemo-ai/llm-providers";
import { applyLlmTaskRouting, parseLlmTaskRoutes } from "../boot/llm-router.js";
import { consolidationDekUnwrapper } from "../boot/consolidation.js";
import { buildWorkspaceLlmAdapter } from "../config/WorkspaceLlmAdapter.js";

describe("parseSensitiveTextPolicy", () => {
  it("defaults to embed, the behaviour before the variable existed", () => {
    expect(parseSensitiveTextPolicy({})).toBe("embed");
    expect(parseSensitiveTextPolicy({ MNEMO_SENSITIVE_TEXT_TO_PROVIDERS: " " })).toBe("embed");
  });

  it.each(["none", "embed", "all"])("accepts %s", (v) => {
    expect(parseSensitiveTextPolicy({ MNEMO_SENSITIVE_TEXT_TO_PROVIDERS: v })).toBe(v);
  });

  it("refuses anything else, so a typo cannot widen egress silently", () => {
    expect(() => parseSensitiveTextPolicy({ MNEMO_SENSITIVE_TEXT_TO_PROVIDERS: "ALL" })).toThrow(
      /none, embed or all/
    );
    expect(() => parseSensitiveTextPolicy({ MNEMO_SENSITIVE_TEXT_TO_PROVIDERS: "off" })).toThrow();
  });
});

describe("isLocalProvider", () => {
  it.each([
    ["ollama", undefined],
    ["ollama", "http://localhost:11434"],
    ["openai", "http://127.0.0.1:8000/v1"],
    ["openai", "http://127.1:8000/v1"],
    ["openai", "http://10.2.3.4:8000/v1"],
    ["openai", "http://172.20.0.5:8000/v1"],
    ["openai", "http://192.168.1.20:8000/v1"],
    ["openai", "http://[::1]:8000/v1"],
    ["openai", "http://[fd12:3456::7]:8000/v1"],
  ])("%s at %s is local", (provider, url) => {
    expect(isLocalProvider(provider, url)).toBe(true);
  });

  it.each([
    ["openai", undefined],
    ["anthropic", undefined],
    ["nvidia", undefined],
    // Bedrock ignores the base URL and always calls AWS.
    ["bedrock", "http://127.0.0.1:9000"],
    // Ollama pointed at a host name: DNS decides where it goes.
    ["ollama", "http://ollama:11434"],
    ["ollama", "https://ollama.com"],
    ["openai", "http://127.0.0.1.nip.io:8000/v1"],
    ["openai", "http://localhost.acme.example/v1"],
    // Link-local (cloud metadata), CGNAT and public addresses are not the operator's network.
    ["openai", "http://169.254.169.254/v1"],
    ["openai", "http://100.64.0.1/v1"],
    ["openai", "http://8.8.8.8/v1"],
    ["openai", "http://172.32.0.1/v1"],
    ["openai", "not a url"],
  ])("%s at %s is external", (provider, url) => {
    expect(isLocalProvider(provider, url)).toBe(false);
  });
});

const defaultOf = (env: Record<string, string>) =>
  env.MNEMO_LLM_PROVIDER
    ? {
        provider: env.MNEMO_LLM_PROVIDER,
        ...(env.MNEMO_LLM_BASE_URL ? { baseURL: env.MNEMO_LLM_BASE_URL } : {}),
      }
    : undefined;
const tasksFor = (env: Record<string, string>) =>
  localLlmTasks(defaultOf(env), parseLlmTaskRoutes(env));

describe("localLlmTasks", () => {
  it("no completion provider: nothing is local", () => {
    expect(tasksFor({})).toEqual([]);
  });

  it("a local default provider makes every task local", () => {
    expect(tasksFor({ MNEMO_LLM_PROVIDER: "ollama" })).toEqual([
      "judge",
      "summary",
      "prefilter",
      "default",
    ]);
  });

  it("a per-task route to an external vendor takes that task out", () => {
    expect(
      tasksFor({
        MNEMO_LLM_PROVIDER: "ollama",
        MNEMO_LLM_JUDGE_PROVIDER: "anthropic",
        MNEMO_LLM_JUDGE_API_KEY: "sk-test",
      })
    ).toEqual(["summary", "prefilter", "default"]);
  });

  it("a per-task route to a local server puts that task in", () => {
    expect(
      tasksFor({
        MNEMO_LLM_PROVIDER: "openai",
        MNEMO_LLM_API_KEY: "sk-test",
        MNEMO_LLM_JUDGE_PROVIDER: "ollama",
      })
    ).toEqual(["judge"]);
  });

  it("the default's base URL applies to a same-vendor route, as the router passes it", () => {
    expect(
      tasksFor({
        MNEMO_LLM_PROVIDER: "openai",
        MNEMO_LLM_API_KEY: "sk-test",
        MNEMO_LLM_BASE_URL: "http://10.0.0.8:8000/v1",
        MNEMO_LLM_SUMMARY_MODEL: "llama-3.1-8b",
      })
    ).toEqual(["judge", "summary", "prefilter", "default"]);
  });
});

// The locality of each task must be the locality of the provider the router
// really calls for it: build the router with providers that remember the
// options they were created with, send one completion per task, and compare.
describe("localLlmTasks agrees with the wired LLMRouter", () => {
  const ENVS: Array<Record<string, string>> = [
    { MNEMO_LLM_PROVIDER: "ollama" },
    {
      MNEMO_LLM_PROVIDER: "ollama",
      MNEMO_LLM_JUDGE_PROVIDER: "openai",
      MNEMO_LLM_JUDGE_API_KEY: "k",
    },
    { MNEMO_LLM_PROVIDER: "openai", MNEMO_LLM_API_KEY: "k", MNEMO_LLM_SUMMARY_PROVIDER: "ollama" },
    {
      MNEMO_LLM_PROVIDER: "openai",
      MNEMO_LLM_API_KEY: "k",
      MNEMO_LLM_BASE_URL: "http://127.0.0.1:8000/v1",
      MNEMO_LLM_PREFILTER_PROVIDER: "anthropic",
      MNEMO_LLM_PREFILTER_API_KEY: "k",
    },
    { MNEMO_LLM_PROVIDER: "bedrock", MNEMO_LLM_API_KEY: "k", MNEMO_LLM_JUDGE_PROVIDER: "ollama" },
  ];

  it.each(ENVS)("%o", async (env) => {
    type Opts = { provider: string; baseURL?: string };
    const make = (opts: Opts): CreatedProvider =>
      ({
        name: opts.provider,
        capabilities: { embed: false, complete: true, streaming: false, jsonMode: false },
        complete: async () => ({
          text: JSON.stringify(opts),
          tokensIn: 1,
          tokensOut: 1,
          model: "m",
          provider: opts.provider,
        }),
      }) as unknown as CreatedProvider;
    const def = defaultOf(env)!;
    const provider = make(def);
    const routes = parseLlmTaskRoutes(env);
    applyLlmTaskRouting(
      { createProvider: (o: Opts) => make(o), LLMRouter } as never,
      provider,
      routes
    );
    const local = localLlmTasks(def, routes);
    for (const task of ["judge", "summary", "prefilter", "default"] as const) {
      const answered = JSON.parse((await provider.complete!({ prompt: "p", task })).text) as Opts;
      expect(local.includes(task), task).toBe(isLocalProvider(answered.provider, answered.baseURL));
    }
  });
});

describe("consolidationDekUnwrapper", () => {
  const unwrap = () => Buffer.alloc(32);
  const localJudge = { localTasks: ["judge"] } as never;
  const localSummary = { localTasks: ["summary"] } as never;
  const localAll = { localTasks: ["judge", "summary", "prefilter", "default"] } as never;

  it.each([
    ["unset", undefined, undefined, false],
    ["embed", "embed", undefined, false],
    ["none", "none", undefined, false],
    ["all", "all", undefined, true],
    // A local judge alone is not enough: another consolidation task could
    // send the opened text to an external model.
    ["none, local judge only", "none", localJudge, false],
    ["none, every task local", "none", localAll, true],
    ["embed, local summary only", "embed", localSummary, false],
  ] as const)("%s", (_n, policy, boot, opens) => {
    expect(consolidationDekUnwrapper(policy, boot, unwrap) === unwrap).toBe(opens);
  });
});

describe("a workspace's own provider is never local", () => {
  const bootAdapter = {
    id: "boot",
    model: "m",
    localTasks: ["judge", "summary", "prefilter", "default"],
  } as never;
  const provider = {
    // A workspace pointed it at a loopback address and even claims to be local.
    baseURL: "http://127.0.0.1:11434",
    localTasks: ["judge"],
    complete: async () => ({ text: "x", tokensIn: 1, tokensOut: 1, model: "m", provider: "p" }),
  };

  it.each(["workspace", "global"] as const)("source %s: no localTasks", async (source) => {
    const resolver = { resolve: async () => ({ provider, source }) } as never;
    const adapter = await buildWorkspaceLlmAdapter("ws-1", resolver, bootAdapter);
    expect(adapter).not.toBe(bootAdapter);
    expect(adapter?.localTasks).toBeUndefined();
  });

  it("source env: the server's own adapter, with its locality", async () => {
    const resolver = { resolve: async () => ({ provider, source: "env" }) } as never;
    expect(await buildWorkspaceLlmAdapter("ws-1", resolver, bootAdapter)).toBe(bootAdapter);
  });
});
