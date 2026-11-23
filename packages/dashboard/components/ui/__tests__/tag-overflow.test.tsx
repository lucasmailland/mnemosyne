import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TagOverflow } from "../tag-overflow";

afterEach(cleanup);

describe("TagOverflow", () => {
  it("shows the first tags and the rest behind +N", () => {
    const tags = ["a", "b", "c", "d", "e"];
    render(<TagOverflow label="Permissions" tags={tags} max={2} />);
    expect(
      within(screen.getByRole("list", { name: "Permissions" })).getAllByRole("listitem")
    ).toHaveLength(2);
    const more = screen.getByRole("button", { name: "+3 Show all 5: Permissions" });
    fireEvent.click(more);
    const panel = screen.getByRole("dialog", { name: "Permissions" });
    expect(within(panel).getAllByRole("listitem")).toHaveLength(5);
  });

  it("has no button when every tag fits", () => {
    render(<TagOverflow label="P" tags={["a", "b"]} max={3} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
