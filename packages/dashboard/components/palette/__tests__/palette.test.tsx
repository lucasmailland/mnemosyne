import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/lib/i18n/client";
import { Palette } from "../palette";
import { PALETTE_NAVIGATE, PaletteTrigger } from "../palette-trigger";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const fetchMock = vi.fn();
const respond = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => body,
});
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockImplementation(async (url: string) =>
    url.startsWith("/dashboard/api/facts")
      ? respond({ items: [{ id: "fact-aaaaaa", statement: "Checkout uses Stripe" }], total: 1 })
      : respond({ items: [{ id: "ent-bbbbbb", name: "Stripe", kind: "tool" }] })
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.useRealTimers();
  push.mockReset();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const setup = ({ locale = "en-US", personal = false } = {}) =>
  render(
    <I18nProvider locale={locale as "en-US" | "es-419"}>
      <PaletteTrigger />
      <Palette role="admin" isSuperadmin={false} personal={personal} />
    </I18nProvider>
  );
// jsdom reports no platform, which reads as Apple: ⌘K.
const openIt = () => fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
const type = (value: string) =>
  fireEvent.change(screen.getByRole("combobox"), { target: { value } });
const settle = () => act(() => vi.advanceTimersByTimeAsync(250));
const urls = () => fetchMock.mock.calls.map((c) => c[0] as string);

it("types without ever calling recall: one facts and one entities request after 200 ms", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  setup();
  openIt();
  type("a");
  await settle();
  expect(fetchMock).not.toHaveBeenCalled();
  type("ab");
  await settle();
  expect(urls().sort()).toEqual([
    "/dashboard/api/entities?q=ab&limit=5",
    "/dashboard/api/facts?q=ab&limit=5",
  ]);
  expect(urls().some((u) => u.includes("/recall"))).toBe(false);
  // APP-043: each request times out on its own, past the palette's own cancel.
  expect(timeout).toHaveBeenCalledTimes(2);
  timeout.mockRestore();
  expect(screen.getByRole("option", { name: /Checkout uses Stripe/ })).toBeTruthy();
});

it("is not in the DOM while closed and toggles on Ctrl/⌘K", () => {
  setup();
  expect(screen.queryByRole("combobox")).toBeNull();
  openIt();
  expect(screen.getByRole("combobox")).toBeTruthy();
  openIt();
  expect(screen.queryByRole("combobox")).toBeNull();
  fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true, isComposing: true });
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("arrows move aria-activedescendant (wrapping) and Enter opens a room", () => {
  setup();
  openIt();
  const box = screen.getByRole("combobox");
  const first = box.getAttribute("aria-activedescendant");
  expect(first).toBeTruthy();
  fireEvent.keyDown(box, { key: "ArrowDown" });
  expect(box.getAttribute("aria-activedescendant")).not.toBe(first);
  fireEvent.keyDown(box, { key: "ArrowUp" });
  expect(box.getAttribute("aria-activedescendant")).toBe(first);
  fireEvent.keyDown(box, { key: "ArrowUp" });
  expect(box.getAttribute("aria-activedescendant")).not.toBe(first);
  type("recall");
  fireEvent.keyDown(box, { key: "Enter" });
  expect(push).toHaveBeenCalledWith("/recall");
});

it("⌘↵ opens /recall?q=…&run=1 and leaves Recall the one-shot token for that text", () => {
  setup();
  openIt();
  type(" a b&c ");
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", metaKey: true });
  expect(push).toHaveBeenCalledWith("/recall?q=a%20b%26c&run=1");
  expect(sessionStorage.getItem("mnemo:palette-run")).toBe("a b&c");
});

// On the recall page the URL can already read as the target (or look different yet decode to
// it: "+" for a space, reordered or extra params). No URL comparison: the palette never arms a
// token there; it tells the page to run once, so no token can be left for a later bare link.
for (const url of [
  "/dashboard/recall?q=a+b&run=1",
  "/dashboard/recall?run=1&q=a%20b",
  "/dashboard/recall?q=a%20b&run=1&x=1",
  "/dashboard/recall?q=a%20b",
]) {
  it(`⌘↵ on ${url} asks the recall page for exactly one run and arms no token`, () => {
    history.pushState({}, "", url);
    const ran = vi.fn();
    window.addEventListener("mnemo:recall-run", ran);
    try {
      setup();
      openIt();
      type("a b");
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", metaKey: true });
      expect(ran).toHaveBeenCalledTimes(1);
      expect((ran.mock.calls[0][0] as CustomEvent).detail).toBe("a b");
      expect(sessionStorage.getItem("mnemo:palette-run")).toBeNull();
    } finally {
      window.removeEventListener("mnemo:recall-run", ran);
      history.pushState({}, "", "/");
    }
  });
}

