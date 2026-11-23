import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/lib/i18n/client";
import RecallPage from "../recall/page";

const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(search),
}));
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ hits: [], nothingRelevant: false, debug: { embedded: true } }),
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  fetchMock.mockReset();
  replace.mockReset();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

// Dropping `run` (or recording q) rewrites the address in place, never a router navigation: the
// page segment's key carries the search params, so a navigation remounts the page and the result
// it just drew is lost (the e2e "⌘↵ runs in place" race).
const droppedRunTo = (q: string) => {
  expect(replace).not.toHaveBeenCalled();
  expect(window.location.search).toBe(`?q=${encodeURIComponent(q)}`);
};
const renderPage = () =>
  render(
    <StrictMode>
      <I18nProvider locale="en-US">
        <RecallPage />
      </I18nProvider>
    </StrictMode>
  );

// What the palette writes right before it opens /recall?q=…&run=1 (one shot).
const arm = (q: string) => sessionStorage.setItem("mnemo:palette-run", q);

it("?q=x&run=1 from the palette posts one recall (even under StrictMode), spends the token and drops run", async () => {
  search = "q=x&run=1";
  arm("x");
  renderPage();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("/dashboard/api/recall");
  expect(JSON.parse(init.body)).toMatchObject({ query: "x", debug: true });
  droppedRunTo("x");
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("x");
  expect(sessionStorage.getItem("mnemo:palette-run")).toBeNull();
});

for (const [name, token] of [
  ["without the palette's token", null],
  ["with a token for another query", "y"],
] as const) {
  it(`?q=x&run=1 ${name} only prefills: a link alone never runs a metered recall`, async () => {
    search = "q=x&run=1";
    if (token) arm(token);
    renderPage();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("x");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("mnemo:palette-run")).toBeNull();
  });
}

it("?q=x alone only prefills", async () => {
  search = "q=x";
  renderPage();
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("x");
  await new Promise((r) => setTimeout(r, 20));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

it("round-trips # and unicode through the URL", async () => {
  search = `q=${encodeURIComponent("año #1 & más")}&run=1`;
  arm("año #1 & más");
  renderPage();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).query).toBe("año #1 & más");
  droppedRunTo("año #1 & más");
});

it("on a prefilled bare ?run=1 link, the palette's ⌘↵ runs exactly one recall and drops run", async () => {
  search = "q=x&run=1";
  renderPage();
  await new Promise((r) => setTimeout(r, 20));
  expect(fetchMock).not.toHaveBeenCalled();
  act(() => {
    window.dispatchEvent(new CustomEvent("mnemo:recall-run", { detail: "x" }));
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).query).toBe("x");
  droppedRunTo("x");
  expect(sessionStorage.getItem("mnemo:palette-run")).toBeNull();
});
