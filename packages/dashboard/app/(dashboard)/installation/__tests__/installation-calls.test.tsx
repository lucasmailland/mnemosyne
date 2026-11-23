/**
 * The installation views' requests are pinned (the restyle changes no call):
 * settings PUT body, users dialog flows and the workspaces member flows.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { I18nProvider } from "@/lib/i18n/client";
import { SettingsForm, type SettingsView } from "../settings/settings-form";
import { UsersView, type InstanceUser } from "../users/users-view";
import { WorkspacesView, type InstanceWorkspace } from "../workspaces/workspaces-view";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
/** A user's actions sit in the row's "⋯" menu: open it, then pick the item. */
const pick = (email: string, item: string) => {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${email}` }));
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
};

afterEach(() => {
  cleanup();
  refresh.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const settings: SettingsView = {
  invitationsEnabled: true,
  publicBaseUrl: null,
  registrationMode: "closed",
  workspaceLlmOverride: false,
  workspaceLimitPerUser: 3,
  source: {
    invitationsEnabled: "default",
    publicBaseUrl: "env",
    registrationMode: "default",
    workspaceLlmOverride: "default",
    workspaceLimitPerUser: "global",
  },
};

describe("settings", () => {
  it("keeps each help text behind an (i), still the control's description", () => {
    render(<SettingsForm initial={settings} />);
    const box = screen.getByRole("checkbox", { name: "Workspace invitations enabled" });
    expect(box).toHaveAccessibleDescription(/When off, owners and admins cannot create/);
    expect(screen.getByText(/When off, owners and admins cannot create/)).not.toBeVisible();
    expect(
      screen.getByRole("button", { name: "About: Workspace invitations enabled" })
    ).toBeInTheDocument();
  });

  it("shows a source tag per setting and nothing to save until a value changes", () => {
    render(<SettingsForm initial={settings} />);
    expect(screen.getAllByText(/^source: /).map((n) => n.textContent)).toEqual([
      "source: default",
      "source: env",
      "source: default",
      "source: global",
      "source: default",
    ]);
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });

  it("PUTs only what changed", async () => {
    const fetchMock = stubFetch(() =>
      Response.json({ ...settings, invitationsEnabled: false, publicBaseUrl: "https://m.test" })
    );
    render(<SettingsForm initial={settings} />);
    fireEvent.click(screen.getByLabelText("Workspace invitations enabled"));
    fireEvent.change(screen.getByLabelText("Public base URL"), {
      target: { value: " https://m.test " },
    });
    fireEvent.change(screen.getByLabelText("Workspaces per user"), { target: { value: "5" } });
    fireEvent.click(screen.getByLabelText("Workspace owners can set their own model"));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/instance/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitationsEnabled: false,
        publicBaseUrl: "https://m.test",
        workspaceLlmOverride: true,
        workspaceLimitPerUser: 5,
      }),
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Settings saved.");
  });

  it("clearing the address sends null; an invalid limit sends nothing", async () => {
    const fetchMock = stubFetch(() => Response.json(settings));
    render(<SettingsForm initial={{ ...settings, publicBaseUrl: "https://a.test" }} />);
    fireEvent.change(screen.getByLabelText("Public base URL"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      publicBaseUrl: null,
    });
    cleanup();

    const second = stubFetch(() => Response.json(settings));
    render(<SettingsForm initial={settings} />);
    const limit = screen.getByLabelText("Workspaces per user");
    fireEvent.change(limit, { target: { value: "5000" } });
    // The input's max blocks a click on submit in the browser; the handler guards the same value.
    fireEvent.submit(limit.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("whole number from 0 to 1000");
    expect(second).not.toHaveBeenCalled();
  });

  it("a failed save shows the coded message", async () => {
    stubFetch(() => Response.json({ error: "invalid_public_base_url" }, { status: 400 }));
    render(<SettingsForm initial={settings} />);
    fireEvent.click(screen.getByLabelText("Workspace invitations enabled"));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("https://");
  });
});

const user = (over: Partial<InstanceUser> = {}): InstanceUser => ({
  id: "u 1",
  email: "a@e2e.test",
  displayName: null,
  createdAt: "2026-11-01T00:00:00Z",
  lastLoginAt: null,
  disabledAt: null,
  isSuperadmin: false,
  workspaces: [{ id: "w1", name: "Team", role: "read" }],
  ...over,
});
const JSON_HEADERS = { "content-type": "application/json" };

describe("users", () => {
  it("lists status, superadmin, you, and the role word of each workspace", () => {
    render(
      <UsersView
        viewerId="me"
        users={[
          user({ id: "me", email: "me@e2e.test", isSuperadmin: true }),
          user({ id: "u2", email: "off@e2e.test", disabledAt: "2026-11-02T00:00:00Z" }),
        ]}
      />
    );
    const rows = within(screen.getByRole("list", { name: "Users" })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("me@e2e.test");
    expect(rows[0]).toHaveTextContent("Superadmin");
    expect(rows[0]).toHaveTextContent("(you)");
    expect(rows[0]).toHaveTextContent("Active");
    expect(rows[0]).toHaveTextContent("Team (Viewer)");
    expect(rows[1]).toHaveTextContent("Disabled");
    expect(rows[1]).toHaveTextContent("Never signed in");
    fireEvent.click(screen.getByRole("button", { name: "Actions for off@e2e.test" }));
    expect(screen.getByRole("menuitem", { name: "Enable off@e2e.test" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions for me@e2e.test" }));
    expect(screen.getByRole("menuitem", { name: "Offboard me@e2e.test" })).toBeDisabled();
  });

  it("create user posts the trimmed email and name, then shows the setup link", async () => {
    const fetchMock = stubFetch(() =>
      Response.json({
        link: "https://x.test/dashboard/link/abc",
        expiresAt: "2026-12-01T00:00:00Z",
      })
    );
    render(<UsersView viewerId="me" users={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    const dialog = screen.getByRole("dialog", { name: "Create user" });
    fireEvent.change(within(dialog).getByLabelText("Email"), {
      target: { value: " New@E2E.test " },
    });
    fireEvent.change(within(dialog).getByLabelText("Name (optional)"), {
      target: { value: " New Comer " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create user" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/instance/users", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: "New@E2E.test", displayName: "New Comer" }),
    });
    expect(await screen.findByLabelText("Account setup link for new@e2e.test")).toHaveValue(
      "https://x.test/dashboard/link/abc"
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("disable asks first and posts to the encoded path", async () => {
    const fetchMock = stubFetch(() => Response.json({}));
    render(<UsersView viewerId="me" users={[user()]} />);
    pick("a@e2e.test", "Disable a@e2e.test");
    const dialog = screen.getByRole("dialog", { name: "Disable a@e2e.test" });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/instance/users/u%201/disable", {
      method: "POST",
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("enable and reset link post without asking", async () => {
    const fetchMock = stubFetch((url) =>
      url.endsWith("reset-link")
        ? Response.json({ link: "https://x.test/l", expiresAt: "2026-12-01T00:00:00Z" })
        : Response.json({})
    );
    render(
      <UsersView
        viewerId="me"
        users={[user({ id: "d", email: "d@e2e.test", disabledAt: "2026-11-02T00:00:00Z" }), user()]}
      />
    );
    pick("d@e2e.test", "Enable d@e2e.test");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/instance/users/d/enable", {
        method: "POST",
      })
    );
    pick("a@e2e.test", "Reset link for a@e2e.test");
    expect(await screen.findByLabelText("Password reset link for a@e2e.test")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith("/dashboard/api/instance/users/u%201/reset-link", {
      method: "POST",
    });
  });

  it("grant sends the password with POST, revoke with DELETE; a wrong password empties the field", async () => {
    const fetchMock = stubFetch(() =>
      Response.json({ error: "invalid_credentials" }, { status: 401 })
    );
    render(
      <UsersView
        viewerId="me"
        users={[user(), user({ id: "s", email: "s@e2e.test", isSuperadmin: true })]}
      />
    );
    pick("a@e2e.test", "Grant superadmin to a@e2e.test");
    let dialog = screen.getByRole("dialog", { name: "Grant superadmin to a@e2e.test" });
    fireEvent.change(within(dialog).getByLabelText("Your password"), { target: { value: "pw" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Grant superadmin" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "That password is not correct."
    );
    expect(within(dialog).getByLabelText("Your password")).toHaveValue("");
    expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/instance/users/u%201/superadmin", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ password: "pw" }),
    });
    fireEvent.keyDown(dialog, { key: "Escape" });
    cleanup();

    const second = stubFetch(() => Response.json({}));
    render(
      <UsersView
        viewerId="me"
        users={[user({ id: "s", email: "s@e2e.test", isSuperadmin: true })]}
      />
    );
    pick("s@e2e.test", "Revoke superadmin from s@e2e.test");
    dialog = screen.getByRole("dialog", { name: "Revoke superadmin from s@e2e.test" });
    fireEvent.change(within(dialog).getByLabelText("Your password"), { target: { value: "pw2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke superadmin" }));
    await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(second).toHaveBeenCalledWith("/dashboard/api/instance/users/s/superadmin", {
      method: "DELETE",
      headers: JSON_HEADERS,
      body: JSON.stringify({ password: "pw2" }),
    });
  });

  it("offboard: a 409 owner_required asks for a new owner per workspace, then posts newOwners", async () => {
    let calls = 0;
    const fetchMock = stubFetch(() =>
      ++calls === 1
        ? Response.json(
            { error: "owner_required", workspaces: [{ id: "w9", name: "Orphans" }] },
            { status: 409 }
          )
        : Response.json({})
    );
    render(
      <UsersView
        viewerId="me"
        users={[
          user({ id: "gone", email: "gone@e2e.test" }),
          user({ id: "heir", email: "heir@e2e.test" }),
          user({ id: "off", email: "off@e2e.test", disabledAt: "2026-11-02T00:00:00Z" }),
        ]}
      />
    );
    pick("gone@e2e.test", "Offboard gone@e2e.test");
    const dialog = screen.getByRole("dialog", { name: "Offboard gone@e2e.test" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Offboard" }));
    const select = await within(dialog).findByLabelText("New owner of Orphans");
    const options = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["Choose a user…", "heir@e2e.test"]);
    fireEvent.change(select, { target: { value: "heir" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Offboard" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/dashboard/api/instance/users/gone/offboard", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ newOwners: {} }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/dashboard/api/instance/users/gone/offboard", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ newOwners: { w9: "heir" } }),
    });
  });
});

const workspace = (over: Partial<InstanceWorkspace> = {}): InstanceWorkspace => ({
  id: "w 1",
  name: "Team",
  tenantName: "t",
  isPersonal: false,
  visibility: "private",
  memberCount: 2,
  owners: [{ id: "o", email: "o@e2e.test", displayName: null }],
  ...over,
});
const member = (userId: string, email: string, role: string) => ({
  userId,
  email,
  displayName: null,
  role,
  joinedAt: "2026-11-01T00:00:00Z",
});

describe("workspaces", () => {
  it("summarizes members and owners, and flags a workspace with no owner", () => {
    render(
      <WorkspacesView
        workspaces={[
          workspace(),
          workspace({ id: "w2", name: "Orphan", memberCount: 0, owners: [] }),
          workspace({ id: "w3", name: "Mine", isPersonal: true, owners: [] }),
        ]}
      />
    );
    const items = within(screen.getByRole("list", { name: "Workspaces" })).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("2 members · owner: o@e2e.test");
    expect(items[1]).toHaveTextContent("0 members · owners: none");
    expect(items[1]).toHaveTextContent("Nobody can manage this workspace until it has an owner.");
    expect(items[2]).toHaveTextContent("Personal");
    expect(items[2]).not.toHaveTextContent("Nobody can manage");
  });

  it("members: lists them, changes a role, removes after confirming, adds by email", async () => {
    const fetchMock = stubFetch((_url, init) =>
      !init || init.method === "GET"
        ? Response.json({
            members: [member("m 1", "m@e2e.test", "read"), member("m2", "o@e2e.test", "owner")],
          })
        : Response.json({})
    );
    render(<WorkspacesView workspaces={[workspace()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Members of Team" }));
    const role = await screen.findByLabelText("Role of m@e2e.test in Team");
    expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/instance/workspaces/w%201/members", {
      method: "GET",
    });
    expect(role).toHaveValue("read");
    expect(
      within(role)
        .getAllByRole("option")
        .map((o) => o.textContent)
    ).toEqual(["Owner", "Admin", "Contributor", "Viewer"]);

    fireEvent.change(role, { target: { value: "write" } });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/dashboard/api/instance/workspaces/w%201/members/m%201",
        {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ role: "write" }),
        }
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove m@e2e.test from Team" }));
    const dialog = screen.getByRole("dialog", { name: "Remove m@e2e.test" });
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === "DELETE")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove member" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/dashboard/api/instance/workspaces/w%201/members/m%201",
        {
          method: "DELETE",
        }
      )
    );

    const form = screen.getByRole("form", { name: "Add a member to Team" });
    fireEvent.change(within(form).getByLabelText("Email"), { target: { value: " n@e2e.test " } });
    fireEvent.click(within(form).getByRole("button", { name: "Add member" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/instance/workspaces/w%201/members", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: "n@e2e.test", role: "write" }),
      })
    );
  });

  it("a workspace with no owner starts the add form at Owner; a personal one has no form", async () => {
    stubFetch(() => Response.json({ members: [] }));
    render(
      <WorkspacesView
        workspaces={[
          workspace({ id: "a", name: "Orphan", owners: [] }),
          workspace({ id: "b", name: "Mine", isPersonal: true }),
        ]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Members of Orphan" }));
    const form = await screen.findByRole("form", { name: "Add a member to Orphan" });
    expect(within(form).getByLabelText("Role")).toHaveValue("owner");
    fireEvent.click(screen.getByRole("button", { name: "Members of Mine" }));
    await screen.findByText("No members yet.", { selector: "li *, p" }).catch(() => null);
    expect(screen.queryByRole("form", { name: "Add a member to Mine" })).not.toBeInTheDocument();
  });
});
