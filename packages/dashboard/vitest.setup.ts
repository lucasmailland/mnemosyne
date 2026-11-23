import "@testing-library/jest-dom/vitest";

// jsdom has no Popover API (components/ui/popover.tsx). The smallest stand-in for what the
// components rely on, after the HTML spec: show/hide/toggle firing `toggle` with newState, an
// auto popover closing the others that are not its ancestors, popovertarget buttons, Escape on the
// topmost one, focus back to what had it before when focus was inside, and a closed popover
// hidden (display: none, so queries skip it as in a browser).
if (typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover !== "function") {
  const open = new Map<HTMLElement, Element | null>();
  const style = document.createElement("style");
  style.textContent = "[popover]:not([data-popover-open]) { display: none; }";
  document.head.appendChild(style);
  const fire = (el: HTMLElement, newState: "open" | "closed") =>
    el.dispatchEvent(
      Object.assign(new Event("toggle"), {
        newState,
        oldState: newState === "open" ? "closed" : "open",
      })
    );
  const proto = HTMLElement.prototype;
  proto.showPopover = function (this: HTMLElement) {
    if (open.has(this)) return;
    for (const other of [...open.keys()]) if (!other.contains(this)) other.hidePopover();
    open.set(this, document.activeElement);
    this.setAttribute("data-popover-open", "");
    fire(this, "open");
  };
  proto.hidePopover = function (this: HTMLElement) {
    if (!open.has(this)) return;
    const before = open.get(this);
    open.delete(this);
    this.removeAttribute("data-popover-open");
    if (this.contains(document.activeElement) && before instanceof HTMLElement) before.focus();
    fire(this, "closed");
  };
  proto.togglePopover = function (this: HTMLElement) {
    if (open.has(this)) this.hidePopover();
    else this.showPopover();
    return open.has(this);
  };
  document.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest?.("[popovertarget]");
    if (!button || event.defaultPrevented) return;
    document.getElementById(button.getAttribute("popovertarget") ?? "")?.togglePopover();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented) [...open.keys()].at(-1)?.hidePopover();
  });
}
