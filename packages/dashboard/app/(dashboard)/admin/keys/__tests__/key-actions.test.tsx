/**
 * Keys controls: the request bodies and paths are pinned (the restyle changes no call), and
 * rotate/revoke only send after the confirmation dialog.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SPEC_SCOPES } from "@mnemo-ai/types";

import { Section } from "@/components/keeper";
import { I18nProvider } from "@/lib/i18n/client";
import { PALETTE_NAVIGATE } from "@/components/palette/palette-trigger";
import { CreateKeyForm, KeyActions } from "../key-actions";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
/** Rotate and Revoke sit in the row's "⋯" menu: open it, then pick the item. */
const pick = (item: string, actions = "Actions for CI") => {
  fireEvent.click(screen.getByRole("button", { name: actions }));
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
};

afterEach(() => {
  cleanup();
  refresh.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(status = 200, body: unknown = {}) {
  const fetchMock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("create key", () => {
  it("posts the label, the selected scopes and the expiry, as before", async () => {
    const fetchMock = stubFetch(201, { key: "mn_secret", label: "CI" });
    render(<CreateKeyForm />);
    fireEvent.click(screen.getByRole("button", { name: "+ Create key" }));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "CI" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "memory:write" })); // off
    fireEvent.click(screen.getByRole("checkbox", { name: "memory:delete" })); // on
    fireEvent.change(screen.getByLabelText("Expires (optional)"), { target: { value: "90d" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/admin/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "CI",
        scopes: ["memory:read", "memory:delete"],
        expiresIn: "90d",
      }),
    });
    const shown = await screen.findByText("This key will not be shown again", { exact: false });
    expect(shown).toBeInTheDocument();
    expect(screen.getByText("mn_secret")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("mn_secret")).toBeNull();
  });

  it("never offers memory:hard_delete and offers every other scope", () => {
    render(<CreateKeyForm />);
    fireEvent.click(screen.getByRole("button", { name: "+ Create key" }));
    const names = screen.getAllByRole("checkbox").map((c) => c.closest("label")?.textContent);
    expect(names).not.toContain("memory:hard_delete");
    expect(names).toEqual(SPEC_SCOPES.filter((s) => s !== "memory:hard_delete"));
  });

  it("shows the server's message in an alert", async () => {
    stubFetch(400, { error: { message: "label taken" } });
    render(<CreateKeyForm />);
    fireEvent.click(screen.getByRole("button", { name: "+ Create key" }));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "CI" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("label taken");
  });
});

