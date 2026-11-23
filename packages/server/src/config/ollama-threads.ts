/**
 * MNEMO_OLLAMA_NUM_THREAD: threads per Ollama request (`options.num_thread`).
 * Unset, zero or not a positive integer means "let Ollama choose". Only the
 * Ollama provider reads the value; every other provider ignores it.
 */
export function ollamaNumThread(
  env: Record<string, string | undefined> = process.env
): { numThread: number } | Record<string, never> {
  const n = Number(env["MNEMO_OLLAMA_NUM_THREAD"]);
  return Number.isInteger(n) && n > 0 ? { numThread: n } : {};
}
