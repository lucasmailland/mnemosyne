import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";
import { runHarnessIngestionContractTests } from "../HarnessIngestionContract.js";

runHarnessIngestionContractTests(async () => {
  const adapter = new InMemoryStorageAdapter();
  return {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    port: adapter,
    inspect: () => adapter.inspectHarnessState("11111111-1111-4111-8111-111111111111"),
    getSessionStatus: async (id) =>
      (await adapter.getSession(id, "11111111-1111-4111-8111-111111111111"))?.status ?? null,
    setSessionLifecycle: (input) =>
      adapter.setHarnessSessionLifecycle("11111111-1111-4111-8111-111111111111", input),
    seedManagedTurn: (input) =>
      adapter.seedHarnessManagedTurn("11111111-1111-4111-8111-111111111111", input),
  };
});
