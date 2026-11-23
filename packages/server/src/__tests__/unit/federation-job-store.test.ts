// InMemoryJobStore (the fallback without the Postgres adapter) keeps the same
// rules as DrizzleSyncJobStore: a job is read only from its workspace and a
// finished job is final.
import { describe, expect, it } from "vitest";
import { InMemoryJobStore } from "../../federation/JobStore.js";

const job = {
  id: "job-1",
  peerId: "acme.example",
  workspaceId: "ws_acme",
  status: "pending" as const,
  startedAt: "2026-01-02T03:04:05.000Z",
};

describe("InMemoryJobStore", () => {
  it("reads and updates a job only from its own workspace", async () => {
    const store = new InMemoryJobStore();
    await store.create(job);
    expect(await store.get("job-1", "ws_larkspur")).toBeNull();
    await store.update("job-1", "ws_larkspur", { status: "failed" });
    await store.update("job-1", "ws_acme", { status: "running" });
    expect((await store.get("job-1", "ws_acme"))?.status).toBe("running");
  });

  it("never changes a finished job", async () => {
    const store = new InMemoryJobStore();
    await store.create(job);
    await store.update("job-1", "ws_acme", { status: "done" });
    await store.update("job-1", "ws_acme", { status: "failed", error: "late" });
    expect(await store.get("job-1", "ws_acme")).toEqual({ ...job, status: "done" });
  });
});
