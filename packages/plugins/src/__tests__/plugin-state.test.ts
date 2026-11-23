import { describe, it, expect } from "vitest";
import { InMemoryPluginStateStore } from "../state.js";

describe("InMemoryPluginStateStore", () => {
  it("round-trips get/set/delete/keys scoped by plugin", async () => {
    const s = new InMemoryPluginStateStore();
    expect(await s.get("k")).toBeUndefined();
    await s.set("k", { a: 1 });
    expect(await s.get<{ a: number }>("k")).toEqual({ a: 1 });
    expect(await s.keys()).toEqual(["k"]);
    await s.delete("k");
    expect(await s.get("k")).toBeUndefined();
  });
});
