/**
 * P124 — parse a JSON reply from an LLM, tolerating the markdown fence almost
 * all of them add.
 *
 * Every site that asked a model for JSON did `JSON.parse(out.content)` on the
 * raw string. That works right up until the model answers
 *
 *   ```json
 *   {"facts": []}
 *   ```
 *
 * which is not a malfunction — it is the default behaviour of most small models
 * and plenty of large ones outside strict JSON mode. Found against a real
 * container: a four-turn session collapsed to a 503 with
 * `Unexpected token '`', "```json\n{\n"... is not valid JSON`, and the whole
 * session went unextracted because of three backticks.
 *
 * WHAT THIS DOES NOT DO, deliberately: it does not hunt for JSON inside
 * arbitrary prose. Pulling the first `{…}` out of a chatty reply is where
 * silent WRONG parses begin — a model that explains itself and then emits an
 * example object would have the example parsed as the answer. A fence is an
 * unambiguous, universally-used wrapper; anything else should fail loudly and
 * be fixed in the prompt.
 */

/** Matches a whole-string markdown fence, with or without a language tag. */
const FENCED = /^\s*```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?\s*```\s*$/;

/**
 * Strip a surrounding markdown fence, if there is one. Returns the input
 * trimmed otherwise.
 */
export function stripCodeFence(raw: string): string {
  const m = FENCED.exec(raw);
  return (m?.[1] ?? raw).trim();
}

/**
 * A fence that OPENS the reply and closes on its own line, followed by prose.
 * Claude Haiku 4.5 on Bedrock answers this way in production: the JSON first,
 * then a paragraph explaining it. The fenced block is still the first thing
 * the model emitted, so it is the answer, not an example inside an
 * explanation. Requiring the closing fence on its own line keeps backticks
 * quoted inside a JSON string from ending the block early.
 */
const LEADING_FENCE = /^\s*```(?:[a-zA-Z0-9_-]+)?[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*(?:\n|$)/;

/**
 * `JSON.parse` for LLM output.
 *
 * @param raw   the model's reply, verbatim
 * @param site  where this is being parsed, used in the error message — a
 *              failure here reaches a log line, and "which of the five parse
 *              sites was it" is the first question the reader has
 */
export function parseJsonReply<T>(raw: string, site: string): T {
  const cleaned = stripCodeFence(raw);
  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    const leading = LEADING_FENCE.exec(raw);
    if (leading) {
      try {
        return JSON.parse(leading[1]!) as T;
      } catch {
        // Fall through to the original error: it describes the whole reply.
      }
    }
    // Include a bounded prefix of what actually arrived. The original failures
    // said `Unexpected token '\`'` and nothing about the payload, which is
    // enough to guess a fence and not enough to diagnose anything else.
    const preview = cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
    throw new Error(
      `${site}: LLM reply is not valid JSON (${err instanceof Error ? err.message : String(err)}). Got: ${preview}`
    );
  }
}