describe("rotate and revoke", () => {
  it("rotating posts nothing until the dialog is confirmed; cancel posts nothing", async () => {
    const fetchMock = stubFetch(200, { newKey: "mn_new", oldKeySunsetAt: "2030-01-08T00:00:00Z" });
    render(<KeyActions keyId="k/1" label="CI" rotated={false} />);
    pick("Rotate CI");
    const dialog = screen.getByRole("dialog", { name: "Rotate CI" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    pick("Rotate CI");
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Rotate CI" })).getByRole("button", {
        name: "Rotate",
      })
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/admin/keys/k%2F1/rotate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const region = await screen.findByRole("region", { name: "New key for CI" });
    expect(region).toHaveTextContent("will not be shown again");
    expect(within(region).getByText("mn_new")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("revoking sends DELETE only after confirmation", async () => {
    const fetchMock = stubFetch(200);
    render(<KeyActions keyId="k1" label="CI" rotated />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for CI" }));
    expect(screen.queryByRole("menuitem", { name: "Rotate CI" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Revoke CI" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Revoke CI" })).getByRole("button", {
        name: "Revoke",
      })
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/admin/keys/k1", { method: "DELETE" });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  for (const [action, rotated, body] of [
    ["Revoke", true, {}],
    ["Rotate", false, { newKey: "mn_new", oldKeySunsetAt: "2030-01-08T00:00:00Z" }],
  ] as const) {
    it(`after a successful ${action.toLowerCase()} focus moves to ${action === "Rotate" ? "the show-once new key" : "the list's heading"} (its button goes)`, async () => {
      stubFetch(200, body);
      render(
        <Section title="API keys">
          <KeyActions keyId="k1" label="CI" rotated={rotated} />
        </Section>
      );
      pick(`${action} CI`);
      fireEvent.click(
        within(screen.getByRole("dialog", { name: `${action} CI` })).getByRole("button", {
          name: action,
        })
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() =>
        expect(document.activeElement).toBe(
          action === "Rotate"
            ? screen.getByRole("region", { name: "New key for CI" })
            : screen.getByRole("heading", { name: "API keys" })
        )
      );
    });
  }

  it("a failed revoke closes the dialog and says so in an alert", async () => {
    stubFetch(500);
    render(<KeyActions keyId="k1" label="CI" rotated={false} />);
    pick("Revoke CI");
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Revoke CI" })).getByRole("button", {
        name: "Revoke",
      })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not revoke the key (HTTP 500)."
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("speaks Spanish in the confirmation", () => {
    render(
      <I18nProvider locale="es-419">
        <KeyActions keyId="k1" label="CI" rotated={false} />
      </I18nProvider>
    );
    pick("Revocar CI", "Acciones para CI");
    const dialog = screen.getByRole("dialog", { name: "Revocar CI" });
    expect(within(dialog).getByRole("button", { name: "Revocar" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
  });
});

describe("CreateKeyForm defaultOpen (?create=1 from the ⌘K palette)", () => {
  it("starts closed by default and open with defaultOpen", () => {
    render(
      <I18nProvider locale="en-US">
        <CreateKeyForm />
      </I18nProvider>
    );
    expect(screen.getByRole("button", { name: "+ Create key" })).toBeTruthy();
    cleanup();
    render(
      <I18nProvider locale="en-US">
        <CreateKeyForm defaultOpen />
      </I18nProvider>
    );
    expect(screen.queryByRole("button", { name: "+ Create key" })).toBeNull();
  });

  it("opened by ?create=1, the Label field has focus", () => {
    render(<CreateKeyForm defaultOpen />);
    expect(document.activeElement).toBe(screen.getByLabelText("Label"));
  });
});

describe("New API key picked in the palette while this page is open", () => {
  const pick = (href: string) =>
    act(() => {
      window.dispatchEvent(new CustomEvent(PALETTE_NAVIGATE, { detail: href }));
    });

  it("opens the form again after Cancel on the same ?create=1 address, Label focused", () => {
    render(<CreateKeyForm defaultOpen />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "+ Create key" })).toBeTruthy();
    pick("/admin/keys?create=1");
    expect(screen.queryByRole("button", { name: "+ Create key" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Label"));
  });

  it("ignores other picks", () => {
    render(<CreateKeyForm />);
    pick("/admin/members#invite");
    expect(screen.getByRole("button", { name: "+ Create key" })).toBeTruthy();
  });

  it("keeps a just-created key on screen: it is shown once", async () => {
    stubFetch(201, { key: "mn_secret", label: "CI" });
    render(<CreateKeyForm defaultOpen />);
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "CI" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("mn_secret")).toBeTruthy();
    pick("/admin/keys?create=1");
    expect(screen.getByText("mn_secret")).toBeTruthy();
  });
});

describe("copying a key shown once", () => {
  const clipboard = (value: unknown) =>
    Object.defineProperty(navigator, "clipboard", { value, configurable: true });
  afterEach(() => clipboard(undefined));

  it("without a clipboard (plain http) it says to copy the key by hand, for a new and a rotated key", async () => {
    clipboard(undefined);
    stubFetch(201, { key: "mn_secret", label: "CI" });
    render(<CreateKeyForm />);
    fireEvent.click(screen.getByRole("button", { name: "+ Create key" }));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "CI" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not copy. Select the key and copy it by hand."
    );
    cleanup();

    stubFetch(200, { newKey: "mn_new", oldKeySunsetAt: "2030-01-08T00:00:00Z" });
    render(<KeyActions keyId="k1" label="CI" rotated={false} />);
    pick("Rotate CI");
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Rotate CI" })).getByRole("button", {
        name: "Rotate",
      })
    );
    const region = await screen.findByRole("region", { name: "New key for CI" });
    fireEvent.click(within(region).getByRole("button", { name: "Copy" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent("copy it by hand");
  });

  it("with a clipboard it copies the key and says so", async () => {
    const writeText = vi.fn(async () => {});
    clipboard({ writeText });
    stubFetch(201, { key: "mn_secret", label: "CI" });
    render(<CreateKeyForm />);
    fireEvent.click(screen.getByRole("button", { name: "+ Create key" }));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "CI" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copied ✓" })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("mn_secret");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