it("picking a result tells the sidebar to close its drawer", () => {
  const picked = vi.fn();
  window.addEventListener(PALETTE_NAVIGATE, picked);
  try {
    setup();
    openIt();
    type("recall");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/recall");
    expect(picked).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener(PALETTE_NAVIGATE, picked);
  }
});

it("opens fact and entity results with encoded urls", async () => {
  setup();
  openIt();
  type("st");
  await settle();
  fireEvent.click(screen.getByRole("option", { name: /Checkout uses Stripe/ }));
  expect(push).toHaveBeenCalledWith("/browser?open=fact-aaaaaa");
  openIt();
  type("st");
  await settle();
  fireEvent.click(screen.getByRole("option", { name: /^Stripe/ }));
  expect(push).toHaveBeenLastCalledWith("/browser?type=entities&q=Stripe");
});

it("a failing group shows a quiet line while the other still works", async () => {
  fetchMock.mockImplementation(async (url: string) =>
    url.startsWith("/dashboard/api/facts")
      ? respond({}, false)
      : respond({ items: [{ id: "ent-bbbbbb", name: "Stripe" }] })
  );
  setup();
  openIt();
  type("st");
  await settle();
  expect(screen.getByText("Could not load these results.")).toBeTruthy();
  expect(screen.getByRole("option", { name: /^Stripe/ })).toBeTruthy();
});

it("Escape (the dialog's cancel event) returns focus to the trigger once the dialog is gone", () => {
  setup();
  const trigger = screen.getByRole("button", { name: /Search the archive/ });
  const realFocus = trigger.focus.bind(trigger);
  // While a modal dialog is open the opener is inert: focus() does nothing.
  vi.spyOn(trigger, "focus").mockImplementation(() => {
    if (document.querySelector("dialog[open]")) return;
    realFocus();
  });
  fireEvent.click(trigger);
  expect(screen.getByRole("combobox")).toBeTruthy();
  fireEvent(document.querySelector("dialog")!, new Event("cancel", { cancelable: true }));
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("announces searching, then the result count, then no matches", async () => {
  setup();
  openIt();
  const live = () => screen.getByRole("status");
  expect(live().textContent).toBe("");
  // Matches no room or action: only the fact and the entity count.
  type("qx");
  expect(live().textContent).toBe("Searching…");
  await settle();
  expect(live().textContent).toBe("2 results");
  type("zzzz");
  await settle();
  fetchMock.mockImplementation(async () => respond({ items: [] }));
  type("qqqq");
  await settle();
  expect(live().textContent).toBe("No matches.");
});

it("⌘↵ with empty text does nothing; Shift+⌘K and repeats do not open", () => {
  setup();
  fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true, shiftKey: true });
  fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true, repeat: true });
  expect(screen.queryByRole("combobox")).toBeNull();
  openIt();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", metaKey: true });
  expect(push).not.toHaveBeenCalled();
});

it("renders only groups that have items", () => {
  setup();
  openIt();
  type("recall");
  expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Rooms"]);
});

it("drops a stale response that resolves after a newer one", async () => {
  const pending: Record<string, (v: unknown) => void> = {};
  fetchMock.mockImplementation((url: string) => new Promise((resolve) => (pending[url] = resolve)));
  setup();
  openIt();
  type("aa");
  await settle();
  type("bb");
  await settle();
  const facts = (name: string) => respond({ items: [{ id: `f-${name}`, statement: name }] });
  pending["/dashboard/api/facts?q=bb&limit=5"](facts("new one"));
  pending["/dashboard/api/facts?q=aa&limit=5"](facts("old one"));
  await settle();
  expect(screen.queryByRole("option", { name: /old one/ })).toBeNull();
  expect(screen.getByRole("option", { name: /new one/ })).toBeTruthy();
});

