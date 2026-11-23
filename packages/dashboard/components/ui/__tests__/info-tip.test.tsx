import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InfoTip } from "../info-tip";

afterEach(cleanup);
const key = (k: string) => fireEvent.keyDown(document.activeElement!, { key: k });

describe("InfoTip", () => {
  it("is described by its text, opens on a click, closes on Escape, and keeps focus", () => {
    render(<InfoTip label="Mode" text="Counts since learning began." />);
    const button = screen.getByRole("button", { name: "About: Mode" });
    expect(button).toHaveAccessibleDescription("Counts since learning began.");
    expect(screen.queryByText("Counts since learning began.")).not.toBeVisible();
    button.focus();
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Counts since learning began.")).toBeVisible();
    key("Escape");
    expect(screen.queryByText("Counts since learning began.")).not.toBeVisible();
    expect(button).toHaveFocus();
  });

  it("shows on hover, stays while the pointer is on it, hides on leave; a click pins it", () => {
    vi.useFakeTimers();
    render(<InfoTip label="Mode" text="Help." />);
    const button = screen.getByRole("button", { name: "About: Mode" });
    fireEvent.mouseEnter(button);
    expect(screen.getByText("Help.")).toBeVisible();
    // Moving onto the text keeps it (WCAG 1.4.13).
    fireEvent.mouseLeave(button);
    fireEvent.mouseEnter(screen.getByText("Help.").parentElement!);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByText("Help.")).toBeVisible();
    fireEvent.mouseLeave(screen.getByText("Help.").parentElement!);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByText("Help.")).not.toBeVisible();
    vi.useRealTimers();
    fireEvent.mouseEnter(button);
    fireEvent.click(button);
    fireEvent.mouseLeave(button);
    expect(screen.getByText("Help.")).toBeVisible();
  });

  it("lets a control point at the same text", () => {
    render(
      <>
        <input aria-label="Limit" aria-describedby="limit-help" />
        <InfoTip label="Limit" text="Zero means none." textId="limit-help" />
      </>
    );
    expect(screen.getByRole("textbox", { name: "Limit" })).toHaveAccessibleDescription(
      "Zero means none."
    );
  });
});
