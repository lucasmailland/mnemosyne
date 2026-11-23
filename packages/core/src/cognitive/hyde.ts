import type { CoreContext } from "./context.js";
import { reportLlmUsage } from "./llm-usage.js";

/** HyDE (arXiv:2212.10496): LLM writes a hypothetical answer doc; we embed THAT.
 *  Degrades to null (never throws) when no LLM is configured. */
export async function generateHydeDoc(
  ctx: Pick<CoreContext, "llm" | "logger" | "onLlmUsage">,
  queryText: string
): Promise<string | null> {
  if (!ctx.llm) return null;
  try {
    const out = await ctx.llm.generate({
      messages: [
        {
          role: "user",
          content: `Write a single short factual paragraph that would directly answer this query, as if from a knowledge base. Do not hedge. Query: ${queryText}`,
        },
      ],
      maxTokens: 256,
      temperature: 0,
      task: "prefilter",
    });
    reportLlmUsage(
      ctx,
      ctx.llm.id,
      out.model,
      out.tokensUsed.input,
      out.tokensUsed.output,
      out.costUSD
    );
    const text = out.content.trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    ctx.logger.debug("recall.hyde_failed", {
      error: { type: "hyde_failed", message: String(err) },
    });
    return null; // graceful degradation — caller uses the raw-query embedding
  }
}
