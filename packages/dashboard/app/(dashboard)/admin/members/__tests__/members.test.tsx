/**
 * Members page controls (accounts stage A): shown-once link, role limits of an
 * admin, last-owner message.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nProvider } from "@/lib/i18n/client";
import { ROLES } from "@/lib/roles";
import { InvitationsSection, MemberControls } from "../member-actions";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
/** A row action now sits in the row's "⋯" menu: open it, then pick the item. */
const pick = (row: string, item: string, actions = "Actions for") => {
  fireEvent.click(screen.getByRole("button", { name: `${actions} ${row}` }));
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("members controls", () => {
  it("shows an issued link once, read-only, with the recipient named", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "i1",
            link: "http://x/dashboard/link/t0k",
            expiresAt: "2030-01-01T00:00:00Z",
          }),
          { status: 201 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<InvitationsSection invitations={[]} viewerRole="owner" />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "New@E2E.test" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "write" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    const field = (await screen.findByLabelText(
      "Invitation link for new@e2e.test"
    )) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe("http://x/dashboard/link/t0k");
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.getByText(/Shown once\. Share it only with new@e2e\.test\./)).toBeInTheDocument();
    expect(
      JSON.parse(
        String(
          (fetchMock.mock.calls[0] as unknown[])[1] &&
            ((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body
        )
      )
    ).toEqual({
      email: "New@E2E.test",
      role: "write",
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByLabelText(/Invitation link for/)).toBeNull();
  });

  it("an admin cannot offer the owner role nor touch an owner", () => {
    render(
      <>
        <InvitationsSection invitations={[]} viewerRole="admin" />
        <MemberControls
          userId="u1"
          email="o@e2e.test"
          role="owner"
          viewerRole="admin"
          isSelf={false}
        />
      </>
    );
    const options = within(screen.getByLabelText("Role")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Admin", "Contributor", "Viewer"]);
    expect(screen.getByLabelText("Role of o@e2e.test")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("removing the last owner shows the server's refusal in an alert", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "last_owner" }), { status: 409 }))
    );
    render(
      <MemberControls
        userId="u1"
        email="o@e2e.test"
        role="owner"
        viewerRole="owner"
        isSelf={false}
      />
    );
    pick("o@e2e.test", "Remove o@e2e.test");
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Remove o@e2e.test" })).getByRole("button", {
        name: "Remove",
      })
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("A workspace needs at least one owner.");
    // role="alert" is its one live region (APP-058), and focus lands on it: the keyboard is
    // where the error is (the e2e specs hold every form to this).
    expect(alert).not.toHaveAttribute("aria-live");
    await waitFor(() => expect(alert).toHaveFocus());
  });
});

describe("the only owner", () => {
  it("gets no role select and no Leave, but an explanation", () => {
    render(
      <MemberControls
        userId="u1"
        email="solo@e2e.test"
        role="owner"
        viewerRole="owner"
        isSelf
        soleOwner
      />
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Leave/ })).toBeNull();
    // The role shows; why it cannot change waits behind the (i), as its description.
    expect(screen.getByRole("button", { name: "About: Owner" })).toHaveAccessibleDescription(
      /you are the only owner/
    );
  });

  it("keeps the controls when there is another owner", () => {
    render(
      <MemberControls userId="u1" email="a@e2e.test" role="owner" viewerRole="owner" isSelf />
    );
    expect(screen.getByLabelText("Role of a@e2e.test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions for a@e2e.test" }));
    expect(screen.getByRole("menuitem", { name: "Leave this workspace" })).toBeInTheDocument();
  });
});

function stubFetch(status = 200, body: unknown = {}) {
  const fetchMock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const confirmIn = (name: string, verb: string) =>
  fireEvent.click(within(screen.getByRole("dialog", { name })).getByRole("button", { name: verb }));

describe("confirmations and request bodies", () => {
  it("the role select PATCHes the new role, with no dialog", async () => {
    const fetchMock = stubFetch();
    render(
      <MemberControls
        userId="u/1"
        email="r@e2e.test"
        role="read"
        viewerRole="owner"
        isSelf={false}
      />
    );
    fireEvent.change(screen.getByLabelText("Role of r@e2e.test"), { target: { value: "admin" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/workspace/members/u%2F1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("remove sends DELETE only after confirming; cancel sends nothing", async () => {
    const fetchMock = stubFetch();
    render(
      <MemberControls
        userId="u/1"
        email="r@e2e.test"
        role="read"
        viewerRole="owner"
        isSelf={false}
      />
    );
    pick("r@e2e.test", "Remove r@e2e.test");
    const dialog = screen.getByRole("dialog", { name: "Remove r@e2e.test" });
    expect(dialog).toHaveTextContent("Remove r@e2e.test from this workspace?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    pick("r@e2e.test", "Remove r@e2e.test");
    confirmIn("Remove r@e2e.test", "Remove");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/workspace/members/u%2F1", {
      method: "DELETE",
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("leaving is confirmed in a dialog titled like the button", async () => {
    const fetchMock = stubFetch();
    render(
      <MemberControls userId="u1" email="a@e2e.test" role="admin" viewerRole="admin" isSelf />
    );
    pick("a@e2e.test", "Leave this workspace");
    expect(fetchMock).not.toHaveBeenCalled();
    confirmIn("Leave this workspace", "Leave");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("revoking an invitation needs the dialog; a new link needs none", async () => {
    const fetchMock = stubFetch(200, { link: "http://x/l", expiresAt: "2030-01-01T00:00:00Z" });
    render(
      <InvitationsSection
        invitations={[
          { id: "i/1", email: "p@e2e.test", role: "read", expiresAt: "2030-01-01T00:00:00Z" },
        ]}
        viewerRole="owner"
      />
    );
    pick("p@e2e.test", "New link for p@e2e.test");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/dashboard/api/workspace/invitations/i%2F1/regenerate",
      {
        method: "POST",
      }
    );

    pick("p@e2e.test", "Revoke invitation for p@e2e.test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    confirmIn("Revoke invitation for p@e2e.test", "Revoke");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith("/dashboard/api/workspace/invitations/i%2F1", {
      method: "DELETE",
    });
  });

  it("both role selects are driven by ROLES (owner sees all of them)", () => {
    render(
      <>
        <InvitationsSection invitations={[]} viewerRole="owner" />
        <MemberControls
          userId="u1"
          email="r@e2e.test"
          role="read"
          viewerRole="owner"
          isSelf={false}
        />
      </>
    );
    for (const select of [
      screen.getByLabelText("Role"),
      screen.getByLabelText("Role of r@e2e.test"),
    ]) {
      expect(within(select).getAllByRole("option")).toHaveLength(ROLES.length);
    }
  });

  it("speaks Spanish in the confirmation dialogs", () => {
    stubFetch();
    render(
      <I18nProvider locale="es-419">
        <MemberControls
          userId="u1"
          email="r@e2e.test"
          role="read"
          viewerRole="owner"
          isSelf={false}
        />
      </I18nProvider>
    );
    pick("r@e2e.test", "Quitar a r@e2e.test", "Acciones para");
    const dialog = screen.getByRole("dialog", { name: "Quitar a r@e2e.test" });
    expect(within(dialog).getByRole("button", { name: "Quitar" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
  });
});
