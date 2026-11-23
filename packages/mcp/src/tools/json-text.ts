/**
 * The one way a tool turns a result into text (APP-020). Compact on purpose:
 * the reader is a model paying per token, and indentation carries no meaning.
 */
export const jsonText = (value: unknown): string => JSON.stringify(value) ?? "null";
