import { describe, expect, it } from "vitest";
import {
  ARCHIVE_REASON_LABELS,
  EXTRACTION_RESULT_LABELS,
  applyManagedLifecycleStats,
  extractionSuccessRate,
  harnessGauges,
  type ManagedLifecycleStats,
} from "../../metrics/harness.js";

function stats(overrides: Partial<ManagedLifecycleStats> = {}): ManagedLifecycleStats {
  return {
    active: 3,
    pending: 2,
    collapsed: 10,
    archivedByReason: [{ reason: "empty_session", count: 4 }],
    retryBuckets: [{ bucket: "1", count: 2 }],
    oldestPendingAgeSeconds: 42,
    messageCountBuckets: [{ bucket: "10", count: 5 }],
    extraction: [
      { result: "succeeded", count: 8 },
      { result: "failed", count: 2 },
    ],
    incompleteCapture: 1,
    ...overrides,
  };
}

function series(gauge: { toLines(): string[] }): string[] {
  return gauge.toLines().filter((line) => !line.startsWith("#"));
}

describe("managed lifecycle gauges", () => {
  it("publishes each lifecycle count as its own series, not one blended number", () => {
    applyManagedLifecycleStats(stats());

    expect(series(harnessGauges.sessions)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('state="active"} 3'),
        expect.stringContaining('state="collapse_pending"} 2'),
        expect.stringContaining('state="collapsed"} 10'),
      ])
    );
    expect(series(harnessGauges.archived)).toEqual([
      expect.stringContaining('reason="empty_session"} 4'),
    ]);
    expect(series(harnessGauges.oldestPendingAge)).toEqual([expect.stringContaining(" 42")]);
    expect(series(harnessGauges.incompleteCapture)).toEqual([expect.stringContaining(" 1")]);
  });

  it("drops a series that is no longer present instead of leaving it frozen", () => {
    applyManagedLifecycleStats(stats());
    expect(series(harnessGauges.archived)).toHaveLength(1);

    applyManagedLifecycleStats(stats({ archivedByReason: [] }));

    // A gauge that keeps its last value forever reports an archive reason that
    // stopped happening as though it were still happening.
    expect(series(harnessGauges.archived)).toHaveLength(0);
  });

  it("refuses unbounded label values so a scrape cannot become high-cardinality", () => {
    applyManagedLifecycleStats(
      stats({
        archivedByReason: [
          { reason: "empty_session", count: 1 },
          { reason: "55555555-5555-4555-8555-555555555555", count: 9 },
        ],
        extraction: [
          { result: "succeeded", count: 1 },
          { result: "session-abc", count: 9 },
        ],
      })
    );

    const archived = series(harnessGauges.archived).join("\n");
    expect(archived).toContain('reason="empty_session"');
    expect(archived).not.toContain("55555555-5555-4555-8555-555555555555");
    // Unknown values are still counted, under a bounded catch-all.
    expect(archived).toContain('reason="other"');

    const extraction = series(harnessGauges.extraction).join("\n");
    expect(extraction).not.toContain("session-abc");
  });

  it("keeps every whitelisted label bounded and free of identifiers", () => {
    for (const label of [...ARCHIVE_REASON_LABELS, ...EXTRACTION_RESULT_LABELS]) {
      expect(label).toMatch(/^[a-z_]+$/);
    }
  });
});

describe("extraction success rate", () => {
  it("divides successes by terminal attempts, not by all sessions", () => {
    expect(
      extractionSuccessRate([
        { result: "succeeded", count: 8 },
        { result: "failed", count: 2 },
      ])
    ).toBeCloseTo(0.8);
  });

  it("ignores sessions that never attempted extraction", () => {
    // A session that was archived before extraction ran is not a failed
    // extraction; counting it would make the rate track archive volume.
    expect(
      extractionSuccessRate([
        { result: "succeeded", count: 1 },
        { result: "not_attempted", count: 99 },
      ])
    ).toBe(1);
  });

  it("reports zero when nothing terminal has been attempted yet", () => {
    expect(extractionSuccessRate([])).toBe(0);
    expect(extractionSuccessRate([{ result: "not_attempted", count: 5 }])).toBe(0);
  });
});
