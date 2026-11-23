import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Sidebar } from "../sidebar";
import { I18nProvider } from "@/lib/i18n/client";
const mockPath = vi.hoisted(() => ({ value: "/" }));
const replace = vi.hoisted(() => vi.fn());
vi.mock("next/link", () => ({
  default: ({ onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      {...props}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    />
  ),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => mockPath.value,
  useRouter: () => ({ replace }),
}));
afterEach(() => {
  cleanup();
  mockPath.value = "/";
  replace.mockReset();
  vi.unstubAllGlobals();
});
it("AUTH-15 names the workspace and exposes a keyboard-operable mobile menu", () => {
  render(<Sidebar role="viewer" workspaceName="Proyecto Alfa" />);
  expect(screen.getByText("Proyecto Alfa")).toBeInTheDocument();
  const toggle = screen.getByRole("button", { name: "Menu" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("link", { name: "My account" })).toBeInTheDocument();
  fireEvent.keyDown(toggle, { key: "Escape" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveFocus();
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("link", { name: "My account" }));
  expect(toggle).toHaveAttribute("aria-expanded", "false");
});

it("lists Members under Admin for admins only", () => {
  const { unmount } = render(<Sidebar role="admin" workspaceName="Alfa" />);
  expect(screen.getByRole("link", { name: "Members" })).toHaveAttribute("href", "/admin/members");
  unmount();
  render(<Sidebar role="contributor" workspaceName="Alfa" />);
  expect(screen.queryByRole("link", { name: "Members" })).toBeNull();
});

it("lists the Installation group for superadmins only", () => {
  const { unmount } = render(<Sidebar role="viewer" workspaceName="Alfa" isSuperadmin />);
  expect(screen.getByText("Installation")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Users" })).toHaveAttribute(
    "href",
    "/installation/users"
  );
  expect(screen.getByRole("link", { name: "Security audit" })).toBeInTheDocument();
  unmount();
  render(<Sidebar role="admin" workspaceName="Alfa" />);
  expect(screen.queryByText("Installation")).toBeNull();
  expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
});

it("the badge names the membership role in the members' vocabulary when known", () => {
  const { unmount } = render(
    <Sidebar role="admin" workspaceRole="owner" workspaceName="Personal" />
  );
  expect(screen.getByText("Owner")).toHaveAttribute("title", "Your role in Personal");
  unmount();
  render(<Sidebar role="contributor" workspaceRole="write" workspaceName="Team" />);
  expect(screen.getByText("Contributor")).toBeInTheDocument();
});

it("an API key session (no membership role) keeps the scope-derived badge, translated", () => {
  const { unmount } = render(<Sidebar role="admin" workspaceRole={null} workspaceName="Alfa" />);
  expect(screen.getByText("Admin")).toBeInTheDocument();
  unmount();
  render(
    <I18nProvider locale="es-419">
      <Sidebar role="viewer" workspaceRole={null} workspaceName="Alfa" />
    </I18nProvider>
  );
  expect(screen.getByText("Lector")).toBeInTheDocument();
});

it("groups the rooms under The palace and The keepers and numbers them", () => {
  render(<Sidebar role="viewer" workspaceName="Alfa" />);
  expect(screen.getByText("The palace")).toBeInTheDocument();
  expect(screen.getByText("The keepers")).toBeInTheDocument();
  expect(within(screen.getByRole("link", { name: /Graph/ })).getByText("V")).toBeInTheDocument();
});

it("marks the current room in the index and the Installation rooms with Greek capitals", () => {
  mockPath.value = "/browser";
  render(<Sidebar role="viewer" workspaceName="Alfa" isSuperadmin />);
  const current = screen.getByRole("link", { name: "Browser" });
  expect(current).toHaveAttribute("aria-current", "page");
  expect(within(current).getByText("II")).toBeInTheDocument();
  expect(within(screen.getByRole("link", { name: "Users" })).getByText("Α")).toBeInTheDocument();
});

it("shows the signed-in account above the account link and sign out", () => {
  render(<Sidebar role="viewer" workspaceName="Alfa" email="ana@example.com" />);
  expect(screen.getByText("ana@example.com")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /My account/ })).toHaveAttribute("href", "/account");
});

it("translates the labels in Spanish", () => {
  render(
    <I18nProvider locale="es-419">
      <Sidebar role="viewer" workspaceName="Alfa" />
    </I18nProvider>
  );
  expect(screen.getByRole("link", { name: /Sesiones/ })).toBeInTheDocument();
});

it("navigating from the open drawer returns focus to the Menu button", () => {
  render(<Sidebar role="viewer" workspaceName="Alfa" />);
  const toggle = screen.getByRole("button", { name: "Menu" });
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("link", { name: "My account" }));
  expect(toggle).toHaveFocus();
});

it("the open drawer is modal: focus moves in, main is inert, Tab wraps, Escape from anywhere closes", () => {
  render(
    <>
      <Sidebar role="viewer" workspaceName="Alfa" />
      <main>Page</main>
    </>
  );
  const main = screen.getByRole("main");
  const toggle = screen.getByRole("button", { name: "Menu" });
  fireEvent.click(toggle);
  // Focus lands on the first link of the drawer, and the page behind is out of reach.
  expect(screen.getByRole("link", { name: "Home" })).toHaveFocus();
  expect(main).toHaveAttribute("inert");

  // Tab from the last control goes back to the Menu button, Shift+Tab the other way.
  const signOut = screen.getByRole("button", { name: "Sign out" });
  signOut.focus();
  fireEvent.keyDown(signOut, { key: "Tab" });
  expect(toggle).toHaveFocus();
  fireEvent.keyDown(toggle, { key: "Tab", shiftKey: true });
  expect(signOut).toHaveFocus();

  // Escape works wherever focus is, and gives focus back to the Menu button.
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveFocus();
  expect(main).not.toHaveAttribute("inert");
});

