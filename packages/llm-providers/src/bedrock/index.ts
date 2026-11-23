/**
 * AWS Bedrock provider — embeddings only.
 *
 * Supports two authentication modes:
 *   1. Bedrock API Key (recommended, simpler): pass `apiKey` — a base64-encoded
 *      token that starts with "ABSKQm..." and is sent as `Authorization: Bearer`
 *   2. AWS IAM credentials (legacy): pass `awsAccessKeyId` + `awsSecretAccessKey`
 *      — requires @aws-sdk/client-bedrock-runtime (peerDependency)
 *
 * Embed models supported:
 *   - amazon.titan-embed-text-v2:0 — 1024 dims (default)
 *   - cohere.embed-english-v3 via Bedrock — 1024 dims
 */

import type {
  LLMProvider,
  LLMCapabilities,
  EmbedRequest,
  EmbedResponse,
  CompleteRequest,
  CompleteResponse,
} from "../types.js";
import { LLMProviderError } from "../errors.js";

// 20k characters leaves room for Titan v2's 8,192-token limit even for dense text.
const TITAN_CHUNK_LENGTH = 20_000;

function titanChunks(text: string): string[] {
  if (text.length <= TITAN_CHUNK_LENGTH) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + TITAN_CHUNK_LENGTH, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > start) end = space + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

const TITAN_CHUNK_CONCURRENCY = 8;

async function embedTitanText(
  text: string,
  send: (chunk: string) => Promise<{ embedding: number[]; inputTextTokenCount?: number }>
): Promise<{ embedding: number[]; tokens: number }> {
  const chunks = titanChunks(text);
  if (chunks.length === 1) {
    const result = await send(text);
    return { embedding: result.embedding, tokens: result.inputTextTokenCount ?? 0 };
  }
  const sum: number[] = [];
  let tokens = 0;
  // In parallel batches: the caller's embed timeout covers the whole call, and
  // sequential requests for a long session transcript exceeded it in production.
  for (let start = 0; start < chunks.length; start += TITAN_CHUNK_CONCURRENCY) {
    const batch = chunks.slice(start, start + TITAN_CHUNK_CONCURRENCY);
    const results = await Promise.all(batch.map((chunk) => send(chunk)));
    results.forEach((result, index) => {
      const weight = batch[index]!.length;
      tokens += result.inputTextTokenCount ?? 0;
      result.embedding.forEach((value, i) => {
        sum[i] = (sum[i] ?? 0) + value * weight;
      });
    });
  }
  const magnitude = Math.hypot(...sum);
  return { embedding: magnitude ? sum.map((value) => value / magnitude) : sum, tokens };
}

export interface BedrockConfig {
  /** Bedrock API Key (base64 token) — simpler, no AWS SDK needed */
  apiKey?: string;
  /** AWS region. Defaults to us-east-1 */
  awsRegion?: string;
  /** IAM credentials — alternative to apiKey */
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  /** Default embed model. Defaults to amazon.titan-embed-text-v2:0 */
  defaultEmbedModel?: string;
  /**
   * Default completion model. Defaults to us.anthropic.claude-haiku-4-5-20251001-v1:0
   * (cross-region inference profile, cheapest Claude available via Bedrock API Key).
   * Other tested option: us.anthropic.claude-opus-4-5-20251101-v1:0
   */
  defaultCompleteModel?: string;
}

export class BedrockProvider implements LLMProvider {
  public readonly name = "bedrock";
  public readonly capabilities: LLMCapabilities = {
    embed: true,
    complete: true,
    streaming: false,
    jsonMode: false,
  };

  private readonly config: BedrockConfig;
  private readonly defaultEmbedModel: string;
  readonly defaultCompleteModel: string;
  private readonly region: string;

  constructor(config: BedrockConfig) {
    if (!config.apiKey && (!config.awsAccessKeyId || !config.awsSecretAccessKey)) {
      throw new LLMProviderError(
        "BedrockProvider requires either apiKey (Bedrock API Key) or awsAccessKeyId + awsSecretAccessKey (IAM credentials)",
        { provider: "bedrock" }
      );
    }
    this.config = config;
    this.defaultEmbedModel = config.defaultEmbedModel ?? "amazon.titan-embed-text-v2:0";
    this.defaultCompleteModel =
      config.defaultCompleteModel ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
    this.region = config.awsRegion ?? "us-east-1";
  }

  async embed(input: EmbedRequest): Promise<EmbedResponse> {
    const model = input.model ?? this.defaultEmbedModel;

    if (this.config.apiKey) {
      return this._embedWithApiKey(input.texts, model);
    }
    return this._embedWithIamCredentials(input.texts, model);
  }

  async complete(input: CompleteRequest): Promise<CompleteResponse> {
    if (!this.config.apiKey) {
      throw new LLMProviderError(
        "BedrockProvider complete() requires apiKey (Bedrock API Key). IAM credentials not yet supported for completions.",
        { provider: "bedrock" }
      );
    }
    const model = input.model ?? this.defaultCompleteModel;
    const baseUrl = `https://bedrock-runtime.${this.region}.amazonaws.com`;

    const body: Record<string, unknown> = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: input.maxTokens ?? 1024,
      messages: [{ role: "user", content: input.prompt }],
    };
    if (input.system) body.system = input.system;
    if (input.temperature !== undefined) body.temperature = input.temperature;

