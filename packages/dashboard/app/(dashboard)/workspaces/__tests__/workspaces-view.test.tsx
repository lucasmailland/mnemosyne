import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { WorkspacesView, type MyWorkspaces } from "../workspaces-view";

const data: MyWorkspaces = {
  workspaces: [
    { id: "w/1", name: "Mine", role: "owner", isPersonal: true, current: true },
    { id: "w/2", name: "Team", role: "write", isPersonal: false, current: false },
  ],
  ownedTeamCount: 0,
  limit: 5,
};

const assign = vi.fn();
beforeEach(() => {
  vi.stubGlobal("location", { ...window.location, assign });
});
afterEach(() => {
  cleanup();
  assign.mockClear();
  vi.unstubAllGlobals();
});

it("creates a workspace with a POST of { name } and reloads into it", async () => {
  const fetchMock = vi.fn(async () => Response.json({}));
  vi.stubGlobal("fetch", fetchMock);
  render(<WorkspacesView data={data} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Alpha  " } });
  fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith("/dashboard"));
  expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/my-workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Alpha" }),
  });
});

it("switches with a POST to the encoded switch path", async () => {
  const fetchMock = vi.fn(async () => Response.json({}));
  vi.stubGlobal("fetch", fetchMock);
  render(<WorkspacesView data={data} />);
  const list = screen.getByRole("list", { name: "Your workspaces" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  fireEvent.click(within(list).getByRole("button", { name: /^Open / }));
  await waitFor(() => expect(assign).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/my-workspaces/w%2F2/switch", {
    method: "POST",
  });
});

it("shows the code's message in an alert when creating fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "workspace_limit" }, { status: 409 }))
  );
  render(<WorkspacesView data={data} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alpha" } });
  fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(assign).not.toHaveBeenCalled();
});

it("lists the personal workspace with its role and no form at the limit", () => {
  render(<WorkspacesView data={{ ...data, ownedTeamCount: 5 }} />);
  const first = screen.getAllByRole("listitem")[0];
  expect(first).toHaveTextContent(/personal/i);
  expect(first).toHaveTextContent("Owner");
  expect(screen.queryByLabelText("Name")).toBeNull();
  expect(screen.getByRole("note")).toBeTruthy();
});

it("the list sits in a keeper section named like the list", () => {
  render(<WorkspacesView data={data} />);
  expect(screen.getByRole("region", { name: "Your workspaces" })).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Your workspaces" })).toBeInTheDocument();
});
