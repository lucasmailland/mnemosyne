/**
 * The fact plate's actions (5.4): pin, forget, correct and move, each through the route the
 * bridge already serves and each behind a confirmation. Actions the session cannot perform are
 * not offered; the plate says which permission they need.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { I18nProvider } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n/core";
import { FactActions } from "../browser/fact-actions";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const TARGETS = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Team" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Side project" },
];

function renderActions(
  over: Partial<React.ComponentProps<typeof FactActions>> = {},
  locale: Locale = "en-US"
) {
  return render(
    <I18nProvider locale={locale}>
      <FactActions
        id="fact_1"
        statement="Use tabs."
        pinned={false}
        revision={3}
        canWrite
        canDelete
        targets={TARGETS}
        {...over}
      />
    </I18nProvider>
  );
}
const dialog = (name: string) => screen.getByRole("dialog", { name });
const confirmIn = (name: string, button: string) =>
  fireEvent.click(within(dialog(name)).getByRole("button", { name: button }));

it("pins only after the confirmation, then refreshes and says so", async () => {
  renderActions();
  fireEvent.click(screen.getByRole("button", { name: "Pin" }));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(dialog("Pin this memory?")).toHaveAttribute("aria-modal", "true");
  confirmIn("Pin this memory?", "Pin");
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledWith(
    "/dashboard/api/facts/fact_1/pin",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ pinned: true }) })
  );
  expect(screen.getByRole("status")).toHaveTextContent("Pinned.");
});

it("a pinned memory offers Unpin", async () => {
  renderActions({ pinned: true });
  fireEvent.click(screen.getByRole("button", { name: "Unpin" }));
  confirmIn("Unpin this memory?", "Unpin");
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ pinned: false });
});

it("forget explains it closes validity, not a deletion, and cancelling sends nothing", async () => {
  renderActions();
  fireEvent.click(screen.getByRole("button", { name: "Forget" }));
  const d = dialog("Forget this memory?");
  expect(d).toHaveTextContent("closes its validity");
  expect(d).toHaveTextContent("not deleted");
  fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Forget" }));
  confirmIn("Forget this memory?", "Forget");
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledWith(
    "/dashboard/api/facts/fact_1",
    expect.objectContaining({ method: "DELETE" })
  );
});

it("correct sends the new statement with the revision it was read at", async () => {
  renderActions();
  fireEvent.click(screen.getByRole("button", { name: "Correct" }));
  const field = within(dialog("Correct this memory")).getByLabelText("Corrected statement");
  expect(field).toHaveValue("Use tabs.");
  fireEvent.change(field, { target: { value: "Use two spaces." } });
  confirmIn("Correct this memory", "Save the correction");
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledWith(
    "/dashboard/api/facts/fact_1",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ statement: "Use two spaces.", expectedRevision: 3 }),
    })
  );
});

it("a correction that lost a race keeps the dialog and the text, and says why", async () => {
  fetchMock.mockResolvedValue({
    ok: false,
    status: 409,
    json: async () => ({ code: "revision_conflict" }),
  });
  renderActions();
  fireEvent.click(screen.getByRole("button", { name: "Correct" }));
  fireEvent.change(within(dialog("Correct this memory")).getByLabelText("Corrected statement"), {
    target: { value: "Use two spaces." },
  });
  confirmIn("Correct this memory", "Save the correction");
  expect(await within(dialog("Correct this memory")).findByRole("alert")).toHaveTextContent(
    "changed since you opened it"
  );
  expect(within(dialog("Correct this memory")).getByLabelText("Corrected statement")).toHaveValue(
    "Use two spaces."
  );
  expect(refresh).not.toHaveBeenCalled();
});

it("move posts the chosen workspace to the relocate route", async () => {
  renderActions();
  fireEvent.click(screen.getByRole("button", { name: "Move" }));
  const d = dialog("Move this memory");
  expect(d).toHaveTextContent("closes here");
  fireEvent.change(within(d).getByLabelText("Move to"), { target: { value: TARGETS[1]!.id } });
  confirmIn("Move this memory", "Move");
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledWith(
    "/dashboard/api/facts/fact_1/relocate",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ targetWorkspaceId: TARGETS[1]!.id }),
    })
  );
});

it("a confidential memory that cannot move says so", async () => {
  fetchMock.mockResolvedValue({
    ok: false,
    status: 409,
    json: async () => ({ error: "sensitivity_blocked" }),
  });
  renderActions();
  fireEvent.click(screen.getByRole("button", { name: "Move" }));
  confirmIn("Move this memory", "Move");
  expect(await within(dialog("Move this memory")).findByRole("alert")).toHaveTextContent(
    "cannot leave its workspace"
  );
});

it("a read-only session gets no actions, and is told which permissions they need", () => {
  renderActions({ canWrite: false, canDelete: false });
  expect(screen.queryByRole("button")).toBeNull();
  const note = screen.getByRole("note");
  expect(note).toHaveTextContent("memory:write");
  expect(note).toHaveTextContent("memory:delete");
});

it("without a password sign-in there is no Move, and the plate says why", () => {
  renderActions({ targets: null });
  expect(screen.queryByRole("button", { name: "Move" })).toBeNull();
  expect(screen.getByRole("note")).toHaveTextContent("email and password");
});

it("with no other writable workspace there is no Move either", () => {
  renderActions({ targets: [] });
  expect(screen.queryByRole("button", { name: "Move" })).toBeNull();
  expect(screen.getByRole("note")).toHaveTextContent("no other workspace");
});

it("in Spanish", () => {
  renderActions({}, "es-419");
  fireEvent.click(screen.getByRole("button", { name: "Olvidar" }));
  expect(dialog("¿Olvidar este recuerdo?")).toHaveTextContent("no se borra");
  expect(screen.queryByText(/\b(Forget|Pin|Unpin|Correct|Move)\b/)).toBeNull();
});