it("marks the current room with the same rule as the room header, not a bare prefix", () => {
  mockPath.value = "/browserish";
  const { unmount } = render(<Sidebar role="viewer" workspaceName="Alfa" />);
  expect(screen.getByRole("link", { name: /Browser/ })).not.toHaveAttribute("aria-current");
  unmount();
  mockPath.value = "/browser/fact-1";
  render(<Sidebar role="viewer" workspaceName="Alfa" />);
  expect(screen.getByRole("link", { name: /Browser/ })).toHaveAttribute("aria-current", "page");
});

it("a navigation that does not come from a drawer link (the palette) closes the drawer; focus left in it goes to the Menu button", () => {
  const { rerender } = render(<Sidebar role="viewer" workspaceName="Alfa" />);
  const toggle = screen.getByRole("button", { name: "Menu" });
  fireEvent.click(toggle);
  expect(screen.getByRole("link", { name: "Home" })).toHaveFocus();
  mockPath.value = "/browser";
  rerender(<Sidebar role="viewer" workspaceName="Alfa" />);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveFocus();
});

it("a palette pick that keeps the path (only the search changes) closes the drawer too", () => {
  render(<Sidebar role="viewer" workspaceName="Alfa" />);
  const toggle = screen.getByRole("button", { name: "Menu" });
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  act(() => {
    window.dispatchEvent(new Event("mnemo:palette-navigate"));
  });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveFocus();
});

it("the drawer's search bar hands the palette the Menu button as the place to return focus", () => {
  const opened = vi.fn();
  window.addEventListener("mnemo:open-palette", opened);
  render(<Sidebar role="viewer" workspaceName="Alfa" />);
  const toggle = screen.getByRole("button", { name: "Menu" });
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("button", { name: /Search the archive/ }));
  window.removeEventListener("mnemo:open-palette", opened);
  expect((opened.mock.calls[0][0] as CustomEvent).detail).toBe(toggle);
});

it("Escape inside an open modal dialog (the palette) is the dialog's: the drawer stays open", () => {
  render(
    <>
      <Sidebar role="viewer" workspaceName="Alfa" />
      <dialog open>
        <input aria-label="inside" />
      </dialog>
    </>
  );
  const toggle = screen.getByRole("button", { name: "Menu" });
  fireEvent.click(toggle);
  fireEvent.keyDown(screen.getByLabelText("inside"), { key: "Escape" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
});

const signOutWith = (fetchMock: ReturnType<typeof vi.fn>) => {
  vi.stubGlobal("fetch", fetchMock);
  render(<Sidebar role="viewer" workspaceName="Alfa" />);
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
};

it("APP-017 signing out goes to the login once the server has closed the session", async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
  signOutWith(fetchMock);
  expect(screen.getByRole("button", { name: "Signing out…" })).toBeDisabled();
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  expect(fetchMock).toHaveBeenCalledWith("/dashboard/auth/logout", { method: "POST" });
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each([
  ["the server refuses", vi.fn(async () => ({ ok: false, status: 503 }))],
  [
    "the network fails",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  ],
])("APP-017 a sign-out that fails stays on the page and says so (%s)", async (_, fetchMock) => {
  signOutWith(fetchMock);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not sign you out: your session is still open. Try again."
  );
  expect(replace).not.toHaveBeenCalled();
  // the button is usable again, and a second try that works clears the message
  const button = screen.getByRole("button", { name: "Sign out" });
  expect(button).toBeEnabled();
  fetchMock.mockImplementation(async () => ({ ok: true, status: 200 }));
  fireEvent.click(button);
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("APP-044 the workspace list is asked for once per opening, and again only on Try again", async () => {
  const fetchMock = vi.fn(async () => Response.json({ error: "boom" }, { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<Sidebar role="admin" workspaceRole="owner" workspaceName="Alfa" />);
  const toggle = screen.getByRole("button", { name: /Switch workspace/ });
  fireEvent.click(toggle);
  expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 500");
  // a failure does not start another request on its own
  await act(() => new Promise((r) => setTimeout(r, 50)));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockImplementation(async () =>
    Response.json({
      workspaces: [{ id: "w1", name: "Alfa", role: "owner", current: true, isPersonal: false }],
    })
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("button", { name: /Alfa/, current: true })).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
  // closing and opening again after a success does not ask again
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("APP-044 a failed list is asked for again when the menu is opened again", async () => {
  const fetchMock = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<Sidebar role="admin" workspaceRole="owner" workspaceName="Alfa" />);
  const toggle = screen.getByRole("button", { name: /Switch workspace/ });
  fireEvent.click(toggle);
  await screen.findByRole("alert");
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await act(() => new Promise((r) => setTimeout(r, 50)));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("APP-043 a workspace list the server takes too long on says so, and Try again asks again", async () => {
  const fetchMock = vi.fn(async (..._: unknown[]): Promise<Response> => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<Sidebar role="admin" workspaceRole="owner" workspaceName="Alfa" />);
  fireEvent.click(screen.getByRole("button", { name: /Switch workspace/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The server took too long to answer. Try again in a moment."
  );
  expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/my-workspaces", {
    signal: expect.any(AbortSignal),
  });
  fetchMock.mockImplementation(async () =>
    Response.json({
      workspaces: [{ id: "w1", name: "Alfa", role: "owner", current: true, isPersonal: false }],
    })
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("button", { name: /Alfa/, current: true })).toBeDisabled();
});
