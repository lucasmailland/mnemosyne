/**
 * Public link page: one component test per state (accounts stage A).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import LinkPage from "../page";
import { I18nProvider } from "@/lib/i18n/client";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useParams: () => ({ token: "tok_abc" }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props} />
  ),
}));

type Info = { purpose: string; workspaceName: string | null; accountExists: boolean };
const info = (over: Partial<Info>): Info => ({
  purpose: "invite",
  workspaceName: "Acme",
  accountExists: false,
  ...over,
});

function stub(getInfo: Info | null, post?: Response) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST")
      return post ?? new Response(JSON.stringify({ ok: true, workspaceId: "w1" }), { status: 200 });
    return getInfo
      ? new Response(JSON.stringify({ ...getInfo, expiresAt: "2030-01-01T00:00:00.000Z" }))
      : new Response(JSON.stringify({ error: "link_invalid" }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => replace.mockClear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("link page", () => {
  it("invitation for a new account: focuses the first field and joins with a password", async () => {
    const fetchMock = stub(info({}));
    render(<LinkPage />);
    const name = await screen.findByLabelText(/Display name/);
    await waitFor(() => expect(name).toHaveFocus());
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "a long enough password" },
    });
    fireEvent.change(name, { target: { value: "Nora" } });
    fireEvent.click(screen.getByRole("button", { name: "Join Acme" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    // APP-043: reading the link gives up on a server that never answers.
    expect(fetchMock.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(post[0]).toBe("/dashboard/auth/link/tok_abc");
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      password: "a long enough password",
      displayName: "Nora",
    });
    expect(post[1]).toMatchObject({ referrerPolicy: "no-referrer" });
  });

  it("invitation for an existing account: accept, and a 401 asks to sign in with the invited email", async () => {
    stub(
      info({ accountExists: true }),
      new Response(JSON.stringify({ error: "session_required" }), { status: 401 })
    );
    render(<LinkPage />);
    const accept = await screen.findByRole("button", { name: "Join Acme" });
    await waitFor(() => expect(accept).toHaveFocus());
    expect(screen.queryByLabelText("Password")).toBeNull();
    fireEvent.click(accept);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Sign in with the invited email to accept this invitation.");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(alert.closest("form")).not.toBeNull();
    const signIn = screen.getByRole("link", { name: "Sign in with the invited email" });
    expect(signIn.getAttribute("href")).toBe(
      `/login?next=${encodeURIComponent("/dashboard/link/tok_abc")}`
    );
  });

  it("account setup asks for an optional name and a password", async () => {
    stub(info({ purpose: "account_setup", workspaceName: null }));
    render(<LinkPage />);
    const name = await screen.findByLabelText(/Display name/);
    await waitFor(() => expect(name).toHaveFocus());
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
  });

  it("password reset shows the policy error from the server in the form", async () => {
    stub(
      info({ purpose: "password_reset", accountExists: true }),
      new Response(JSON.stringify({ error: "password_policy", message: "Too short." }), {
        status: 400,
      })
    );
    render(<LinkPage />);
    fireEvent.change(await screen.findByLabelText("New password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Set new password" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Too short.");
    expect(alert.closest("form")).not.toBeNull();
  });

  it("an unknown or expired link shows the invalid state", async () => {
    stub(null);
    render(<LinkPage />);
    expect(
      await screen.findByText("This link is no longer valid. Ask for a new one.")
    ).toBeInTheDocument();
  });

  it("a link that dies between reading and submitting switches to the invalid state", async () => {
    stub(info({}), new Response("{}", { status: 404 }));
    render(<LinkPage />);
    fireEvent.change(await screen.findByLabelText("Password"), {
      target: { value: "a long enough password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join Acme" }));
    expect(
      await screen.findByText("This link is no longer valid. Ask for a new one.")
    ).toBeInTheDocument();
  });

  it("shows the invalid-link message in Spanish", async () => {
    stub(null);
    render(
      <I18nProvider locale="es-419">
        <LinkPage />
      </I18nProvider>
    );
    expect(
      await screen.findByText("Este enlace ya no es válido. Pide uno nuevo.")
    ).toBeInTheDocument();
  });
});