    const resp = await fetch(`${baseUrl}/model/${encodeURIComponent(model)}/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => resp.statusText);
      throw new LLMProviderError(`Bedrock complete failed (${resp.status}): ${err}`, {
        provider: "bedrock",
      });
    }

    const result = (await resp.json()) as {
      content: Array<{ text: string }>;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string;
    };

    return {
      text: result.content[0]?.text ?? "",
      tokensIn: result.usage?.input_tokens ?? 0,
      tokensOut: result.usage?.output_tokens ?? 0,
      model,
      provider: this.name,
      finishReason: result.stop_reason,
    };
  }

  /** Bedrock API Key path — uses native fetch, no AWS SDK required */
  private async _embedWithApiKey(texts: string[], model: string): Promise<EmbedResponse> {
    const baseUrl = `https://bedrock-runtime.${this.region}.amazonaws.com`;
    const vectors: number[][] = [];
    let totalTokens = 0;

    if (model.startsWith("amazon.titan")) {
      for (const text of texts) {
        const result = await embedTitanText(text, async (chunk) => {
          const resp = await fetch(`${baseUrl}/model/${encodeURIComponent(model)}/invoke`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify({ inputText: chunk, dimensions: 1024, normalize: true }),
          });
          if (!resp.ok) {
            const err = await resp.text().catch(() => resp.statusText);
            throw new LLMProviderError(`Bedrock Titan embed failed (${resp.status}): ${err}`, {
              provider: "bedrock",
            });
          }
          return (await resp.json()) as { embedding: number[]; inputTextTokenCount?: number };
        });
        vectors.push(result.embedding);
        totalTokens += result.tokens;
      }
    } else if (model.startsWith("cohere.embed")) {
      const resp = await fetch(`${baseUrl}/model/${encodeURIComponent(model)}/invoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ texts, input_type: "search_document", truncate: "END" }),
      });
      if (!resp.ok) {
        const err = await resp.text().catch(() => resp.statusText);
        throw new LLMProviderError(`Bedrock Cohere embed failed (${resp.status}): ${err}`, {
          provider: "bedrock",
        });
      }
      const result = (await resp.json()) as { embeddings: number[][] };
      vectors.push(...result.embeddings);
    } else {
      throw new LLMProviderError(
        `Unsupported Bedrock embed model: ${model}. Supported: amazon.titan-embed-text-v2:0, cohere.embed-english-v3`,
        { provider: "bedrock" }
      );
    }

    return { vectors, tokensUsed: totalTokens, model, provider: this.name };
  }

  /** IAM credentials path — uses @aws-sdk/client-bedrock-runtime (peerDependency) */
  private async _embedWithIamCredentials(texts: string[], model: string): Promise<EmbedResponse> {
    type SdkModule = {
      BedrockRuntimeClient: new (cfg: unknown) => {
        send(cmd: unknown): Promise<{ body: Uint8Array }>;
      };
      InvokeModelCommand: new (input: unknown) => unknown;
    };
    let sdk: SdkModule;
    try {
      const dynamicImport = new Function("m", "return import(m)") as (
        m: string
      ) => Promise<unknown>;
      sdk = (await dynamicImport("@aws-sdk/client-bedrock-runtime")) as SdkModule;
    } catch {
      throw new LLMProviderError(
        "Bedrock IAM mode requires @aws-sdk/client-bedrock-runtime. Install it or use Bedrock API Key instead.",
        { provider: "bedrock" }
      );
    }
    const { BedrockRuntimeClient, InvokeModelCommand } = sdk;
    const client = new BedrockRuntimeClient({
      region: this.region,
      credentials: {
        accessKeyId: this.config.awsAccessKeyId,
        secretAccessKey: this.config.awsSecretAccessKey,
      },
    });

    const vectors: number[][] = [];
    let totalTokens = 0;

    if (model.startsWith("amazon.titan")) {
      for (const text of texts) {
        const result = await embedTitanText(text, async (chunk) => {
          const cmd = new InvokeModelCommand({
            modelId: model,
            body: JSON.stringify({ inputText: chunk, dimensions: 1024, normalize: true }),
            contentType: "application/json",
            accept: "application/json",
          });
          const resp = (await client.send(cmd)) as { body: Uint8Array };
          return JSON.parse(new TextDecoder().decode(resp.body)) as {
            embedding: number[];
            inputTextTokenCount?: number;
          };
        });
        vectors.push(result.embedding);
        totalTokens += result.tokens;
      }
    } else if (model.startsWith("cohere.embed")) {
      const cmd = new InvokeModelCommand({
        modelId: model,
        body: JSON.stringify({ texts, input_type: "search_document", truncate: "END" }),
        contentType: "application/json",
        accept: "application/json",
      });
      const resp = (await client.send(cmd)) as { body: Uint8Array };
      const result = JSON.parse(new TextDecoder().decode(resp.body)) as { embeddings: number[][] };
      vectors.push(...result.embeddings);
    } else {
      throw new LLMProviderError(
        `Unsupported Bedrock embed model: ${model}. Supported: amazon.titan-embed-text-v2:0, cohere.embed-english-v3`,
        { provider: "bedrock" }
      );
    }

    return { vectors, tokensUsed: totalTokens, model, provider: this.name };
  }
}
