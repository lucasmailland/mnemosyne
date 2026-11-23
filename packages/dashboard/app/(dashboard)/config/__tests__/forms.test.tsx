import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { I18nProvider } from "@/lib/i18n/client";
import { es } from "@/lib/i18n/messages/es";
import { LlmConfigForm, WorkspaceModeForm } from "../forms";
import type { LlmConfig, WorkspaceMode } from "../page";

afterEach(() => {
  cleanup();
  refresh.mockClear();
  vi.unstubAllGlobals();
});

const llm: LlmConfig = {
  provider: "openai",
  llmModel: "gpt-x",
  embedModel: "embed-x",
  apiKey: "sk-…abcd",
  source: "workspace",
  canEdit: true,
};
const mode: WorkspaceMode = {
  mode: "learning",
  sessionCount: 3,
  promoteAt: 10,
  startedAt: null,
  factCount: 1,
  entityCount: 2,
};

function stubFetch(status = 200, body: unknown = {}) {
  const fetchMock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

it("saves the LLM config with the same PUT body", async () => {
  const fetchMock = stubFetch();
  render(<LlmConfigForm initial={llm} canEdit />);
  fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "gpt-y" } });
  fireEvent.change(screen.getByPlaceholderText("•••••• leave empty to keep current"), {
    target: { value: " sk-new " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/config/llm", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "openai",
      llmModel: "gpt-y",
      embedModel: "embed-x",
      apiKey: "sk-new",
    }),
  });
  expect(await screen.findByText("Saved.")).toBeTruthy();
  expect(refresh).toHaveBeenCalled();
});

it("sends the base URL for ollama and keeps the provider as the first combobox", async () => {
  const fetchMock = stubFetch();
  render(<LlmConfigForm initial={llm} canEdit />);
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "ollama" } });
  fireEvent.change(screen.getByPlaceholderText("http://localhost:11434"), {
    target: { value: "http://localhost:11434" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const init = (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1];
  expect(JSON.parse(init.body)).toEqual({
    provider: "ollama",
    llmModel: "gpt-x",
    embedModel: "embed-x",
    baseUrl: "http://localhost:11434",
  });
});

it("shows the server's message in an alert on a failed save", async () => {
  stubFetch(422, { message: "Base URL must start with https://" });
  render(<LlmConfigForm initial={llm} canEdit />);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("https://");
});

it("removes the workspace override with a DELETE, only after the dialog is confirmed", async () => {
  const fetchMock = stubFetch();
  render(<LlmConfigForm initial={llm} canEdit />);
  fireEvent.click(screen.getByRole("button", { name: "Remove override" }));
  const dialog = screen.getByRole("dialog", { name: "Remove this workspace's LLM settings?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Remove override" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Remove override" })
  );
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/config/llm", { method: "DELETE" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByRole("status")).toHaveTextContent("Workspace override removed");
});

it("a network failure while removing the override says so in an alert (AUD-006)", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    })
  );
  render(<LlmConfigForm initial={llm} canEdit />);
  fireEvent.click(screen.getByRole("button", { name: "Remove override" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Remove override" })
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not reach the Mnemosyne server."
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("every LLM field is reachable by its label in Spanish", () => {
  render(
    <I18nProvider locale="es-419">
      <LlmConfigForm initial={{ ...llm, provider: "ollama" }} canEdit />
    </I18nProvider>
  );
  for (const label of [
    es.config.provider,
    es.config.llmModel,
    es.config.embedModel,
    es.config.apiKeyWriteOnly,
    es.config.baseUrl,
  ]) {
    expect(screen.getByLabelText(label)).toBeTruthy();
  }
});

it("saves the promotion threshold and the mode with the same PUT bodies", async () => {
  const fetchMock = stubFetch();
  render(<WorkspaceModeForm initial={mode} canEdit />);
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "25" } });
  fireEvent.click(screen.getByRole("button", { name: "Save threshold" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Promote to production" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const bodies = fetchMock.mock.calls.map(
    (c) => (c as unknown as [string, { method: string; body: string }])[1]
  );
  expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/dashboard/api/workspace-mode");
  expect(bodies.map((b) => [b.method, b.body])).toEqual([
    ["PUT", JSON.stringify({ promoteAt: 25 })],
    ["PUT", JSON.stringify({ mode: "production" })],
  ]);
});

it("shows the scope message on a 403", async () => {
  stubFetch(403);
  render(<WorkspaceModeForm initial={mode} canEdit />);
  fireEvent.click(screen.getByRole("button", { name: "Promote to production" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("memory:admin");
});

it("the promote-at field is reachable by its label", () => {
  render(<WorkspaceModeForm initial={mode} canEdit />);
  expect(screen.getByLabelText("Sessions before promotion")).toBe(screen.getByRole("spinbutton"));
});

it("labels the mode counters as what sessions taught, and keeps the threshold help one (i) away", () => {
  render(<WorkspaceModeForm initial={mode} canEdit />);
  // The counters only grow when a session is consolidated: their labels say so, so a zero next
  // to the Explorer's totals reads as a different count, not a broken one.
  expect(screen.getByText("Sessions consolidated").nextSibling).toHaveTextContent("3");
  expect(screen.getByText("Facts from sessions")).toBeInTheDocument();
  expect(screen.getByText("Entities from sessions")).toBeInTheDocument();
  const field = screen.getByLabelText("Sessions before promotion");
  expect(field).toHaveAccessibleDescription(/also promotes itself/);
  expect(screen.getByRole("button", { name: "About: Sessions before promotion" })).toBeTruthy();
  expect(screen.queryByText(/also promotes itself/)).not.toBeVisible();
});
