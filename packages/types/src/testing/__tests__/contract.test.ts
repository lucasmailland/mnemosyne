import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";
import { runStorageAdapterContractTests } from "../StorageAdapterContract.js";

runStorageAdapterContractTests(() => {
  const adapter = new InMemoryStorageAdapter();
  adapter.reset();
  return adapter;
});
