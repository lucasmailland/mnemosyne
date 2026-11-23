// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n/client";

import { BarList } from "../bar-list";
import { ChartCard } from "../chart-card";
import { formatDay, formatValue, niceTicks } from "../format";
import { Meter } from "../meter";
import { foldParts, SegmentedBar } from "../segmented-bar";
import { StatTile } from "../stat-tile";
import { labelIndices, TimeSeries } from "../time-series";

afterEach(cleanup);

const DAYS = ["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"];

function card(children: React.ReactNode, state?: "ready" | "empty" | "error") {
  return render(
    <ChartCard
      title="Writes per day"
      period="Last 4 days"
      definition="Facts created per UTC day."
      state={state}
    >
      {children}
    </ChartCard>
  );
}

describe("format", () => {
  it("formats counts, compacts from 10,000, and formats ms and shares per locale", () => {
    expect(formatValue("en-US", 1284, "count", true)).toBe("1,284");
    expect(formatValue("en-US", 12_900, "count", true)).toBe("12.9K");
    expect(formatValue("en-US", 12_900, "count")).toBe("12,900");
    expect(formatValue("en-US", 36.4, "ms")).toBe("36 ms");
    expect(formatValue("en-US", 0.623, "percent")).toBe("62%");
    expect(formatValue("en-US", 0.034, "percent")).toBe("3.4%");
    expect(formatDay("en-US", "2026-11-17")).toBe("Nov 17");
    expect(formatDay("es-419", "2026-11-17")).toBe("17 nov");
  });

  it("picks clean ticks that reach the maximum", () => {
    expect(niceTicks(0, "count")).toEqual([0, 1]);
    expect(niceTicks(7, "count")).toEqual([0, 5, 10]);
    expect(niceTicks(140, "ms")).toEqual([0, 50, 100, 150]);
    expect(niceTicks(0.62, "percent")).toEqual([0, 0.5, 1]);
    for (const max of [3, 17, 999, 12_345])
      expect(niceTicks(max, "count").at(-1)).toBeGreaterThanOrEqual(max);
  });
});