const onPlatform = (platform: string) =>
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);

it("on macOS ⌘K opens and Ctrl+K is left alone; elsewhere Ctrl+K opens; the key is read by its code", () => {
  onPlatform("MacIntel");
  const { unmount } = setup();
  fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
  expect(screen.queryByRole("combobox")).toBeNull();
  // A layout where the K key types something else still opens it.
  fireEvent.keyDown(window, { key: "л", code: "KeyK", metaKey: true });
  expect(screen.getByRole("combobox")).toBeTruthy();
  unmount();
  onPlatform("Linux x86_64");
  setup();
  fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
  expect(screen.queryByRole("combobox")).toBeNull();
  fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
  expect(screen.getByRole("combobox")).toBeTruthy();
});

it("⌘↵ follows the same platform rule as ⌘K: Ctrl+↵ runs nothing on macOS, ⌘↵ nothing elsewhere", () => {
  onPlatform("MacIntel");
  const { unmount } = setup();
  openIt();
  type("porto");
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", ctrlKey: true });
  expect(push).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("mnemo:palette-run")).toBeNull();
  unmount();
  onPlatform("Linux x86_64");
  setup();
  fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
  type("porto");
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", metaKey: true });
  expect(push).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", ctrlKey: true });
  expect(push).toHaveBeenCalledWith("/recall?q=porto&run=1");
});

it("a pick tells the page where it goes (PALETTE_NAVIGATE carries the address)", () => {
  const picked = vi.fn();
  window.addEventListener(PALETTE_NAVIGATE, picked);
  try {
    setup();
    openIt();
    type("New API");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect((picked.mock.calls[0][0] as CustomEvent).detail).toBe("/admin/keys?create=1");
  } finally {
    window.removeEventListener(PALETTE_NAVIGATE, picked);
  }
});

it("off macOS the shortcuts read Ctrl K and Ctrl+↵", () => {
  onPlatform("Win32");
  setup();
  expect(screen.getByRole("button", { name: /Search the archive/ }).textContent).toContain(
    "Ctrl K"
  );
  fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
  expect(screen.getByText(/Ctrl\+↵ recall/)).toBeTruthy();
});

it("the active option scrolls into view and is marked by a rule, not a faint fill", () => {
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  setup();
  openIt();
  const box = screen.getByRole("combobox");
  for (let i = 0; i < 12; i++) fireEvent.keyDown(box, { key: "ArrowDown" });
  const active = document.getElementById(box.getAttribute("aria-activedescendant")!)!;
  expect(scrolled.mock.contexts.at(-1)).toBe(active);
  expect(scrolled).toHaveBeenLastCalledWith({ block: "nearest" });
  expect(active.className).toContain("border-accent");
  // @ts-expect-error jsdom has no scrollIntoView of its own
  delete Element.prototype.scrollIntoView;
});

it("rooms also match their title, without accents", () => {
  setup({ locale: "es-419" });
  openIt();
  type("leteo");
  expect(screen.getByRole("option", { name: /Recall/ })).toBeTruthy();
  type("catalogo");
  expect(screen.getByRole("option", { name: /Explorador/ })).toBeTruthy();
  type("configuracion");
  expect(screen.getByRole("option", { name: /Configuración/ })).toBeTruthy();
});

it('a personal workspace is not offered "Invite a member"', () => {
  setup({ personal: true });
  openIt();
  expect(screen.queryByRole("option", { name: /Invite a member/ })).toBeNull();
  expect(screen.getByRole("option", { name: /New API key/ })).toBeTruthy();
});

it("does not open over another modal dialog", () => {
  setup();
  const other = document.createElement("dialog");
  other.setAttribute("open", "");
  document.body.append(other);
  openIt();
  expect(screen.queryByRole("combobox")).toBeNull();
  other.remove();
  openIt();
  expect(screen.getByRole("combobox")).toBeTruthy();
});

it("closes on browser Back and locks the page scroll while open", () => {
  setup();
  openIt();
  expect(document.body.style.overflow).toBe("hidden");
  fireEvent(window, new PopStateEvent("popstate"));
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(document.body.style.overflow).toBe("");
});

it("APP-058 the palette dialog says it is modal", () => {
  setup();
  openIt();
  expect(document.querySelector("dialog")).toHaveAttribute("aria-modal", "true");
});
