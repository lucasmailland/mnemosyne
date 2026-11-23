import type { MnemosyneClient, RequestObservation } from "@mnemo-ai/client-ts";

/**
 * Per-call clone of `client` that declares `observation` as request headers.
 * Falls back to `client` itself when it has no `withObservation` (partial
 * test doubles and older SDKs): the metadata is best-effort, never required.
 */
export function observed(
  client: MnemosyneClient,
  observation: RequestObservation
): MnemosyneClient {
  return typeof client.withObservation === "function"
    ? client.withObservation(observation)
    : client;
}
