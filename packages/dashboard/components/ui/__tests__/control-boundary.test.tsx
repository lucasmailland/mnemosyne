/**
 * APP-058: a control's edge reads at 3:1 (the control-border token, ratios in globals.css) and
 * a focused field shows the same 2px outline as every other control, not a 1px colour change.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { ghostButton, inputClass, selectClass } from "@/components/form-bits";
import { DateRangeMenu } from "../date-range-menu";
import { SearchInput } from "../filter-bar";
import { FilterMenu } from "../filter-menu";
import { RowMenu } from "../row-menu";

afterEach(cleanup);

const control = (el: Element) => {
  const c = el.getAttribute("class") ?? "";
  expect(c).toContain("border-control-border");
  expect(c).not.toMatch(/(^|\s)border-border(\s|$)/);
};
const focusRing = (el: Element) => {
  const c = el.getAttribute("class") ?? "";
  expect(c).toContain("focus-visible:outline-2");
  expect(c).not.toContain("focus:outline-none");
};

it("the shared field, select and ghost button classes use the control border", () => {
  for (const c of [inputClass, selectClass, ghostButton]) {
    expect(c).toContain("border-control-border");
    expect(c).not.toMatch(/(^|\s)border-border(\s|$)/);
  }
});

it("search, filter, date and row-menu controls have the control border and a 2px focus ring", () => {
  render(
    <>
      <SearchInput aria-label="Search" />
      <FilterMenu
        label="Kind"
        options={Array.from({ length: 9 }, (_, i) => ({ value: `${i}`, label: `${i}` }))}
        onChange={() => {}}
      />
      <DateRangeMenu />
      <RowMenu name="x" actions={[{ label: "Rename", onSelect: () => {} }]} />
    </>
  );
  const search = screen.getByRole("searchbox", { name: "Search" });
  control(search);
  focusRing(search);
  control(screen.getByRole("button", { name: "Kind: All" }));
  control(screen.getByRole("button", { name: "Actions for x" }));
  const dates = screen.getByRole("button", { name: "Dates: any" });
  control(dates);
  fireEvent.click(screen.getByRole("button", { name: "Kind: All" }));
  const inMenu = screen.getByRole("searchbox", { name: "Search in Kind" });
  control(inMenu);
  focusRing(inMenu);
  fireEvent.click(dates);
  control(screen.getByLabelText("From"));
  focusRing(screen.getByLabelText("From"));
});

it("no field in the dashboard drops its focus outline", () => {
  const root = resolve(__dirname, "../../..");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__") walk(p);
      } else if (/\.tsx?$/.test(e.name) && readFileSync(p, "utf8").includes("focus:outline-none"))
        offenders.push(p.slice(root.length + 1));
    }
  };
  walk(join(root, "app"));
  walk(join(root, "components"));
  expect(offenders).toEqual([]);
});
