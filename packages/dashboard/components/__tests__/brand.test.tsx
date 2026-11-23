// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmptyState } from "../empty-state";
import { ErrorState } from "../error-state";
import { SealIcon } from "../brand/seal-icon";
import { Spinner } from "../brand/spinner";
import { Wordmark } from "../brand/wordmark";

afterEach(cleanup);

describe("brand components", () => {
  it("Wordmark is a named, untranslatable image", () => {
    render(<Wordmark />);
    const el = screen.getByRole("img", { name: "Mnemosyne" });
    expect(el.getAttribute("translate")).toBe("no");
    expect(el.getAttribute("fill")).toBe("currentColor");
  });

  it("SealIcon is decorative", () => {
    const { container } = render(<SealIcon icon="store" />);
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("");
  });

  it("Spinner is a status with its label", () => {
    render(<Spinner label="Loading memories" />);
    expect(screen.getByRole("status").textContent).toContain("Loading memories");
  });

  it("EmptyState renders title, body and action", () => {
    render(<EmptyState title="Nothing yet" body="Store one." action={<button>Go</button>} />);
    expect(screen.getByRole("heading", { name: "Nothing yet" })).toBeTruthy();
    expect(screen.getByText("Store one.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go" })).toBeTruthy();
  });

  it("ErrorState is an alert and retries on click", () => {
    const retry = vi.fn();
    render(<ErrorState title="Failed" body="Oops" retry={retry} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("ErrorState has no button without retry", () => {
    render(<ErrorState title="Failed" body="Oops" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
