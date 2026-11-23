import type { PluginStateStore } from "./index.js";

/** Test/double impl. Production uses DrizzlePluginStateStore in the server. */
export class InMemoryPluginStateStore implements PluginStateStore {
  private readonly map = new Map<string, unknown>();
  async get<T = unknown>(key: string): Promise<T | undefined> { return this.map.get(key) as T | undefined; }
  async set(key: string, value: unknown): Promise<void> { this.map.set(key, value); }
  async delete(key: string): Promise<void> { this.map.delete(key); }
  async keys(): Promise<string[]> { return [...this.map.keys()]; }
}
