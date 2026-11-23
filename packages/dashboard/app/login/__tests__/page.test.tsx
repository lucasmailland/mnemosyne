/**
 * TEST-2 — component test for the login form (packages/dashboard had zero
 * test coverage before this). Mocks fetch and next/navigation; asserts the
 * happy path: bootstrap-status check resolves, the form submits the API
 * key to /dashboard/auth/login, and a successful response redirects.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import LoginPage from "../page.js";
import { I18nProvider } from "@/lib/i18n/client";

const replace = vi.fn();
const search = vi.hoisted(() => ({ value: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(search.value),
}));

describe("LoginPage", () => {
  beforeEach(() => {
    replace.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("submits the API key to /dashboard/auth/login and redirects on success", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/dashboard/bootstrap/status") {
        return new Response(JSON.stringify({ bootstrapped: true }), { status: 200 });
      }
      if (url === "/dashboard/auth/login") {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage />);

    // Wait for the bootstrap-status check to resolve so the button un-disables.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/dashboard/bootstrap/status", {
        signal: expect.any(AbortSignal),
      })
    );

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with API key" }));
    const input = screen.getByLabelText("API key");
    fireEvent.change(input, { target: { value: "mns_live_testkey123456789" } });

    const button = screen.getByRole("button", { name: "Sign in" });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/dashboard/auth/login",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ apiKey: "mns_live_testkey123456789" }),
        })
      )
    );

    await waitFor(() => expect(replace).toHaveBeenCalled());
  });

  it("shows an error message on an invalid key (401)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/dashboard/bootstrap/status") {
        return new Response(JSON.stringify({ bootstrapped: true }), { status: 200 });
      }
      return new Response(null, { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage />);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/dashboard/bootstrap/status", {
        signal: expect.any(AbortSignal),
      })
    );

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with API key" }));
    const input = screen.getByLabelText("API key");
    fireEvent.change(input, { target: { value: "bad-key" } });
    const button = screen.getByRole("button", { name: "Sign in" });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid api key/i);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("email login contract", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it("AUTH-11 submits email/password and selects a workspace before navigation", async () => {
    replace.mockClear();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("status")) return Response.json({ bootstrapped: true });
      if (url.endsWith("login"))
        return Response.json({
          requiresWorkspace: true,
          email: "test@example.test",
          workspaces: [
            { id: "w1", name: "Team", role: "owner" },
            { id: "w2", name: "Team", role: "read" },
          ],
        });
      return Response.json({ workspaceId: "w2" });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "a long test password" },
    });
    const submit = screen.getByRole("button", { name: "Sign in" });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    const select = await screen.findByLabelText("Workspace");
    // Focus moves in a post-render effect, so wait for it instead of racing it.
    await waitFor(() => expect(select).toHaveFocus());
    expect(screen.getByText("test@example.test")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Team — Owner (w1)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Team — Viewer (w2)" })).toBeInTheDocument();
    expect(screen.getByText(/within 5 minutes/)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/dashboard/auth/login",
      expect.objectContaining({
        body: JSON.stringify({ email: "test@example.test", password: "a long test password" }),
      })
    );
    fireEvent.change(select, { target: { value: "w2" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/dashboard/auth/workspace",
        expect.objectContaining({ body: JSON.stringify({ workspaceId: "w2" }) })
      )
    );
    await waitFor(() => expect(replace).toHaveBeenCalled());
  });
  it("AUTH-11 / APP-058 announces authentication errors once and ties them to the fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("status")
          ? Response.json({ bootstrapped: true })
          : Response.json({ error: "invalid_credentials" }, { status: 401 })
      )
    );
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "missing@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong password" } });
    const submit = screen.getByRole("button", { name: "Sign in" });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Invalid email or password");
    // role="alert" is the one live region; focus lands on the message (AUTH-02, as on the
    // other auth forms), so a keyboard user is where the error is.
    expect(alert).not.toHaveAttribute("aria-live");
    await waitFor(() => expect(alert).toHaveFocus());
    for (const field of [screen.getByLabelText("Email"), screen.getByLabelText("Password")]) {
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAttribute("aria-errormessage", alert.id);
    }
    expect(alert.id).not.toBe("");
  });
});

it("AUTH-15 explains failed workspace selection and allows signing in again", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("status")) return Response.json({ bootstrapped: true });
      if (url.endsWith("login"))
        return Response.json({
          requiresWorkspace: true,
          email: "test@example.test",
          workspaces: [{ id: "w1", name: "Team", role: "read" }],
        });
      return Response.json({}, { status: 401 });
    })
  );
  render(<LoginPage />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "long password" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Workspace selection expired or membership changed. Sign in again."
  );
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Password")).toHaveValue("");
  cleanup();
  vi.unstubAllGlobals();
});

it("AUTH-05 starts the workspace choice on the last workspace used", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/dashboard/bootstrap/status"
        ? new Response(JSON.stringify({ bootstrapped: true }), { status: 200 })
        : new Response(
            JSON.stringify({
              requiresWorkspace: true,
              email: "multi@example.test",
              workspaces: [
                { id: "w1", name: "First", role: "write" },
                { id: "w2", name: "Second", role: "owner" },
              ],
              preferredWorkspaceId: "w2",
            }),
            { status: 200 }
          )
    )
  );
  render(<LoginPage />);
  fireEvent.change(await screen.findByLabelText("Email"), {
    target: { value: "multi@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "a long test password" },
  });
  const submit = screen.getByRole("button", { name: /^Sign in$/ });
  await waitFor(() => expect(submit).not.toBeDisabled());
  fireEvent.click(submit);
  const select = (await screen.findByLabelText("Workspace")) as HTMLSelectElement;
  expect(select.value).toBe("w2");
  cleanup();
  vi.unstubAllGlobals();
});

it("shows the form and a 401 in Spanish", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("status")
        ? Response.json({ bootstrapped: true })
        : Response.json({ error: "invalid_credentials" }, { status: 401 })
    )
  );
  render(
    <I18nProvider locale="es-419">
      <LoginPage />
    </I18nProvider>
  );
  fireEvent.change(screen.getByLabelText("Correo"), { target: { value: "a@example.test" } });
  fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "wrong password" } });
  const submit = screen.getByRole("button", { name: "Iniciar sesión" });
  await waitFor(() => expect(submit).not.toBeDisabled());
  fireEvent.click(submit);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Correo o contraseña incorrectos. Inténtalo de nuevo."
  );
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  ["/dashboard/sessions/abc?tab=facts", "/sessions/abc?tab=facts"],
  ["/dashboard", "/"],
  ["/dashboardX/evil", "/"],
  ["/dashboard//evil.test", "/"],
])("APP-041 after the workspace choice it lands on next=%s (%s)", async (next, landing) => {
  replace.mockClear();
  search.value = `next=${encodeURIComponent(next)}`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("status")) return Response.json({ bootstrapped: true });
      if (url.endsWith("login"))
        return Response.json({
          requiresWorkspace: true,
          email: "a@b.test",
          workspaces: [{ id: "w1", name: "Team", role: "owner" }],
        });
      return Response.json({ workspaceId: "w1" });
    })
  );
  try {
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a long password" } });
    const submit = screen.getByRole("button", { name: "Sign in" });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(landing));
  } finally {
    search.value = "";
    cleanup();
    vi.unstubAllGlobals();
  }
});
