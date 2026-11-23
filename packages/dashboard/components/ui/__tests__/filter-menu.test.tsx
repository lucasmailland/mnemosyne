import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FilterMenu } from "../filter-menu";

afterEach(cleanup);

const KINDS = [
  "preference",
  "trait",
  "event",
  "relationship",
  "skill",
  "concern",
  "policy",
  "process",
  "other",
].map((v) => ({ value: v, label: v }));
const key = (k: string) => fireEvent.keyDown(document.activeElement!, { key: k });

describe("FilterMenu", () => {
  it("opens from its button, searches, moves with the arrows, picks with Enter and closes", () => {
    const onChange = vi.fn();
    render(<FilterMenu label="Kind" options={KINDS} onChange={onChange} />);
    const button = screen.getByRole("button", { name: "Kind: All" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("aria-controls");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    // Nine options: the panel opens on its search field.
    const search = screen.getByRole("searchbox", { name: "Search in Kind" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "pol" } });
    expect(screen.getByRole("radio", { name: "policy" })).toBeVisible();
    expect(screen.queryByRole("radio", { name: "trait" })).toBeNull();
    key("ArrowDown");
    expect(screen.getByRole("radio", { name: "policy" })).toHaveFocus();
    key("Enter");
    expect(onChange).toHaveBeenLastCalledWith(["policy"]);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
    expect(button).toHaveAccessibleName("Kind: policy");
  });

  it("arrows only move focus between radios (no pick), and Escape gives focus back", () => {
    const onChange = vi.fn();
    render(
      <FilterMenu
        label="Kind"
        options={KINDS.slice(0, 3)}
        defaultValue={["trait"]}
        onChange={onChange}
      />
    );
    const button = screen.getByRole("button", { name: "Kind: trait" });
    fireEvent.click(button);
    // Focus lands on the chosen option.
    expect(screen.getByRole("radio", { name: "trait" })).toHaveFocus();
    key("ArrowDown");
    expect(screen.getByRole("radio", { name: "event" })).toHaveFocus();
    key("Home");
    expect(screen.getByRole("radio", { name: "All" })).toHaveFocus();
    key("End");
    expect(screen.getByRole("radio", { name: "event" })).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
    key("Escape");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
  });

  it("takes several with checkboxes, counts them on the button, and clears", () => {
    render(<FilterMenu label="Kinds" options={KINDS.slice(0, 3)} multiple />);
    fireEvent.click(screen.getByRole("button", { name: "Kinds: All" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "preference" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "event" }));
    // Still open: several can be picked.
    expect(screen.getByRole("button", { name: "Kinds: 2" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(screen.getByText("2 selected")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("button", { name: "Kinds: All" })).toBeTruthy();
  });

  it("sends its form on a pick when asked to", () => {
    const submit = vi.fn((e: Event) => e.preventDefault());
    render(
      <form onSubmit={(e) => submit(e.nativeEvent)}>
        <FilterMenu label="Kind" name="kind" options={KINDS.slice(0, 3)} submitOnChange />
      </form>
    );
    fireEvent.click(screen.getByRole("button", { name: "Kind: All" }));
    fireEvent.click(screen.getByRole("radio", { name: "event" }));
    expect(submit).toHaveBeenCalledTimes(1);
    const form = screen.getByRole("radio", { name: "event", hidden: true }).closest("form")!;
    expect(new FormData(form).get("kind")).toBe("event");
  });
});
