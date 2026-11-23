import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DateRangeMenu } from "../date-range-menu";

afterEach(cleanup);

describe("DateRangeMenu", () => {
  it("carries its days in the form and a shortcut sends it", () => {
    const submit = vi.fn((e: Event) => e.preventDefault());
    render(
      <form aria-label="filters" onSubmit={(e) => submit(e.nativeEvent)}>
        <DateRangeMenu from="2026-11-01" />
      </form>
    );
    const button = screen.getByRole("button", { name: /^Dates: from / });
    fireEvent.click(button);
    expect(screen.getByLabelText("From")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(submit).toHaveBeenCalledTimes(1);
    const data = new FormData(screen.getByRole("form", { name: "filters" }) as HTMLFormElement);
    expect(data.get("from")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.get("to")).toBe("");
  });
});
