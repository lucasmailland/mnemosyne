import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FilterBar } from "../filter-bar";

afterEach(cleanup);

describe("FilterBar", () => {
  it("says how many filters are on and clears them", () => {
    const onClear = vi.fn();
    render(<FilterBar label="Filters" active={2} onClear={onClear} count="39 matches" />);
    expect(screen.getByRole("group", { name: "Filters" })).toHaveTextContent("2 filters");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onClear).toHaveBeenCalled();
    expect(screen.getByText("39 matches")).toBeTruthy();
  });
});
