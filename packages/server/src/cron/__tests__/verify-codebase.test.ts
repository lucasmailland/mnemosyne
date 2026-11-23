import { describe, it, expect, vi } from "vitest";
import { verifyCodebaseForWorkspace } from "../verify-codebase.js";

const makeStorage = () => ({
  queryDriftCandidates: vi.fn(),
  updateFact: vi.fn().mockResolvedValue(undefined),
  updateWorth: vi.fn().mockResolvedValue(undefined),
  enqueueReviewItem: vi.fn().mockResolvedValue(undefined),
  createEvent: vi.fn().mockResolvedValue({ id: "e1" }),
  createFact: vi.fn().mockResolvedValue({ id: "corrected" }),
});

const makeDeps = (over: object = {}) => ({
  workspaceId: "ws1",
  storage: makeStorage() as any,
  fileReader: { read: vi.fn() } as any,
  llm: undefined,
  telemetry: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn(), startSpan: () => ({ end() {} }) } as any,
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any,
  ...over,
});

describe("verifyCodebaseForWorkspace — §25.1 drift pipeline", () => {
  it("no drift when statement still appears in the file", async () => {
    const d = makeDeps();
    d.storage.queryDriftCandidates.mockResolvedValue([
      { id: "f1", statement: "export const PORT = 7437", metadata: { source_type: "codebase", file_ref: { path: "a.ts" } } },
    ]);
    d.fileReader.read.mockResolvedValue("export const PORT = 7437; // unchanged");
    const r = await verifyCodebaseForWorkspace(d);
    expect(r).toEqual({ checked: 1, drifted: 0, corrected: 0 });
    expect(d.storage.updateFact).not.toHaveBeenCalled();
    expect(d.storage.createEvent).not.toHaveBeenCalled();
  });

  it("on drift: closes validity, decreases worth, enqueues review, emits event", async () => {
    const d = makeDeps();
    d.storage.queryDriftCandidates.mockResolvedValue([
      { id: "f1", statement: "export const PORT = 9999", metadata: { source_type: "codebase", file_ref: { path: "a.ts" } } },
    ]);
    d.fileReader.read.mockResolvedValue("export const PORT = 7437");
    const r = await verifyCodebaseForWorkspace(d);
    expect(r.drifted).toBe(1);
    expect(d.storage.updateFact).toHaveBeenCalledWith("f1", "ws1", expect.objectContaining({ validTo: expect.any(Date) }));
    expect(d.storage.updateWorth).toHaveBeenCalledWith("f1", "ws1", "fact", expect.objectContaining({ failure: 1 }));
    expect(d.storage.enqueueReviewItem).toHaveBeenCalledWith(expect.objectContaining({ primitiveId: "f1", reason: "codebase_drift" }));
    expect(d.storage.createEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "system" }));
  });

  it("missing file is treated as drift", async () => {
    const d = makeDeps();
    d.storage.queryDriftCandidates.mockResolvedValue([
      { id: "f1", statement: "x", metadata: { source_type: "config", file_ref: { path: "gone.ts" } } },
    ]);
    d.fileReader.read.mockResolvedValue(null);
    const r = await verifyCodebaseForWorkspace(d);
    expect(r.drifted).toBe(1);
  });

  it("returns zero and skips when no fileReader is configured", async () => {
    const d = makeDeps({ fileReader: undefined });
    expect(await verifyCodebaseForWorkspace(d)).toEqual({ checked: 0, drifted: 0, corrected: 0 });
  });
});
