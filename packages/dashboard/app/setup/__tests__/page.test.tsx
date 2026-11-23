import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import SetupPage from "../page";

const router = vi.hoisted(() => ({ replace: () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});

it("without a clipboard (plain http) the show-once key says to copy it by hand", async () => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("status")
        ? Response.json({ bootstrapped: false })
        : new Response(null, { status: 201 })
    )
  );
  render(<SetupPage />);
  fireEvent.change(screen.getByLabelText("Setup token"), { target: { value: "tok" } });
  fireEvent.click(screen.getByRole("button", { name: /Create workspace/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not copy. Select the key and copy it by hand."
  );
});

it("5.2 asks for no workspace UUID and shows no editable key: it generates both and shows the key once", async () => {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
    url.endsWith("status")
      ? Response.json({ bootstrapped: false })
      : new Response(null, { status: 201 })
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<SetupPage />);
  expect(screen.queryByLabelText(/Workspace ID/)).toBeNull();
  expect(screen.queryByLabelText(/API key/)).toBeNull();
  // Only the setup token and the optional administrator account are typed.
  expect(screen.getAllByRole("textbox").map((el) => el.id)).toEqual(["setupToken", "adminEmail"]);
  fireEvent.change(screen.getByLabelText("Setup token"), { target: { value: " tok " } });
  fireEvent.click(screen.getByRole("button", { name: /Create workspace/ }));
  await screen.findByRole("button", { name: "Copy" });
  // APP-043: the status check gives up on a server that never answers.
  expect(fetchMock).toHaveBeenCalledWith("/dashboard/bootstrap/status", {
    signal: expect.any(AbortSignal),
  });
  const post = fetchMock.mock.calls.find(([url]) => url === "/dashboard/bootstrap")!;
  const body = JSON.parse(String(post[1]!.body)) as Record<string, string>;
  expect(body.setupToken).toBe("tok");
  expect(body.workspaceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(body.apiKey).toMatch(/^mns_live_[a-z0-9]{32}$/);
  // The key shown once is the one the server stored, in a read-only element.
  expect(screen.getByText(body.apiKey)).toBeInTheDocument();
  expect(screen.getByText(body.apiKey).tagName).toBe("CODE");
});