describe("marks", () => {
  it("ends today's label at the right edge when centering it would clip it", () => {
    const { container } = render(
      <TimeSeries
        label="Recalls"
        days={Array.from({ length: 30 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`)}
        series={[{ name: "Recalls", values: Array.from({ length: 30 }, () => 1) }]}
        kind="columns"
        format="count"
      />
    );
    const today = [...container.querySelectorAll("svg text")].find(
      (n) => n.textContent === "Today"
    )!;
    // 30 days on the 640 px frame: a 20 px band, the last center 18 px from the edge.
    expect(today.getAttribute("text-anchor")).toBe("end");
    expect(today.getAttribute("x")).toBe("639");
  });

  it("labels today and steps back far enough apart that labels never collide", () => {
    expect(labelIndices(30, 10)).toEqual([29, 21, 13, 5]);
    expect(labelIndices(4, 200)).toEqual([3, 2, 1, 0]);
  });
});

describe("TimeSeries", () => {
  const columns = () =>
    card(
      <TimeSeries
        label="Writes per day"
        days={DAYS}
        series={[{ name: "Writes", values: [2, 0, 5, 3] }]}
        kind="columns"
        format="count"
        minDays={7}
      />
    );

  it("draws square, hatched columns with today solid, marks today on the axis, notes a short history", () => {
    const { container } = columns();
    const bars = [...container.querySelectorAll("svg[viewBox] > rect")].filter(
      (r) => !r.closest("button")
    );
    expect(bars).toHaveLength(3); // one per non-zero day
    expect(bars.map((b) => b.getAttribute("fill"))).toEqual([
      expect.stringMatching(/^url\(#/),
      expect.stringMatching(/^url\(#/),
      "var(--chart-1)",
    ]);
    expect(container.querySelector("pattern line")?.getAttribute("stroke")).toBe("var(--chart-1)");
    expect(container.querySelector("[rx], [ry]")).toBeNull();
    const labels = [...container.querySelectorAll("svg text")].map((n) => n.textContent);
    expect(labels).toContain("Today");
    // At the 640 px first frame the last column sits 30 px from the edge: "Today" centers on it.
    const today = [...container.querySelectorAll("svg text")].find(
      (n) => n.textContent === "Today"
    )!;
    expect(Number(today.getAttribute("x")) + 24).toBeLessThanOrEqual(640);
    expect(screen.getByText("Only 3 of these 4 days have data.")).toBeTruthy();
  });

  it("shows the same readout on keyboard focus as on hover, and moves with the arrow keys", () => {
    columns();
    const plot = screen.getByRole("img", { name: /Writes per day/ });
    expect(screen.queryByTestId("chart-tooltip")).toBeNull();
    fireEvent.focus(plot);
    const tip = screen.getByTestId("chart-tooltip");
    expect(tip.textContent).toContain("Today · Nov 17");
    expect(tip.textContent).toContain("3");
    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    expect(screen.getByTestId("chart-tooltip").textContent).toContain("Nov 16");
    expect(screen.getByText(/Nov 16: Writes 5/)).toBeTruthy(); // the live region says it too
    fireEvent.keyDown(plot, { key: "Escape" });
    expect(screen.queryByTestId("chart-tooltip")).toBeNull();
    fireEvent.blur(plot);
  });

  it("keeps a table for screen readers and shows it in place of the chart on request", () => {
    columns();
    const table = screen.getByRole("table", { name: "Writes per day" });
    expect(table.parentElement!.className).toContain("sr-only");
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "View as table" }));
    expect(screen.getByRole("table").parentElement!.className).not.toContain("sr-only");
    expect(
      screen.getByRole("img", { hidden: true, name: /Writes per day/ }).closest("[hidden]")
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "View as table", pressed: true })).toBeTruthy();
  });

  it("draws areas with a legend from two series, leaves gaps where a day has no value", () => {
    const { container } = render(
      <TimeSeries
        label="Recall latency"
        days={DAYS}
        series={[
          { name: "p50", values: [10, null, 20, 30] },
          { name: "p95", values: [40, null, 80, 90] },
        ]}
        kind="area"
        format="ms"
      />
    );
    expect(screen.getAllByText("p50").length).toBeGreaterThan(0);
    // Per series: the lone first point gets a marker, the last run a hatched wash, a square-capped
    // line and a square end marker.
    expect(container.querySelectorAll("path[data-wash]")).toHaveLength(2);
    expect(container.querySelector("path[data-wash]")?.getAttribute("fill")).toMatch(/^url\(#/);
    expect(container.querySelectorAll('rect[width="8"][height="8"]')).toHaveLength(4);
    expect(container.querySelector("[stroke-linecap=round], circle")).toBeNull();
    const table = screen.getByRole("table", { name: "Recall latency" });
    expect(within(table).getAllByText("No data")).toHaveLength(2);
  });
});

describe("ChartCard", () => {
  it("says there is nothing yet, or that the data failed, without a table toggle", () => {
    card(null, "empty");
    expect(screen.getByText("No data in this period yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View as table" })).toBeNull();
    cleanup();
    card(null, "error");
    expect(screen.getByText(/Could not load this chart/)).toBeTruthy();
  });

  it("speaks the reader's language", () => {
    render(
      <I18nProvider locale="es-419">
        <ChartCard title="Escrituras" definition="Hechos creados por día.">
          <span />
        </ChartCard>
      </I18nProvider>
    );
    expect(screen.getByRole("button", { name: "Ver como tabla" })).toBeTruthy();
  });
});

describe("SegmentedBar", () => {
  const parts = [
    { name: "preference", value: 40 },
    { name: "architecture", value: 30 },
    { name: "bugfix", value: 10 },
    { name: "policy", value: 8 },
    { name: "config", value: 7 },
    { name: "event", value: 5 },
  ];

  it("folds a sixth part into other and names every part with its share", () => {
    expect(foldParts(parts, "Other").map((p) => p.name)).toEqual([
      "preference",
      "architecture",
      "bugfix",
      "policy",
      "Other",
    ]);
    const { container } = card(<SegmentedBar label="Memory by kind" parts={parts} />);
    // 5 hatched blocks and 5 legend keys, all square.
    expect(container.querySelectorAll('svg rect[fill^="url(#"]')).toHaveLength(5 + 5);
    expect(container.querySelector("[rx]")).toBeNull();
    const bar = screen.getByRole("img", { name: /Memory by kind: preference 40 \(40%\)/ });
    expect(bar.getAttribute("aria-label")).toContain("Other 12 (12%)");
    fireEvent.focus(bar);
    expect(screen.getByTestId("chart-tooltip").textContent).toContain("preference");
    // The part being read turns solid.
    expect(container.querySelector('svg[height="8"] rect')?.getAttribute("fill")).toBe(
      "var(--chart-1)"
    );
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(screen.getByTestId("chart-tooltip").textContent).toContain("architecture");
    // The table keeps the folded tail readable.
    expect(within(screen.getByRole("table")).getByText("event")).toBeTruthy();
  });
});

describe("Meter and StatTile", () => {
  it("says the state in words past 90 % and 100 %", () => {
    render(<Meter label="Recalls" value={1100} max={1000} />);
    const meter = screen.getByRole("meter", { name: "Recalls" });
    expect(meter.getAttribute("aria-valuetext")).toBe("1,100 of 1,000, Over the limit");
    expect(screen.getByText("Over the limit")).toBeTruthy();
  });

  it("reads a missing value as no data and keeps its definition behind the info button", () => {
    render(
      <StatTile label="Recall latency" definition="Per recall call." value={null} format="ms" />
    );
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("No data")).toBeTruthy();
    const info = screen.getByRole("button", { name: "About: Recall latency" });
    // The definition is the button's description, so a screen reader hears it on focus.
    expect(info).toHaveAccessibleDescription("Per recall call.");
    expect(screen.queryByText("Per recall call.")).not.toBeVisible();
    fireEvent.click(info);
    expect(screen.getByText("Per recall call.")).toBeVisible();
    fireEvent.keyDown(info, { key: "Escape" });
    expect(screen.queryByText("Per recall call.")).not.toBeVisible();
  });

  it("compacts a large value, links it, and draws its sparkline", () => {
    render(
      <StatTile
        label="Memories"
        definition="Live facts."
        value={12_900}
        href="/browser"
        spark={[1, 3, 2, 5]}
        sparkLabel="Writes, last 4 days"
      />
    );
    expect(screen.getByRole("link", { name: "12.9K" }).getAttribute("href")).toBe("/browser");
    expect(screen.getByRole("img", { name: "Writes, last 4 days" })).toBeTruthy();
  });
});

describe("BarList", () => {
  it("ranks rows as links with the value at the tip and a table twin", () => {
    card(
      <BarList
        label="Top recalled"
        items={[
          { name: "Deploys run on Fridays", value: 12, href: "/browser?open=f1" },
          { name: "Postgres is the ledger", value: 4, href: "/browser?open=f2" },
        ]}
      />
    );
    const link = screen.getByRole("link", { name: "Deploys run on Fridays" });
    expect(link.getAttribute("href")).toBe("/browser?open=f1");
    fireEvent.focus(link);
    expect(screen.getByTestId("chart-tooltip").textContent).toContain("75%");
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3);
  });
});
