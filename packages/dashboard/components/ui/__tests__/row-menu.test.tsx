import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RowMenu } from "../row-menu";

afterEach(cleanup);
const key = (k: string) => fireEvent.keyDown(document.activeElement!, { key: k });

describe("RowMenu", () => {
  const actions = (onDelete = vi.fn(), onRename = vi.fn()) => [
    { label: "Rename", onSelect: onRename },
    { label: "Delete", ariaLabel: "Delete a@b.test", onSelect: onDelete, danger: true },
  ];

  it("is one button whose menu takes the arrows, Home, End and Escape", () => {
    render(<RowMenu name="a@b.test" actions={actions()} />);
    const button = screen.getByRole("button", { name: "Actions for a@b.test" });
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(button);
    const menu = screen.getByRole("menu", { name: "Actions for a@b.test" });
    const [rename, del] = within(menu).getAllByRole("menuitem");
    expect(rename).toHaveFocus();
    key("ArrowDown");
    expect(del).toHaveFocus();
    key("ArrowDown");
    expect(del).toHaveFocus();
    key("Home");
    expect(rename).toHaveFocus();
    key("End");
    expect(del).toHaveFocus();
    key("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("sets the destructive action apart, closes on a pick and returns focus before running it", () => {
    const onDelete = vi.fn(() => expect(document.activeElement).toBe(button));
    render(<RowMenu name="a@b.test" actions={actions(onDelete)} />);
    const button = screen.getByRole("button", { name: "Actions for a@b.test" });
    fireEvent.click(button);
    const del = screen.getByRole("menuitem", { name: "Delete a@b.test" });
    expect(del.className).toContain("text-red");
    expect(del.previousElementSibling).toHaveAttribute("role", "separator");
    fireEvent.click(del);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("closes on Tab, as a menu does", () => {
    render(<RowMenu name="x" actions={actions()} />);
    const button = screen.getByRole("button", { name: "Actions for x" });
    fireEvent.click(button);
    key("Tab");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(button).toHaveFocus();
  });
});
