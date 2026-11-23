import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ScrollIntoViewOnOpen } from "../scroll-into-view-on-open";

const scroll = vi.fn();
function setup(narrow: boolean, reduced = false) {
  window.HTMLElement.prototype.scrollIntoView = scroll;
  window.matchMedia = ((q: string) => ({
    matches: q.includes("max-width") ? narrow : q.includes("reduce") ? reduced : false,
  })) as never;
}
const ui = (open?: string, below: number | null = 768) => (
  <>
    <ScrollIntoViewOnOpen open={open} targetId="t" headingId="h" below={below ?? undefined} />
    <section id="t">
      <h2 id="h" tabIndex={-1}>
        x
      </h2>
    </section>
  </>
);
afterEach(() => {
  cleanup();
  scroll.mockReset();
});

it("scrolls and focuses when open changes on a narrow layout", () => {
  setup(true);
  const { rerender } = render(ui());
  expect(scroll).not.toHaveBeenCalled();
  rerender(ui("b"));
  expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
  expect(document.activeElement).toBe(document.getElementById("h"));
});

it("also runs on mount when a link from another room opens the page with ?open", () => {
  setup(true);
  render(ui("a"));
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(document.getElementById("h"));
});

it("does nothing without ?open", () => {
  setup(true);
  render(ui(undefined));
  expect(scroll).not.toHaveBeenCalled();
});

it("does nothing on a wide layout, on mount or on change", () => {
  setup(false);
  const { rerender } = render(ui("a"));
  rerender(ui("b"));
  expect(scroll).not.toHaveBeenCalled();
});

it("without a breakpoint the layout is always stacked, so it always scrolls", () => {
  setup(false);
  render(ui("a", null));
  expect(scroll).toHaveBeenCalledTimes(1);
});

it("jumps instead of scrolling smoothly under reduced motion", () => {
  setup(true, true);
  render(ui("a"));
  expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
});
