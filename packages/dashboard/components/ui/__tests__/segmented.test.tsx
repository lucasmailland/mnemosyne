import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Segmented } from "../segmented";

afterEach(cleanup);

describe("Segmented", () => {
  it("is a labelled radio group", () => {
    const onChange = vi.fn();
    render(
      <Segmented
        label="Theme"
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
        value="light"
        onChange={onChange}
      />
    );
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(within(group).getByRole("radio", { name: "Light" })).toBeChecked();
    fireEvent.click(within(group).getByRole("radio", { name: "Dark" }));
    expect(onChange).toHaveBeenCalledWith("dark");
  });
});
