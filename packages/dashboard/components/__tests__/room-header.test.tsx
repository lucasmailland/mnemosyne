// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { RoomHeader } from "../room-header";

afterEach(cleanup);

it("renders numeral and page name, h1 title, subtitle and a decorative image", () => {
  const { container } = render(
    <RoomHeader
      numeral="II"
      name="Browser"
      title="Catalog"
      subtitle="Every memory"
      image="pano-palace"
    />
  );
  expect(screen.getByText("II · Browser")).toBeTruthy();
  // The page name leads the heading's accessible name; the metaphor follows.
  expect(screen.getByRole("heading", { level: 1, name: "Browser — Catalog" })).toBeTruthy();
  expect(screen.getByText("Every memory")).toBeTruthy();
  expect(container.querySelector("img")?.getAttribute("alt")).toBe("");
});

it("shows just the page name when the room has no numeral", () => {
  render(<RoomHeader name="My account" title="Your account" image="bust-frieze" />);
  expect(screen.getByText("My account", { selector: "p" })).toBeTruthy();
});
