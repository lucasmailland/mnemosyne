import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RouteStage } from "../route-stage";

let pathname = "/browser";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
afterEach(cleanup);

it("wraps children in an .enter element keyed by route and re-mounts on change", () => {
  const { rerender } = render(
    <RouteStage>
      <p>hi</p>
    </RouteStage>
  );
  const first = screen.getByText("hi").parentElement as HTMLElement;
  expect(first).toHaveClass("enter");
  expect(first).toHaveAttribute("data-route", "/browser");
  pathname = "/recall";
  rerender(
    <RouteStage>
      <p>hi</p>
    </RouteStage>
  );
  const second = screen.getByText("hi").parentElement as HTMLElement;
  expect(second).toHaveAttribute("data-route", "/recall");
  expect(document.body.contains(first)).toBe(false);
});
